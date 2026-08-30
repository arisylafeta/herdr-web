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
