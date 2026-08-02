#!/usr/bin/env bash
# Control script for Herdr Control. Invoked by the plugin's actions and usable directly.
# The bridge runs as a systemd user service on Linux or a launchd user agent on macOS (NOT a Herdr
# plugin pane — see ARCHITECTURE.md §3), so it survives Herdr restarts and is supervised independently.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="herdr-control"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT}.service"
LAUNCHD_LABEL="dev.herdr.control"
LAUNCHD_FILE="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
PLUGIN_ID="herdr.control"

# Resolve the plugin config dir (where .env lives) the SAME way no matter how we're launched.
# Herdr injects HERDR_PLUGIN_CONFIG_DIR when it runs our actions, but a direct `collie-ctl.sh` call
# doesn't get it — so we ask Herdr for the canonical path (`herdr plugin config-dir`, plain text).
# Without this, the two entry points read DIFFERENT .env files (Herdr's dir vs a ~/.config/herdr-control
# fallback), so a setting like COLLIE_SERVE_MODE applied one way and was silently ignored the other.
# Order: injected env → Herdr CLI → Herdr's conventional path (if it has a .env) → ~/.config/herdr-control.
resolve_config_dir() {
  if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then echo "$HERDR_PLUGIN_CONFIG_DIR"; return; fi
  if command -v herdr >/dev/null; then
    local d; d="$(herdr plugin config-dir "$PLUGIN_ID" 2>/dev/null || true)"
    if [ -n "$d" ]; then echo "$d"; return; fi
  fi
  local conventional="${HOME}/.config/herdr/plugins/config/${PLUGIN_ID}"
  if [ -f "${conventional}/.env" ]; then echo "$conventional"; return; fi
  echo "${HOME}/.config/herdr-control"
}
CONFIG_DIR="$(resolve_config_dir)"

# This directory holds the optional VAPID private key and other bridge credentials. Do not inherit
# a permissive umask (0755 dir / 0644 .env) on shared hosts.
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [ -f "${CONFIG_DIR}/.env" ]; then chmod 600 "${CONFIG_DIR}/.env"; fi

# First launch establishes one durable state directory; later direct/plugin invocations reuse it so
# subscriptions and preferences cannot jump between Herdr-injected and standalone defaults.
STATE_DIR_FILE="${CONFIG_DIR}/state-dir"
if [ -f "$STATE_DIR_FILE" ]; then
  IFS= read -r PLUGIN_STATE_DIR < "$STATE_DIR_FILE" || PLUGIN_STATE_DIR=""
else
  PLUGIN_STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-${CONFIG_DIR}/state}"
  printf '%s\n' "$PLUGIN_STATE_DIR" > "$STATE_DIR_FILE"
  chmod 600 "$STATE_DIR_FILE"
fi
[ -n "$PLUGIN_STATE_DIR" ] || PLUGIN_STATE_DIR="${CONFIG_DIR}/state"
export HERDR_PLUGIN_STATE_DIR="$PLUGIN_STATE_DIR"

# If a legacy Collie env exists, make the split explicit rather than silently sharing credentials.
if [ "$CONFIG_DIR" != "${HOME}/.config/collie" ] && [ -f "${HOME}/.config/collie/.env" ]; then
  echo "note: Collie's ${HOME}/.config/collie/.env is not reused; Herdr Control config lives in ${CONFIG_DIR}/.env." >&2
fi

# Source the plugin .env so both this script and the systemd unit share one config source.
if [ -f "${CONFIG_DIR}/.env" ]; then set -a; . "${CONFIG_DIR}/.env"; set +a; fi

normalize_port() {
  local raw="${1:-}" fallback="${2:-8787}" normalized
  raw="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$raw" in +*) raw="${raw#+}" ;; esac
  case "$raw" in
    ''|*[!0-9]*) echo "$fallback"; return ;;
  esac
  normalized="$(printf '%s\n' "$raw" | sed 's/^0*//')"
  [ -n "$normalized" ] || normalized="0"
  if [ "${#normalized}" -le 5 ] && [ "$normalized" -ge 1 ] && [ "$normalized" -le 65535 ]; then
    echo "$normalized"
  else
    echo "$fallback"
  fi
}

# Keep launcher, readiness probes, systemd, and Tailscale publishing on the same validated port as
# the bridge. Malformed and out-of-range environment values use the documented 8787 fallback.
PORT="$(normalize_port "${COLLIE_PORT:-8787}" 8787)"
export COLLIE_PORT="$PORT"
SOCKET="${HERDR_SOCKET_PATH:-${HOME}/.config/herdr/herdr.sock}"
# How tailscale serve exposes the bridge: "https" (default, needs a cert from the control
# server) or "http" (plain HTTP over the tailnet — use this on Headscale / .internal domains).
SERVE_MODE_RAW="$(printf '%s' "${COLLIE_SERVE_MODE:-https}" | tr '[:upper:]' '[:lower:]')"
if [ "$SERVE_MODE_RAW" = "http" ]; then SERVE_MODE="http"; else SERVE_MODE="https"; fi
# Use a dedicated public listener by default so Herdr Control does not replace an existing :443
# Serve mapping. Set 443 explicitly when this app should own the root MagicDNS URL.
SERVE_PORT="$(normalize_port "${COLLIE_SERVE_PORT:-$PORT}" "$PORT")"
BUN="$(command -v bun || true)"
TAILSCALE="$(command -v tailscale || true)"
if [ -z "$TAILSCALE" ] && [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  TAILSCALE="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
WEB_DIST="${PLUGIN_ROOT}/web/dist/index.html"

have_systemd() { command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; }
have_launchd() { [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null; }
launchd_domain() { printf 'gui/%s' "$(id -u)"; }

pid_is_bridge() {
  local pid="${1:-}" command
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"${PLUGIN_ROOT}/bridge/index.ts"* ]]
}

