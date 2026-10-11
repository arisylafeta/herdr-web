# Architecture

## Ownership

```text
installed PWA / native app (may be hosted elsewhere)
        |
        | receiver selects machine origin + local session
        v
host-local Herdr Web bridge (Bun, loopback only)
        |  optional PwaAssets adapter -> bundled web/dist
        |
        | RPC over Unix socket + native terminal controller stream
        v
Herdr server -> workspaces -> tabs -> terminal panes -> agents
```

Herdr remains the source of truth for process lifetime, pane state, workspace structure, and agent status. The browser is a client and can disappear without affecting running work.

## Deployment seam

`startServer` owns only the bridge interface. It accepts an optional `PwaAssets` adapter from
`bridge/pwa-assets.ts`; `bridge/index.ts` installs that adapter only when `COLLIE_SERVE_PWA` is on.
Without it, the same bridge process exposes `/api/*` and returns 404 for browser routes. The bridge
therefore has no runtime dependency on `web/dist`.

The reverse direction is also explicit. The PWA's built-in receiver defaults to its own origin for
the combined deployment, while `VITE_HERDR_BRIDGE_URL` can bake a different default receiver into a
standalone static build. `web/` imports no bridge source files and has its own dependency tree,
typecheck, tests, build, development server, and preview command.

## Client mapping

| T3 Code concept | Herdr concept |
| --- | --- |
| Project | Workspace |
| Thread | Agent-bearing pane or shell pane |
| Machine | Persisted bridge receiver profile |
| Environment | Named Herdr session on the selected machine |
| Conversation timeline | Recent pane output |
| Composer send | `pane.send_text` followed by `pane.send_keys` |
| New thread | New tab with a shell pane |

## Agent identity and status presentation

The bridge keeps the user-managed Herdr agent `name` separate from the agent implementation in
`agent` (for example, `review-api` versus `codex`). The sidebar presents `name` first, then a
meaningful tab label or workspace label, and uses the implementation name only as a last fallback.

Sidebar status is communicated once per pane. Working uses a static blue badge; Done uses a green
badge with a square check. The sidebar does not repeat status with a blinking dot. Other surfaces
may retain compact status dots where they are the only status signal.

## Transport

The bridge uses a Herdr adapter seam. `bridge/herdr-client.ts` is the only client-facing module that knows Herdr RPC method names. The browser uses `web/src/lib/receiver.ts` as its machine seam: one receiver owns one bridge origin, request construction, timeouts, and pane validators. Clients consume bounded snapshots and pane reads over REST, with a session-scoped WebSocket carrying structural change notifications and native terminal frames.

Machine identity and Herdr session identity remain separate. A pane is addressed by the tuple
`bridge profile + session name + pane id`; pane and session IDs may be reused safely on another
machine. Additional bridges grant exact-origin CORS only to configured `COLLIE_ALLOWED_ORIGINS`.

Navigation is event-poked: `events.subscribe` accelerates authoritative `session.snapshot` refreshes. An authorized native client drives the selected terminal through `herdr terminal session control --takeover` at that device's measured columns and rows. The bridge forwards ANSI redraw frames over the WebSocket and sends native `terminal.resize` and `terminal.scroll` commands back through the same controller process. This gives a smaller tablet viewport the same live TUI navigation semantics as an attached Herdr CLI instead of relying on local terminal scrollback. Read-only clients use `herdr terminal session observe`; bounded pane reads remain as startup, older-version, and reconnect recovery.

## Omp transcript seam

`GET /api/pane/:id/transcript` returns the active JSONL branch as structured, inert records
with a revision/ETag scoped to agent status and the requested window, defaulting to the last 60
records (maximum 400). Tool results update their call-position record.
`/transcript/record/:recordId` expands text to at most 1 MiB;
`/transcript/image/:recordId/:index` serves supported raster images up to 5 MiB with private
caching and `nosniff`. All three routes use the existing session selector and read-access guard.
`sessionId` comes from the first `session` entry in the bounded 64 KiB header read, allowing a
`title` preamble; file identity is the fallback only when no session header is found there.
The Herdr environment remains the separate `?session=` selector.
Custom messages appear only when their `display` flag is explicitly true. Persisted IRC incoming
messages become chronological `irc` records. Vibe results, phased todo snapshots and task progress
retain bounded typed records, linked to their tool call by `callId` where applicable; successful
spawn acknowledgements never imply completed workers. Todo HUD visibility applies only to the
matching canonical source entry and fingerprint. Tool `summary` preserves the native intent.
Failed/aborted assistant turns emit `error`/`aborted` dividers even without content. Unresolved
calls are presented as interrupted when the pane is idle/done, not permanently running.
The latest unresolved persisted start supplies activity only while working/blocked.

