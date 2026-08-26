# Architecture

## Ownership

```text
browser / native app
        |
        | REST + session-scoped WebSocket
        v
Herdr Web bridge (Bun, loopback only)
        |
        | RPC over Unix socket + native terminal controller stream
        v
Herdr server -> workspaces -> tabs -> terminal panes -> agents
```

Herdr remains the source of truth for process lifetime, pane state, workspace structure, and agent status. The browser is a client and can disappear without affecting running work.

## Client mapping

| T3 Code concept | Herdr concept |
| --- | --- |
| Project | Workspace |
| Thread | Agent-bearing pane or shell pane |
| Environment | Named Herdr session / host bridge |
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

The bridge uses Collie's adapter boundary. `bridge/herdr-client.ts` is the only client-facing service module that knows Herdr RPC method names. Clients consume bounded snapshots and pane reads over REST, with a session-scoped WebSocket carrying structural change notifications and native terminal frames.

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