stop_bridge_pid() {
  local pid="${1:-}" i
  pid_is_bridge "$pid" || return 0
  kill "$pid" 2>/dev/null || return 1
  for i in $(seq 1 50); do
    pid_is_bridge "$pid" || return 0
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  for i in $(seq 1 10); do
    pid_is_bridge "$pid" || return 0
    sleep 0.1
  done
  return 1
}

systemd_escape_value() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\%/%%}"
  value="${value//\$/\$\$}"
  printf '%s' "$value"
}

plist_escape_value() {
  printf '%s' "${1:-}" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

# Build the Vite/React PWA into web/dist. The bridge serves that directory; without it the API
# still runs but the UI 503s. Safe to call repeatedly (no-op if already built, unless forced).
cmd_build() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  # Version gate: refuse to build a release whose version files / CHANGELOG disagree.
  # Override (e.g. mid-refactor) with SKIP_VERSION_CHECK=1.
  if [ "${SKIP_VERSION_CHECK:-}" != "1" ]; then
    bash "${PLUGIN_ROOT}/scripts/check-version.sh"
  fi
  # Install BOTH dependency trees before typechecking. The root typecheck (tsconfig `types: ["bun"]`)
  # resolves @types/bun from the ROOT node_modules; a fresh Herdr checkout ships neither tree, so
  # without a root install the very first build dies with TS2688 "Cannot find type definition file
  # for 'bun'" and Herdr rolls the install back (issue #9). It works on the dev host only because a
  # manual `bun install` left root node_modules behind.
  ( cd "${PLUGIN_ROOT}" && "$BUN" install )
  ( cd "${PLUGIN_ROOT}/web" && "$BUN" install )
  # Typecheck BOTH sides before building — the Vite build itself does not typecheck, so a type
  # error would otherwise ship silently. Skip with SKIP_TYPECHECK=1 (same hatch as the pre-push hook).
  if [ "${SKIP_TYPECHECK:-}" != "1" ]; then
    ( cd "${PLUGIN_ROOT}" && "$BUN" run typecheck )
    ( cd "${PLUGIN_ROOT}/web" && "$BUN" run typecheck )
  fi
  # Staged build + atomic swap. Vite empties its output dir first, so building straight into web/dist
  # would leave it EMPTY with no rollback if the build failed — and the bridge serves web/dist from
  # disk at request time. Build into web/dist-staging, then swap it in only on success. `set -e`
  # aborts the function before the swap on any build failure, so a live web/dist survives untouched.
  local staging="${PLUGIN_ROOT}/web/dist-staging"
  rm -rf "$staging"
  ( cd "${PLUGIN_ROOT}/web" && "$BUN" run build -- --outDir dist-staging --emptyOutDir )
  # Keep the last known-good bundle until staging is installed. If the final rename fails, restore
  # the backup so an interrupted update never destroys the currently served frontend.
  local dist="${PLUGIN_ROOT}/web/dist"
  local backup="${PLUGIN_ROOT}/web/dist-backup"
  rm -rf "$backup"
  if [ -e "$dist" ]; then mv "$dist" "$backup"; fi
  if mv "$staging" "$dist"; then
    rm -rf "$backup"
  else
    [ ! -e "$backup" ] || mv "$backup" "$dist"
    return 1
  fi
}

ensure_build() {
  [ -f "$WEB_DIST" ] && return 0
  [ -n "$BUN" ] || { echo "note: bun not found; cannot build web UI" >&2; return 1; }
  echo "building web UI (first run)…"
  cmd_build || { echo "warn: web build failed; API will run but the UI will 503 until built" >&2; return 1; }
}

self_dnsname() {
  [ -n "$TAILSCALE" ] && [ -n "$BUN" ] || return 0
  "$TAILSCALE" status --json 2>/dev/null | "$BUN" -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).Self.DNSName.replace(/\.$/,''))}catch{}})"
}

bridge_url() {
  local name; name="$(self_dnsname)"
  if [ -z "$name" ]; then echo "http://127.0.0.1:${PORT} (Tailscale name unavailable)"; return; fi
  if [ "$SERVE_MODE" = "http" ]; then
    if [ "$SERVE_PORT" = "80" ]; then echo "http://${name}"; else echo "http://${name}:${SERVE_PORT}"; fi
  else
    if [ "$SERVE_PORT" = "443" ]; then echo "https://${name}"; else echo "https://${name}:${SERVE_PORT}"; fi
  fi
}