Herdr's pane session reference stays in the engine's private map; public snapshots expose only
`transcript:true` after a safe-read probe. The browser cannot choose a file. Reported paths are
still untrusted: the bridge requires an omp path reference, `.jsonl`, an owner-owned regular
non-symlink file, canonical-root containment, `O_NOFOLLOW`, matching opened device/inode,
and a valid initial session/title header. The default root is `~/.omp/agent/sessions`;
`COLLIE_TRANSCRIPT_ROOTS` adds colon-separated absolute roots for custom session directories.
The exact authoritative session path is replaced by `[session file]` in served strings,
including nested arguments; unrelated paths remain intact. Contents are never logged.
Pane processes are trusted for session selection: allowed roots grant access to every owner-owned
valid transcript within them, not proof that a transcript belongs to that pane. Ancestor-directory
rename/symlink races are outside the threat model of this single-user host service.

An eight-file LRU cache uses a global conservative retained-payload budget of 192 MiB,
configurable with `COLLIE_TRANSCRIPT_CACHE_MB` (1–4096 MiB). Charges are four times retained
entry/image serialized bytes plus 256 bytes per entry for indexing/object overhead; this bounds
cached payload, not exact process RSS. Oversized sessions can be served without being retained.
At most two distinct file loads parse concurrently; other loads queue before opening a descriptor.
Parsing is bounded to a 64 MiB tail window; `truncatedFile:true` signals missing earlier history.
Complete JSONL lines exceeding 8 MiB are skipped as inert. Torn trailing lines are not emitted.
Tool previews retain head and tail within 16 KiB. Args are capped to 8 KiB of JSON, six nesting
levels and 256 visited nodes, with explicit `…[truncated N bytes]` string prefixes. Full args are
not retained or available through record expansion; that route expands output/text only.

Fresh parent-linked leaf extensions reuse records and tool indexes; forks/context boundaries
replay compact history. Shrinks, inode replacements and same-size metadata changes rebuild.
Every reuse verifies SHA-256 guards on the first 4 KiB and last 4 KiB of the consumed region
(shorter files use available bytes). Growth additionally verifies a rolling checksum over the
entire retained byte window, so an interior rewrite cannot hide behind unchanged samples.
This uses Bun's non-cryptographic hash, fixed 1 MiB chunks and a reused scratch buffer; no raw
consumed-file copy is retained. Checksums are generation detectors, not hostile-content authenticity.
The same open descriptor is re-statted after all header/body reads, parsing and checksum work:
size, mtime or ctime changes discard the tentative result and retry once; a second unstable
read returns 503 instead of mixed contents. Changes outside the retained window do not affect its
records; the start guard still covers the beginning of the file. This is not an atomic snapshot against same-UID
filesystem attackers, consistent with the single-user-host boundary above.

### Disk-derived native working state

The additive `status` block exposes current model display metadata, effort/service tier, mode,
foreground pane cwd, estimated turn origin, git counts, context estimate and disk worker evidence.
Model display names and windows come from the read-only omp `model_cache` table; missing metadata
means an unknown window, never a fabricated limit. Context follows the active branch's latest
prompt anchor plus bounded estimates for later completed messages, discarding anchors across
reset/compaction boundaries. It is explicitly `source: "estimate"`: pending prompts, tokenizer
settings and unseen system/tool context cannot be recovered from disk. Pressure thresholds use
the earliest of 50%/150k, 70%/270k and 90%/500k tokens.

`status.todo` projects the latest canonical phased plan and its matched HUD visibility from the
complete retained active branch, independently of the chronological history window. Scrolling
or 65+ later messages cannot remove a pinned pending plan; branch changes select that branch's
plan. Visibility participates in the response revision. Compact replay preserves normal assistant
stop reasons as well as errors/aborts, so a completed turn cannot leave a stale tool activity label.

Git reuses the workspace inspection subprocess/security boundary at the pane cwd through a brief
stale-while-revalidate cache. Its footer path counts repository-wide porcelain states without diff
or numstat reads, groups untracked directories and pairs only exact renames like native VCS.
Gitlink index/HEAD changes count normally; nested worktree dirtiness is inspected separately with
each child's filters disabled, never through unsafe recursive `git status`. Submodule reads share
the Git deadline and are bounded to 64 repositories/four depths. Slow Git never blocks transcripts.
Status and owned-child projections participate in the revision/ETag, including
freshness, so child and git changes appear without a director append. `turnStartedAt` estimates
the initiating user/developer message only while working; it is not process uptime.

Child reads follow only lifecycle/call references under `<session without .jsonl>/<id>.jsonl`,
recursively within bounded depth/count/byte budgets. They require same-UID regular files,
non-symlink path components, canonical allowed-root containment and checked opened identity.
Old child evidence cannot establish active work. Current/recent children take priority over dead
history under the read budget. Descriptor count and byte budgets are separate: bounded referenced
children skipped for bytes still appear as unknown/unavailable. An eight-entry, two-second projection
cache bounds repeat reads. Child `id` and `parentId` are opaque session/ancestry identities;
`handle` is the display name and is not a key. Distinct dotted and nested handles cannot collide.
Every descriptor labels `source` and `childAvailable`; successful reads are distinct from historical
task results and inaccessible files. Exact authoritative ancestor/child paths are redacted before
excerpt clipping, including URI/colon-prefixed occurrences.

