# Herdr Web

Herdr Web is the host-side companion for remote Herdr clients. It runs beside Herdr,
translates a bounded HTTP and WebSocket API into Herdr socket operations, and can publish that API
privately through Tailscale Serve.

Native client repository: [Herdr Mobile](https://github.com/benkraus/herdr-mobile).

The repository is packaged as a Herdr plugin. Its registered plugin ID is `herdr.control`, retained
for compatibility with existing installations and configuration directories.

## What it provides

- A responsive browser control surface, optionally served by the bridge itself.
- A native-client API used by the separate
  [Herdr Mobile](https://github.com/benkraus/herdr-mobile) application.
- Live terminal frames with device-sized terminal control.
- Workspace, worktree, tab, pane, and multi-session navigation.
- Persisted device receivers, so one installed PWA can switch between host-local bridges.
- Bounded workspace file previews and read-only Git status/diff inspection.
- Authorized terminal input and structural mutations.
- Optional Web Push notifications for agent state changes.
- Append-only auditing of remote write operations.
- launchd supervision on macOS and systemd user-service supervision on Linux.
- Private tailnet publishing through Tailscale Serve.

Herdr remains the source of truth. Closing a browser or mobile client does not terminate the Herdr
server, its workspaces, terminal panes, or agents.

## Architecture

```text
browser or native mobile app
          |
          | HTTPS REST + session-scoped WebSocket
          v
Tailscale Serve (tailnet-only reverse proxy)
          |
          | loopback HTTP
          v
Herdr Web bridge (Bun, 127.0.0.1:8787 by default)
          |
          | Herdr RPC over Unix socket
          v
Herdr server -> workspaces -> tabs -> panes -> agents
```

Tailscale normally establishes a direct peer-to-peer WireGuard path. It may transparently use a
DERP relay when a direct path cannot be established; this application does not operate a central
Internet relay of its own.

The relay uses REST for snapshots, bounded workspace/file/Git reads, and mutations. Workspace
inspection resolves roots from Herdr's authoritative workspace state, rejects path traversal and
symlink reads, and caps file and Git output sizes. A WebSocket carries structural change
notifications and native terminal frames. The selected terminal is driven at the client’s measured
columns and rows, which lets smaller devices navigate a live TUI instead of viewing a desktop-width
text dump.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for ownership and protocol boundaries.

## Deployment modes

The bridge and PWA are independently runnable. The default remains an all-in-one deployment for a
single-command install.

| Mode | What runs here | Configuration |
| --- | --- | --- |
| Combined | Bridge plus its bundled `web/dist` | Default |
| Bridge only | Host-local API for native or separately hosted clients | `COLLIE_SERVE_PWA=off` |
| PWA only | Static browser bundle pointed at a bridge elsewhere | `VITE_HERDR_BRIDGE_URL` at build time |

### Source-run CLI contract

Keep the source-run commands simple:

```bash
bun run start         # start the bridge and PWA
bun run start:bridge  # start only the bridge
```

Package-script changes should preserve this contract.

For a bridge-only plugin installation, put this in the plugin `.env` before starting:

```dotenv
COLLIE_SERVE_PWA=off
```

The launcher skips the browser build and non-API routes return 404. Native clients and a PWA hosted
elsewhere can still use every bridge endpoint.

For a standalone PWA build:

```bash
VITE_HERDR_BRIDGE_URL=https://machine.your-tailnet.ts.net:8787 \
VITE_HERDR_BRIDGE_LABEL="Primary machine" \
  bun run build:pwa
```

Deploy `web/dist` to an HTTPS static host. On the target bridge, add that static host's exact origin
to `COLLIE_ALLOWED_ORIGINS`. The PWA can run without a co-located bridge, but live operation still
requires at least one reachable bridge; `?demo=1` remains available without one.

## Requirements

- Herdr 0.7.0 or newer.
- Bun available on `PATH`.
- macOS or Linux.
- Tailscale when remote tailnet access is desired.
- A single-user host, or an owner-isolated VM/container.

The relay is intentionally unavailable on Windows because its service lifecycle and Herdr socket
integration currently target launchd and systemd-style environments.

## Install from GitHub

Replace `<owner>` with the GitHub account or organization that publishes this repository:

```bash
herdr plugin install <owner>/herdr-web --yes
```

Herdr runs the manifest build step during installation. That step installs both Bun dependency
trees, typechecks the relay and browser client, and produces the static web bundle.

Create the private configuration file before starting remote access:

```bash
config_dir="$(herdr plugin config-dir herdr.control)"
install -d -m 700 "$config_dir"
install -m 600 .env.example "$config_dir/.env"
```

Edit `$config_dir/.env` and set at least the trusted Tailscale identity for remote use:

```dotenv
COLLIE_TRUSTED_USER=you@example.com
```

Then start the service:

```bash
herdr plugin action invoke start --plugin herdr.control
herdr plugin action invoke status --plugin herdr.control
herdr plugin action invoke url --plugin herdr.control
```

The URL action prints the address to open in a browser or enter in Herdr Mobile, normally similar to:

```text
https://your-machine.your-tailnet.ts.net:8787
```

Do not publish this service with Tailscale Funnel. Authorized write endpoints can type into live
terminal processes and therefore carry the authority of a remote shell.

## Local development installation

Clone the repository, then link it instead of installing a managed GitHub checkout:

```bash
git clone https://github.com/<owner>/herdr-web.git
cd herdr-web
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin herdr.control
```

Herdr does not run manifest build steps for a local link. The first `start` builds the browser client
lazily when `web/dist` is absent.

## Configuration

All settings live in the plugin configuration directory returned by:

```bash
herdr plugin config-dir herdr.control
```

Copy [.env.example](.env.example) to `.env` in that directory. Important settings include:

| Variable | Default | Purpose |
| --- | --- | --- |
| `COLLIE_PORT` | `8787` | Loopback relay port. |
| `COLLIE_HOST` | `127.0.0.1` | Bind host; non-loopback values are rejected. |
| `COLLIE_SERVE_MODE` | `https` | Tailscale Serve mode; `http` supports Headscale environments without certificates. |
| `COLLIE_SERVE_PORT` | relay port | Dedicated public tailnet listener. |
| `HERDR_SOCKET_PATH` | Herdr default socket | Override only for a nonstandard Herdr installation. |
| `COLLIE_SERVE_PWA` | `on` | Set `off` for an API-only bridge with no bundled browser assets. |
| `COLLIE_MULTI_SESSION` | `on` | Discover and expose named Herdr sessions. |
| `COLLIE_POLL_MS` | `1500` | Fast fallback polling interval. |
| `COLLIE_POLL_IDLE_MS` | `12000` | Safety-net polling while event subscriptions are healthy. |
| `COLLIE_READ_LINES` | `200` | Default bounded pane read size. |
| `COLLIE_NOTIFY_DELAY_MS` | `30000` | Delay before a blocked-agent notification. |
| `COLLIE_DONE_NOTIFY_DELAY_MS` | `600000` | Delay before an unseen completed-agent notification. |
| `COLLIE_TRUSTED_USER` | unset | Required matching proxy identity for remote API access. |
| `COLLIE_TRUSTED_USER_HEADER` | `Tailscale-User-Login` | Identity header injected by the trusted proxy. |
| `COLLIE_PUBLIC_HOSTS` | derived for Tailscale | Allowed public `host[:port]` values. |
| `COLLIE_ALLOWED_ORIGINS` | unset | Exact PWA/custom origins allowed to receive this bridge cross-origin. |
| `COLLIE_DEVICE_HEADER` | unset | Optional proxy-injected device identity header. |
| `COLLIE_DEVICE_ALLOWLIST` | unset | Devices allowed to perform write operations. |
| `COLLIE_VAPID_PUBLIC` | auto-generated | Optional Web Push public-key override. |
| `COLLIE_VAPID_PRIVATE` | auto-generated | Optional Web Push private-key override. |
| `COLLIE_VAPID_SUBJECT` | generic mailto | Optional Web Push administrator contact. |

### Tailscale

The `start` action installs a dedicated Serve listener and records exactly which mapping it owns.
Updates and teardown verify that ownership before replacing or removing anything, so unrelated
Tailscale Serve applications are left intact.

The default public port matches `COLLIE_PORT` rather than taking over port 443. Set
`COLLIE_SERVE_PORT=443` only when this relay should own the root MagicDNS HTTPS URL.

### Headscale and custom proxies

Set `COLLIE_SERVE_MODE=http` for a private Headscale network without managed HTTPS certificates.
For another TLS terminator or vanity domain, configure the exact public host and origin:

```dotenv
COLLIE_PUBLIC_HOSTS=herdr.example.com
COLLIE_ALLOWED_ORIGINS=https://herdr.example.com
```

The proxy must strip and inject the configured trusted-user header and must preserve public request
provenance using standard forwarded headers. Never accept a client-supplied identity header directly.

### Multiple devices in one PWA

Keep one bridge beside Herdr on every device. Install/open the PWA from one stable HTTPS bridge,
then allow that PWA origin on every additional device:

```dotenv
# On the additional device
COLLIE_ALLOWED_ORIGINS=https://pwa-host.your-tailnet.ts.net:8787
```

Restart the additional bridge, open **Settings → Devices** in the installed PWA, and add that
device's Tailscale Serve URL. The device picker scopes all snapshots, pane reads, and mutations.
The additional bridge still
requires its own `COLLIE_PUBLIC_HOSTS`/Serve mapping and matching `COLLIE_TRUSTED_USER` identity.

Cross-device receivers require HTTPS. Push registration remains owned by the PWA's built-in default
bridge; receiver federation currently covers interactive access to additional bridges, not their push
deep links.

### Optional device authorization

Device authorization is an additional write gate, not a substitute for user authentication. A
trusted reverse proxy can inject an opaque device ID:

```dotenv
COLLIE_DEVICE_HEADER=X-Device-Id
COLLIE_DEVICE_ALLOWLIST=phone,tablet
```

Unknown devices become read-only. On a public host, a missing device header also fails closed to
read-only access.

### Web Push

Herdr Web generates a persistent VAPID key pair in its private state directory on first start. Open
Settings, enable Push notifications, and use the Test button to verify delivery.

To supply an existing key pair instead, generate keys with:

```bash
bunx web-push generate-vapid-keys
```

Set the two key values and optionally `COLLIE_VAPID_SUBJECT`, then restart the bridge. Push keys,
subscriptions, and preferences are stored with owner-only permissions in the private plugin state
directory.

## Plugin actions

```bash
herdr plugin action invoke start --plugin herdr.control
herdr plugin action invoke stop --plugin herdr.control
herdr plugin action invoke restart --plugin herdr.control
herdr plugin action invoke status --plugin herdr.control
herdr plugin action invoke url --plugin herdr.control
herdr plugin action invoke version --plugin herdr.control
herdr plugin action invoke update --plugin herdr.control
herdr plugin action invoke uninstall --plugin herdr.control
```

`uninstall` removes the supervised service and the Serve mapping created by this plugin. It keeps
the private `.env`, state directory, and source checkout. Remove the plugin registration separately:

```bash
herdr plugin uninstall herdr.control
```

The `update` action can update a linked branch checkout. Herdr-managed GitHub installs are pinned to
a resolved commit; for those installations the action prints the safe uninstall/reinstall command.

## Development

Install dependencies:

```bash
bun install
cd web && bun install && cd ..
```

Run the relay and browser development server separately:

```bash
# Terminal 1
bun run dev:bridge

# Terminal 2 (same-origin PWA through Vite's bridge proxy)
bun run dev:pwa
```

Vite proxies `/api` to `http://127.0.0.1:8787`. Add `?demo=1` to the browser URL to use preview
data explicitly. Connection failures do not silently enable demo mode. To develop only the PWA
against a remote bridge, set `VITE_HERDR_BRIDGE_URL` before `bun run dev:pwa` and allow
`http://127.0.0.1:5173` on that bridge for this local development origin.

Run verification:

```bash
bun run typecheck
bun run test
bun run build
```

## Repository layout

```text
bridge/                 Bun bridge; pwa-assets.ts is its optional static-bundle adapter
docs/                   Architecture and protocol notes
scripts/                Service, update, Tailscale, push, and release helpers
systemd/                Reference systemd user unit
web/                    React/Vite browser client and PWA
web/.env.example        Standalone PWA receiver configuration
herdr-plugin.toml       Herdr plugin manifest
.env.example            Documented runtime configuration
```

## Security model

- The relay always binds loopback.
- Remote access is disabled until a trusted user is configured.
- Every non-loopback request must match the public Host allowlist.
- Browser writes are protected by same-origin checks.
- Forwarded requests do not receive loopback operator exemptions.
- Terminal output is rendered as text rather than injected HTML.
- Mutation bodies, uploads, scrollback, and concurrency are bounded.
- Writes are attributed in an append-only audit log.
- Runtime credentials and state use owner-only filesystem permissions.

Operate it only on a single-user host or an equivalently isolated environment.

## Troubleshooting

Check relay and service status:

```bash
herdr plugin action invoke status --plugin herdr.control
bash scripts/collie-ctl.sh logs 100
```

Common causes:

- **Remote requests return 403:** configure `COLLIE_TRUSTED_USER` and verify Tailscale Serve is
  injecting the expected identity.
- **Cross-origin rejected:** add the exact custom origin and public host to the allowlists.
- **Browser UI returns 503:** run `bash scripts/collie-ctl.sh build`, then restart.
- **Herdr shows disconnected:** confirm the Herdr server is running and the configured socket exists.
- **No HTTPS on Headscale:** use HTTP Serve mode inside the private tailnet or add an external TLS
  terminator; PWA installation and Web Push still require a secure browser context.
- **Port already belongs to another Serve app:** choose another `COLLIE_SERVE_PORT`; the launcher
  intentionally refuses to overwrite mappings it does not own.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