resolved_public_hosts() {
  if [ -n "${COLLIE_PUBLIC_HOSTS:-}" ]; then echo "$COLLIE_PUBLIC_HOSTS"; return; fi
  local name; name="$(self_dnsname)"
  if [ -z "$name" ]; then return; fi
  if { [ "$SERVE_MODE" = "http" ] && [ "$SERVE_PORT" = "80" ]; } ||
     { [ "$SERVE_MODE" != "http" ] && [ "$SERVE_PORT" = "443" ]; }; then
    echo "$name"
  else
    echo "${name}:${SERVE_PORT}"
  fi
}

# The version Herdr Control is actually serving — read from the built bundle's stamp
# (web/dist/build-info.json, the same id the PWA footer and /api/config report), e.g. "0.16.0+3441656".
# Falls back to the manifest version (tagged "web not built") when web/dist doesn't exist yet. This is
# the authoritative "what's running", unlike Herdr's registry value which is cached at link time.
collie_version() {
  local bi="${PLUGIN_ROOT}/web/dist/build-info.json" v sha
  if [ -f "$bi" ]; then
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$bi" | head -1)"
    sha="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$bi" | head -1)"
    if [ -n "$v" ]; then [ -n "$sha" ] && echo "${v}+${sha}" || echo "$v"; return; fi
  fi
  v="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${PLUGIN_ROOT}/herdr-plugin.toml" | head -1)"
  [ -n "$v" ] && echo "${v} (manifest; web not built)" || echo "unknown"
}

bridge_probe_once() {
  [ -n "$BUN" ] || return 1
  # Stock macOS Bash 3.2 rejects fractional `read -t` values, so use the Bun runtime already
  # required to launch the bridge. Fetch resolves at the response headers; the abort keeps a
  # foreign/stalled listener from stretching the outer ~5-second readiness window.
  "$BUN" -e '
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try {
      const response = await fetch(`http://127.0.0.1:${process.argv[1]}/api/config`, {
        signal: controller.signal,
      });
      process.exit(
        response.status === 200 && response.headers.get("x-herdr-control") === "herdr-control-v1"
          ? 0
          : 1,
      );
    } catch {
      process.exit(1);
    } finally {
      clearTimeout(timer);
    }
  ' "$PORT"
}

# True only once this bridge answers a bridge-specific HTTP probe, not merely when any process owns
# the port. Poll for up to ~5s to cover a just-launched service still binding.
bridge_ready() {
  local i
  for i in $(seq 1 25); do
    bridge_probe_once && return 0
    sleep 0.2
  done
  return 1
}

# One scannable status summary — readiness, how it is supervised, and both URLs. Shared by
# `start` (post-launch confirmation) and `status` (on demand) so the two always agree.
print_status_banner() {
  local svc
  if have_systemd; then
    svc="systemd --user (${UNIT}) · $(systemctl --user is-active "$UNIT" 2>/dev/null || echo unknown)"
  elif have_launchd && launchctl print "$(launchd_domain)/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
    svc="launchd user agent (${LAUNCHD_LABEL}) · loaded"
  elif [ -f "${CONFIG_DIR}/herdr-control.pid" ]; then
    svc="pid $(cat "${CONFIG_DIR}/herdr-control.pid" 2>/dev/null) (no systemd)"
  else
    svc="not supervised"
  fi
  local ver; ver="$(collie_version)"
  echo
  if bridge_ready; then
    echo "  ✓ Herdr Control is running  ·  v${ver}"
  else
    echo "  ⚠ Herdr Control isn't answering on :${PORT} yet (v${ver}) — check 'collie-ctl.sh logs'"
  fi
  echo "    service   ${svc}"
  echo "    local     http://127.0.0.1:${PORT}"
  echo "    tailnet   $(bridge_url)"
  echo
}

write_launchd_agent() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$LAUNCHD_FILE")" "$CONFIG_DIR"
  local root_escaped wrapper_escaped bun_escaped socket_escaped config_escaped state_escaped
  local hosts_escaped log_escaped
  root_escaped="$(plist_escape_value "$PLUGIN_ROOT")"
  wrapper_escaped="$(plist_escape_value "${PLUGIN_ROOT}/scripts/launch-bridge.sh")"
  bun_escaped="$(plist_escape_value "$BUN")"
  socket_escaped="$(plist_escape_value "$SOCKET")"
  config_escaped="$(plist_escape_value "$CONFIG_DIR")"
  state_escaped="$(plist_escape_value "$PLUGIN_STATE_DIR")"
  hosts_escaped="$(plist_escape_value "$(resolved_public_hosts)")"
  log_escaped="$(plist_escape_value "${CONFIG_DIR}/herdr-control.log")"
  cat > "$LAUNCHD_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${wrapper_escaped}</string></array>
  <key>WorkingDirectory</key><string>${root_escaped}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HERDR_CONTROL_BUN</key><string>${bun_escaped}</string>
    <key>HERDR_CONTROL_SOCKET_PATH</key><string>${socket_escaped}</string>
    <key>HERDR_CONTROL_EFFECTIVE_PORT</key><string>${PORT}</string>
    <key>HERDR_CONTROL_PUBLIC_HOSTS</key><string>${hosts_escaped}</string>
    <key>HERDR_PLUGIN_CONFIG_DIR</key><string>${config_escaped}</string>
    <key>HERDR_PLUGIN_STATE_DIR</key><string>${state_escaped}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${log_escaped}</string>
  <key>StandardErrorPath</key><string>${log_escaped}</string>