Unknown child turns/queued counters are absent, not zero. Supported fields merge independently:
saved-wall counts retain their own `turnsObservedAt`/`queuedObservedAt` while fresher child activity
can update `observedAt`. The bridge never replaces an entire wall row with incomplete evidence.
No directory-wide historical-session discovery, credentials, drafts, extension observer or terminal
scraping feeds this projection. Streaming text, queues, exact runtime timers, IRC relay observations
and retry/approval state remain unavailable: use the terminal surface.


## Browser chat view

Transcript-capable omp panes open in Chat; the topbar switches between Chat and the existing
terminal mirror. The preference is stored in sessionStorage by bridge profile, Herdr environment,
and pane. Shell and non-transcript panes keep the terminal path. The browser receiver owns scoped
transcript URLs and ETag validators, isolating each history window; `useTranscript` opens the latest
60 records, adds 60 with Show earlier (up to the route's 400-record cap), polls every 1.2 seconds
while visible or working, and slows to six seconds when hidden/idle. Failed reads preserve the
previous completed window and show Reconnecting.

The transcript renders completed messages only: no token streaming is simulated. Stable record
IDs preserve tool/thought expansion as tool results change within an omp session. Tool resources
also key by omp `sessionId`, so session replacement aborts old full-record requests and drops
cached output/errors even when call IDs repeat. Tools start collapsed; full output is fetched
only on request. Expanded read/write cards show a compact path, edit cards color unified diffs,
and bash cards separate command from result; unknown tools keep the JSON fallback. Error and
aborted turns have visible, respectively error/warning-edged rows with uncollapsed inert details.
Markdown is parsed as GFM, sanitized by DOMPurify, then converted into React nodes; code blocks
offer Copy and fold beyond 40 lines. Image thumbnails open a modal viewer.
Following is limited to a 60px bottom threshold, earlier loads preserve the scroll anchor, and
Jump to latest restores following without stealing a reader's position.

Blocked panes expose an always-visible warning card with the last twelve ANSI-stripped pane
output lines, scrolled to the prompt, and Enter/Esc/Up/Down/Tab controls. The composer stays outside
the conversation scroller, grows up to 40vh, and retains the original reply/upload/key chain.
Stop still sends Esc. No steer/follow-up mode is advertised.

The entire shell uses bundled JetBrains Mono and square, palette-derived surfaces. `tokens.css`
records the installed omp titanium dark and light theme source hex values; semantic surfaces,
status colors and terminal ANSI colors derive from those palettes. Light/dark/system preferences,
prepaint bootstrap, theme-color metadata, safe-area padding and reduced-motion support remain.
Contrast tests resolve source-derived sRGB/OKLab mixes and overlays across both themes: secondary
text meets 4.5:1 and decorative text meets 3:1 on all tested shell/transcript surfaces.
`?demo=1` provides all record kinds, observed-running/error tools, specialized file/diff/command anatomy,
failed/aborted turns, approval state, images, long output and paginated history for isolated
browser checks without a Herdr connection.

### Native work presentation

Disk-backed Vibe, incoming IRC, phased todo and task snapshots stay at their chronological
positions. Worker lifecycle labels describe observations: idle means reusable, never completed;
historical running snapshots do not animate or tick. Call-linked Vibe/task details share the original
tool disclosure, without a duplicate card, while preserving arguments/output. Unknown kinds use a fallback.

Chat reserves a compact dock above the composer: current pane activity and the existing Esc Stop,
one combined Work details disclosure, and one model/mode/context status disclosure. Status opens a
focus-trapped read-only sheet with folder Copy, git file counts and disk freshness. In short
viewports telemetry folds into Work details. Sheets consume Escape before runtime controls and
restore launcher focus. Disclosure identities include bridge, Herdr session, pane and omp session;
polling preserves expansion, while changing ownership resets it.

Context pressure uses the earliest percentage or absolute threshold: 50%/150k, 70%/270k,
90%/500k. Semantic tokens supply both themes and accessible pressure labels. The current-turn
clock ticks locally once per second only when active and visible; its disk origin is estimated.
No native observer, streaming wall, retry countdown, relay delivery or exact context is promised.
Demo transport supports `context=ok|warn|high|critical|unknown` and `oldBridge=1` compatibility scenarios.


## Security

- Run Herdr Web only on a single-user workstation (or inside an owner-isolated VM/container).
  Loopback prevents network ingress; it does not authenticate separate OS accounts on a shared host.
- Bind the bridge to loopback only.
- Expose it with `tailscale serve`; do not use public funneling.
- Treat every write endpoint as remote shell access.
- Configure `COLLIE_TRUSTED_USER` for every remote deployment; remote API access fails closed when
  it is absent. Device checks remain optional and add finer-grained write authorization.
- Remote per-device authorization requires both an allowlisted device header and the configured
  trusted-user identity header. Non-Tailscale proxies must strip/inject that header and set
  `COLLIE_TRUSTED_USER_HEADER` to its name.
- Render terminal output as React text nodes; never inject pane output as HTML.
- Keep the append-only audit log for every write action.

## Native client path

The browser types in `web/src/lib/types.ts` mirror the bridge domain types, not raw Herdr wire records. A native client can implement the same REST contract without emulating the web UI or knowing the Unix socket protocol.