</dict>
</plist>
EOF
  chmod 600 "$LAUNCHD_FILE"
}

write_unit() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  mkdir -p "$(dirname "$UNIT_FILE")" "$CONFIG_DIR"
  local public_hosts public_hosts_escaped bun_escaped root_escaped socket_escaped config_escaped state_environment=""
  public_hosts="$(resolved_public_hosts)"
  public_hosts_escaped="$(systemd_escape_value "$public_hosts")"
  bun_escaped="$(systemd_escape_value "$BUN")"
  root_escaped="$(systemd_escape_value "$PLUGIN_ROOT")"
  socket_escaped="$(systemd_escape_value "$SOCKET")"
  config_escaped="$(systemd_escape_value "$CONFIG_DIR")"
  if [ -n "$PLUGIN_STATE_DIR" ]; then
    state_environment="Environment=\"HERDR_PLUGIN_STATE_DIR=$(systemd_escape_value "$PLUGIN_STATE_DIR")\""
  fi
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Herdr Control
After=default.target
# Never give up restarting — a phone-only operator can't run 'systemctl reset-failed'.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory="${root_escaped}"
ExecStart="${bun_escaped}" run "${root_escaped}/bridge/index.ts"
Restart=on-failure
RestartSec=5
# Hardening: the bridge is remote shell access, so deny privilege escalation and give it a private
# /tmp. ProtectSystem is intentionally NOT set — the only write path is the env-driven state dir,
# which Herdr may inject to an arbitrary location, so it can't be enumerated in a static ReadWritePaths.
NoNewPrivileges=yes
PrivateTmp=yes
Environment="HERDR_SOCKET_PATH=${socket_escaped}"
Environment=COLLIE_PORT=${PORT}
Environment=HERDR_CONTROL_EFFECTIVE_PORT=${PORT}
Environment="COLLIE_PUBLIC_HOSTS=${public_hosts_escaped}"
Environment="HERDR_CONTROL_EFFECTIVE_PUBLIC_HOSTS=${public_hosts_escaped}"
Environment="HERDR_PLUGIN_CONFIG_DIR=${config_escaped}"
${state_environment}
EnvironmentFile="-${config_escaped}/.env"

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

cmd_start() {
  ensure_build || true
  if have_systemd; then
    write_unit
    systemctl --user enable --now "$UNIT"
    echo "bridge started (systemd --user: ${UNIT})"
  elif have_launchd; then
    write_launchd_agent
    local domain; domain="$(launchd_domain)"
    launchctl bootout "${domain}/${LAUNCHD_LABEL}" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$LAUNCHD_FILE"
    echo "bridge started (launchd user agent: ${LAUNCHD_LABEL})"
  else
    # Last-resort fallback for platforms with neither systemd user services nor launchd.
    mkdir -p "$CONFIG_DIR"
    [ -n "$BUN" ] || { echo "error: bun not found" >&2; exit 1; }
    local pidfile="${CONFIG_DIR}/herdr-control.pid" existing_pid=""
    if [ -f "$pidfile" ]; then existing_pid="$(cat "$pidfile" 2>/dev/null || true)"; fi
    if pid_is_bridge "$existing_pid"; then
      echo "bridge already running (pid ${existing_pid}, no systemd)"
    else
      if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
        echo "error: pidfile points to a different live process (${existing_pid}); refusing to overwrite it" >&2
        exit 1
      fi
      rm -f "$pidfile"
      HERDR_SOCKET_PATH="$SOCKET" COLLIE_PORT="$PORT" COLLIE_PUBLIC_HOSTS="$(resolved_public_hosts)" HERDR_PLUGIN_CONFIG_DIR="$CONFIG_DIR" \
        nohup "$BUN" run "${PLUGIN_ROOT}/bridge/index.ts" >>"${CONFIG_DIR}/herdr-control.log" 2>&1 &
      local new_pid=$!
      sleep 0.2
      if ! pid_is_bridge "$new_pid"; then
        echo "error: bridge failed to stay running; see ${CONFIG_DIR}/herdr-control.log" >&2
        exit 1
      fi
      printf '%s\n' "$new_pid" > "$pidfile"
      echo "bridge started (pid ${new_pid}, no systemd)"
    fi
  fi
  if ! bridge_ready; then
    echo "error: Herdr Control did not pass its HTTP readiness probe; refusing to publish :${PORT} through Tailscale" >&2
    return 1
  fi
  cmd_serve
  print_status_banner
}

cmd_stop() {
  if have_systemd; then
    if ! systemctl --user disable --now "$UNIT" 2>/dev/null; then
      if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
        echo "error: systemd could not stop ${UNIT}; refusing to continue" >&2
        return 1
      fi
    fi
    if systemctl --user is-active --quiet "$UNIT" 2>/dev/null; then
      echo "error: ${UNIT} is still active after stop" >&2
      return 1
    fi
  elif have_launchd; then
    local domain; domain="$(launchd_domain)"
    if launchctl print "${domain}/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
      launchctl bootout "${domain}/${LAUNCHD_LABEL}"
    fi
    # Leaving a RunAtLoad plist behind would silently restart this remote-access service at login.
    # `start` always regenerates it, so removal is the durable launchd equivalent of systemd disable.
    rm -f "$LAUNCHD_FILE"
  elif [ -f "${CONFIG_DIR}/herdr-control.pid" ]; then
    local pid; pid="$(cat "${CONFIG_DIR}/herdr-control.pid" 2>/dev/null || true)"
    if pid_is_bridge "$pid"; then
      if ! stop_bridge_pid "$pid"; then
        echo "error: bridge process ${pid} did not exit; keeping pidfile" >&2
        return 1
      fi
    elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "warning: pidfile points to a different live process (${pid}); not killing it" >&2
    fi
    rm -f "${CONFIG_DIR}/herdr-control.pid"
  fi
  echo "bridge stopped"
}

cmd_restart() { cmd_stop; cmd_start; }

# Tear the service down completely (the inverse of `start`): stop + disable it, remove the
# systemd/launchd user service, remove Herdr Control's tailscale serve mapping, and drop the pidfile. Deliberately leaves your
# config (${CONFIG_DIR}/.env) and the on-disk checkout in place — `uninstall` removes only what
# `start` created. To remove the plugin registration too, run `herdr plugin uninstall herdr.control`
# (or, for a linked clone, just delete the checkout).
cmd_uninstall() {
  cmd_stop
  cmd_unserve
  if have_systemd; then
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed "$UNIT" 2>/dev/null || true
  fi
  if have_launchd; then rm -f "$LAUNCHD_FILE"; fi
  rm -f "${CONFIG_DIR}/herdr-control.pid"
  echo "✓ uninstalled: service stopped & disabled, service definition removed, Herdr Control's tailscale serve mapping removed"
  echo "  kept: ${CONFIG_DIR}/.env and the checkout — delete those to remove every trace"
}

managed_reinstall_command() {
  [ -n "$BUN" ] && command -v herdr >/dev/null || return 0
  herdr plugin list --plugin "$PLUGIN_ID" --json 2>/dev/null | "$BUN" -e "$(
    cat <<'BUN_SCRIPT'
    let raw = "";
    process.stdin.on("data", (chunk) => raw += chunk).on("end", () => {
      try {
        const envelope = JSON.parse(raw);
        const plugin = envelope?.result?.plugins?.find((entry) => entry.plugin_id === "herdr.control");
        const source = plugin?.source;
        if (!source?.owner || !source?.repo) return;
        const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
        const locator = [source.owner, source.repo, source.subdir].filter(Boolean).join("/");
        const ref = source.requested_ref ? ` --ref ${quote(source.requested_ref)}` : "";
        process.stdout.write(`herdr plugin install ${quote(locator)}${ref} --yes`);
      } catch {}
    });
BUN_SCRIPT
  )"
}

# Update a linked checkout in place. Herdr-managed installs are detached/pinned and get explicit
# reinstall instructions instead. The pull can rewrite THIS script, and bash reads scripts by byte
# offset, so we re-exec the freshly-pulled copy to run build + restart.
cmd_update() {
  if ! git -C "$PLUGIN_ROOT" symbolic-ref --quiet --short HEAD >/dev/null; then
    local reinstall; reinstall="$(managed_reinstall_command)"
    [ -n "$reinstall" ] || reinstall="herdr plugin install <owner>/<repo>[/subdir] --yes"
    echo "error: this is a Herdr-managed checkout pinned at a detached commit; it cannot safely self-update with git pull." >&2
    echo "reinstall it from the same managed source:" >&2
    echo "  herdr plugin uninstall ${PLUGIN_ID}" >&2
    echo "  ${reinstall}" >&2
    return 1
  fi
  echo "updating Herdr Control (git pull --ff-only)…"
  git -C "$PLUGIN_ROOT" pull --ff-only
  exec bash "${PLUGIN_ROOT}/scripts/collie-ctl.sh" _apply-update
}

# After an update, Herdr's plugin registry still has the action set + version CACHED from the last
# `plugin link` — so a newly added action (e.g. `version`) returns `plugin_action_not_found`, and
# `herdr plugin list` shows the old version, until a re-link. Re-link here so `update` self-heals it.
# Best-effort: never fails the update (Herdr may be down, or this may be a non-link install) — it just
# prints how to do it by hand.
refresh_registry() {
  command -v herdr >/dev/null || return 0
  if herdr plugin link "$PLUGIN_ROOT" >/dev/null 2>&1; then
    echo "herdr registry refreshed (re-linked) — new actions are invokable now"
  else
    echo "note: couldn't refresh the Herdr registry (is the Herdr server running?) —"
    echo "      run: herdr plugin link \"$PLUGIN_ROOT\""
  fi
}

# Second half of `update`, run from the just-pulled script. cmd_build re-runs the version gate (a
# half-bumped release can't go live) and rebuilds web/dist; cmd_restart picks up any bridge/ changes;
# refresh_registry re-links so Herdr learns any newly added actions / the new version.
cmd_apply_update() {
  cmd_build
  cmd_restart
  refresh_registry
  echo "✓ update complete"
}

SERVE_LISTENER_FILE="${CONFIG_DIR}/serve-listener"
SERVE_EXTRA_LISTENER_FILE="${CONFIG_DIR}/serve-listener-extra"

# Track the exact listener recorded after the last successful `serve`. The record is deliberately
# separate from .env: users commonly change mode/port before restart or uninstall, and the new config
# can no longer identify the old listener. Older installs without a record fall back to current config.
remove_serve_listener() {
  local mode="${1:-}" port="${2:-}"
  case "$mode" in
    http|https) ;;
    *) return 1 ;;
  esac
  case "$port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  "$TAILSCALE" serve "--${mode}=${port}" off >/dev/null 2>&1
}

serve_listener_matches() {
  local mode="${1:-}" port="${2:-}" target="${3:-}" status_file="${CONFIG_DIR}/serve-status.json"
  [ -n "$BUN" ] || return 2
  if ! "$TAILSCALE" serve status --json > "$status_file" 2>/dev/null; then return 2; fi
  SERVE_CHECK_MODE="$mode" SERVE_CHECK_PORT="$port" SERVE_CHECK_TARGET="$target" \
    "$BUN" -e '
      let raw="";
      process.stdin.on("data", c => raw += c).on("end", () => {
        try {
          const data = JSON.parse(raw);
          const port = process.env.SERVE_CHECK_PORT;
          const target = process.env.SERVE_CHECK_TARGET;
          const mode = process.env.SERVE_CHECK_MODE;
          const tcp = data.TCP?.[port];
          if (tcp && ((mode === "https" && tcp.HTTPS !== true) || (mode === "http" && tcp.HTTPS === true))) process.exit(1);
          const entries = Object.entries(data.Web ?? {}).filter(([key]) => key === port || key.endsWith(`:${port}`));
          const containsTarget = value => {
            if (typeof value === "string") {
              try {
                const url = new URL(value);
                return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === target;
              } catch { return false; }
            }
            if (Array.isArray(value)) return value.some(containsTarget);
            return value && typeof value === "object" && Object.values(value).some(containsTarget);
          };
          if (entries.length !== 1) process.exit(1);
          const value = entries[0][1];
          const handlers = value && typeof value === "object" && !Array.isArray(value) ? value.Handlers : null;
          if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) process.exit(1);
          const paths = Object.keys(handlers);
          process.exit(paths.length === 1 && paths[0] === "/" && containsTarget(handlers["/"]) ? 0 : 1);
        } catch { process.exit(2); }
      });' < "$status_file"
}

# 0 = destination has no listener, 1 = occupied, 2 = status could not be verified.
serve_listener_available() {
  local port="${1:-}" status_file="${CONFIG_DIR}/serve-status.json"
  [ -n "$BUN" ] || return 2
  if ! "$TAILSCALE" serve status --json > "$status_file" 2>/dev/null; then return 2; fi
  SERVE_CHECK_PORT="$port" "$BUN" -e '
    let raw="";
    process.stdin.on("data", c => raw += c).on("end", () => {
      try {
        const data = JSON.parse(raw);
        const port = process.env.SERVE_CHECK_PORT;
        const tcp = data.TCP?.[port];
        const web = Object.keys(data.Web ?? {}).some(key => key === port || key.endsWith(`:${port}`));
        process.exit(tcp || web ? 1 : 0);
      } catch { process.exit(2); }
    });' < "$status_file"
}

# 0 = removed, 3 = record no longer owns this listener, 1 = verification/removal failure.
remove_owned_listener() {
  local mode="${1:-}" port="${2:-}" target="${3:-}" match_status=0
  serve_listener_matches "$mode" "$port" "$target" || match_status=$?
  if [ "$match_status" = "1" ]; then return 3; fi
  [ "$match_status" = "0" ] || return 1
  remove_serve_listener "$mode" "$port"
}

remove_listener_record() {
  local record_file="${1:-}" mode="" port="" target=""
  [ -f "$record_file" ] || return 0
  IFS=' ' read -r mode port target < "$record_file" || true
  local removal_status=0
  remove_owned_listener "$mode" "$port" "$target" || removal_status=$?
  if [ "$removal_status" = "3" ]; then
    echo "tailscale serve: recorded :${port} mapping is no longer owned by Herdr Control; leaving it untouched"
    rm -f "$record_file"
    return 0
  fi
  if [ "$removal_status" = "0" ]; then
    echo "tailscale serve: removed Herdr Control's recorded ${mode} :${port} mapping"
    rm -f "$record_file"
    return 0
  fi
  echo "warning: could not remove recorded Herdr Control serve mapping; keeping its record for retry" >&2
  return 1
}

remove_recorded_serve_listener() {
  local mode="" port="" target=""
  if [ -f "$SERVE_LISTENER_FILE" ]; then
    remove_listener_record "$SERVE_LISTENER_FILE"
    return 1
  fi
  return 0
}

cmd_serve() {
  [ -n "$TAILSCALE" ] || { echo "note: tailscale not found; bridge is on 127.0.0.1:${PORT} only"; return; }
  local out="${CONFIG_DIR}/serve.out" old_mode="" old_port="" old_target="" installed=0 removed_for_swap=0 destination_owned=0
  if [ -f "$SERVE_LISTENER_FILE" ]; then
    IFS=' ' read -r old_mode old_port old_target < "$SERVE_LISTENER_FILE" || true
  fi
  # Recover any route whose install completed before the final ownership record was committed.
  if [ -f "$SERVE_EXTRA_LISTENER_FILE" ] && ! remove_listener_record "$SERVE_EXTRA_LISTENER_FILE"; then
    echo "error: an earlier pending Serve mapping could not be reconciled; refusing to lose ownership" >&2
    return 1
  fi
  # A recorded same-mode/same-port route is still external mutable state: another application may
  # have replaced its backend since our last successful install. Verify the record before issuing a
  # `tailscale serve` command that would otherwise silently overwrite the current owner.
  if [ "$old_mode" = "$SERVE_MODE" ] && [ "$old_port" = "$SERVE_PORT" ]; then
    local reuse_status=0
    serve_listener_matches "$old_mode" "$old_port" "$old_target" || reuse_status=$?
    if [ "$reuse_status" = "1" ]; then
      local stale_destination_status=0
      serve_listener_available "$old_port" || stale_destination_status=$?
      if [ "$stale_destination_status" = "0" ]; then
        echo "tailscale serve: recorded :${old_port} listener disappeared; reinstalling"
        rm -f "$SERVE_LISTENER_FILE"
        reuse_status=0
      elif [ "$stale_destination_status" = "1" ]; then
        echo "error: recorded :${old_port} listener now belongs to another app; refusing replacement" >&2
        rm -f "$SERVE_LISTENER_FILE"
        return 1
      else
        echo "error: could not verify ownership of recorded :${old_port} listener; refusing replacement" >&2
        return 1
      fi
    fi
    if [ "$reuse_status" != "0" ]; then
      echo "error: could not verify ownership of recorded :${old_port} listener; refusing replacement" >&2
      return 1
    fi
    destination_owned=1
  fi
  # HTTP and HTTPS cannot share one TCP port. For that one transition, remove the old listener first,
  # then restore its recorded backend if replacement fails. Other changes install before removal.
  if [ "$old_port" = "$SERVE_PORT" ] && [ -n "$old_mode" ] && [ "$old_mode" != "$SERVE_MODE" ]; then
    local swap_status=0
    remove_owned_listener "$old_mode" "$old_port" "$old_target" || swap_status=$?
    if [ "$swap_status" = "0" ]; then
      removed_for_swap=1
    elif [ "$swap_status" = "3" ]; then
      local stale_swap_status=0
      serve_listener_available "$old_port" || stale_swap_status=$?
      if [ "$stale_swap_status" = "0" ]; then
        echo "tailscale serve: recorded :${old_port} listener disappeared; installing ${SERVE_MODE}"
        rm -f "$SERVE_LISTENER_FILE"
        old_mode=""; old_port=""; old_target=""
      elif [ "$stale_swap_status" = "1" ]; then
        echo "error: recorded :${old_port} listener now belongs to another app; refusing protocol replacement" >&2
        rm -f "$SERVE_LISTENER_FILE"
        return 1
      else
        echo "error: could not verify ownership of recorded :${old_port} listener; refusing protocol replacement" >&2
        return 1
      fi
    else
      echo "error: existing :${old_port} listener is not verifiably owned by Herdr Control; refusing protocol replacement" >&2
      return 1
    fi
  fi
  if [ "$destination_owned" != "1" ] && [ "$removed_for_swap" != "1" ]; then
    local destination_status=0
    serve_listener_available "$SERVE_PORT" || destination_status=$?
    if [ "$destination_status" = "1" ]; then
      echo "error: :${SERVE_PORT} already has an unowned Tailscale Serve listener; refusing replacement" >&2
      return 1
    fi
    if [ "$destination_status" != "0" ]; then
      echo "error: could not verify that :${SERVE_PORT} is available; refusing replacement" >&2
      return 1
    fi
  fi
  if [ "$SERVE_MODE" = "http" ]; then
    printf '%s %s %s\n' "$SERVE_MODE" "$SERVE_PORT" "$PORT" > "$SERVE_EXTRA_LISTENER_FILE"
    chmod 600 "$SERVE_EXTRA_LISTENER_FILE"
    if "$TAILSCALE" serve --bg --http="$SERVE_PORT" "$PORT" >"$out" 2>&1; then
      installed=1
      echo "tailscale serve (http) → tailnet :${SERVE_PORT} -> 127.0.0.1:${PORT}"
    else
      echo "note: tailscale serve failed (try 'sudo tailscale set --operator=\$USER'):"; cat "$out"
    fi
  else
    printf '%s %s %s\n' "$SERVE_MODE" "$SERVE_PORT" "$PORT" > "$SERVE_EXTRA_LISTENER_FILE"
    chmod 600 "$SERVE_EXTRA_LISTENER_FILE"
    if "$TAILSCALE" serve --bg --https="$SERVE_PORT" "$PORT" >"$out" 2>&1; then
      installed=1
      echo "tailscale serve (https) → tailnet :${SERVE_PORT} -> 127.0.0.1:${PORT}"
    else
      echo "note: tailscale serve (https) failed — on Headscale/.internal domains use COLLIE_SERVE_MODE=http:"; cat "$out"
    fi
  fi
  if [ "$installed" != "1" ]; then
    if [ "$removed_for_swap" = "1" ]; then
      case "$old_target" in ''|*[!0-9]*) old_target="$PORT" ;; esac
      if "$TAILSCALE" serve --bg "--${old_mode}=${old_port}" "$old_target" >/dev/null 2>&1; then
        echo "tailscale serve: restored previous ${old_mode} :${old_port} mapping after replacement failed"
      else
        echo "warning: failed to restore previous Herdr Control serve mapping" >&2
      fi
    fi
    return 1
  fi

  # Except for the same-port protocol swap handled (and rolled back) above, the new route is live
  # before the prior one is touched. Only a genuinely different old port needs follow-up removal.
  if [ -n "$old_mode" ] && [ "$old_port" != "$SERVE_PORT" ]; then
    local old_removal_status=0
    remove_owned_listener "$old_mode" "$old_port" "$old_target" || old_removal_status=$?
    if [ "$old_removal_status" = "0" ]; then
      echo "tailscale serve: removed Herdr Control's previous ${old_mode} :${old_port} mapping"
    elif [ "$old_removal_status" = "3" ]; then
      echo "tailscale serve: previous :${old_port} mapping now belongs to another app; leaving it untouched"
    else
      echo "warning: new serve mapping is live, but the previous mapping could not be removed; keeping its record for retry" >&2
      # Roll the just-created route back so the ownership file remains complete. If even rollback
      # fails, persist a second explicit record; uninstall will retry both and never infer ownership.
      if ! remove_serve_listener "$SERVE_MODE" "$SERVE_PORT"; then
        printf '%s %s %s\n' "$SERVE_MODE" "$SERVE_PORT" "$PORT" > "$SERVE_EXTRA_LISTENER_FILE"
        chmod 600 "$SERVE_EXTRA_LISTENER_FILE"
      else
        rm -f "$SERVE_EXTRA_LISTENER_FILE"
      fi
      return 1
    fi
  fi
  printf '%s %s %s\n' "$SERVE_MODE" "$SERVE_PORT" "$PORT" > "$SERVE_LISTENER_FILE"
  chmod 600 "$SERVE_LISTENER_FILE"
  rm -f "$SERVE_EXTRA_LISTENER_FILE"
}

# Remove ONLY Herdr Control's tailscale serve mapping — the inverse of cmd_serve, NOT a blanket
# `tailscale serve reset` (which would wipe every unrelated mapping on the host). We turn off
# exactly the listener cmd_serve recorded after its last successful setup. Best-effort teardown stays
# idempotent when the mapping is already gone.
cmd_unserve() {
  [ -n "$TAILSCALE" ] || { echo "note: tailscale not found; no serve mapping to remove"; return; }
  local removed=1
  if [ ! -f "$SERVE_LISTENER_FILE" ] && [ ! -f "$SERVE_EXTRA_LISTENER_FILE" ]; then
    # Legacy installs predate ownership records. Remove only when the current configured listener
    # can still be verified as this bridge's exact root mapping; never infer ownership from a port.
    local legacy_status=0
    remove_owned_listener "$SERVE_MODE" "$SERVE_PORT" "$PORT" || legacy_status=$?
    if [ "$legacy_status" = "0" ]; then
      echo "tailscale serve: removed verified legacy ${SERVE_MODE} :${SERVE_PORT} mapping"
    elif [ "$legacy_status" = "3" ]; then
      echo "tailscale serve: no owned legacy mapping found; leaving current listener untouched"
    else
      removed=0
    fi
  else
    remove_listener_record "$SERVE_LISTENER_FILE" || removed=0
    remove_listener_record "$SERVE_EXTRA_LISTENER_FILE" || removed=0
  fi
  if [ "$removed" = "1" ]; then
    echo "tailscale serve: Herdr Control mapping removed"
  else
    echo "warning: one or more Herdr Control serve mappings remain; retry 'unserve'" >&2
    return 1
  fi
}

cmd_status() {
  print_status_banner
  echo "  serve config:"
  if [ -n "$TAILSCALE" ]; then "$TAILSCALE" serve status 2>/dev/null | sed 's/^/    /' || true; fi
}

cmd_logs() {
  if have_systemd; then journalctl --user -u "$UNIT" -n "${1:-50}" --no-pager
  else tail -n "${1:-50}" "${CONFIG_DIR}/herdr-control.log" 2>/dev/null || echo "(no log)"; fi
}

cmd_version() { collie_version; }

# Fire a one-off Web Push to every subscribed device — verify push end-to-end without waiting for an
# agent to actually block. The helper calls the running bridge so subscription persistence keeps one
# process owner. Args: [title] [body] [paneId].
cmd_push_test() {
  [ -n "$BUN" ] || { echo "error: bun not found on PATH" >&2; exit 1; }
  "$BUN" run "${PLUGIN_ROOT}/scripts/push-test.ts" "$@"
}

main() {
  case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    uninstall) cmd_uninstall ;;
    update)  cmd_update ;;
    _apply-update) cmd_apply_update ;;  # internal: second half of `update`, run post-pull
    build)   cmd_build ;;
    serve)   cmd_serve; echo "open: $(bridge_url)" ;;
    unserve) cmd_unserve ;;
    status)  cmd_status ;;
    url)     bridge_url ;;
    version) cmd_version ;;
    push-test) shift || true; cmd_push_test "$@" ;;
    logs)    cmd_logs "${2:-50}" ;;
    *) echo "usage: collie-ctl.sh {start|stop|restart|uninstall|update|version|push-test|build|serve|unserve|status|url|logs}" >&2; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
