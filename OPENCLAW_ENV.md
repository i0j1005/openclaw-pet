# OpenClaw environment on this machine

Read this before investigating OpenClaw integration. All paths are on the local macOS host.

## Locations

| What | Path |
|---|---|
| OpenClaw CLI binary | `/opt/homebrew/bin/openclaw` (`openclaw --version` → 2026.9.3) |
| OpenClaw package (source + docs) | `/opt/homebrew/lib/node_modules/openclaw/` |
| Docs (markdown) | `/opt/homebrew/lib/node_modules/openclaw/docs/` |
| Docs mirror | https://docs.openclaw.ai |
| Source repo | https://github.com/openclaw/openclaw |
| User config + state dir | `~/.openclaw/` |
| Main config file | `~/.openclaw/openclaw.json` |
| Agent workspace (main agent) | `~/.openclaw/workspace/` |
| Existing plugin skills | `~/.openclaw/plugin-skills/` |

## Runtime facts

- Gateway is **running right now** on this machine, port `18789`, bound to `loopback` (`gateway.bind: loopback`), token/password auth. A Discord-connected agent is actively using it.
- `openclaw` CLI talks to the running Gateway (e.g. `openclaw status`, `openclaw sessions list`, `openclaw config get <path>`).
- Node runtime available; Homebrew present.

## Docs worth reading first

- `docs/gateway/protocol/` — WebSocket protocol: `handshake.md`, `auth.md`, `rpc-methods.md`, `transport.md`, `presence.md`, `ledgers.md`, `versioning.md`
- `docs/gateway/openai-http-api.md`, `docs/gateway/tools-invoke-http-api.md`, `docs/gateway/external-apps.md` — HTTP surfaces
- `docs/web/webchat.md`, `docs/web/control-ui.md` — how the official chat/UI clients connect (good reference for a lightweight client)
- `docs/concepts/session-state.md`, `docs/concepts/session-tool.md` — sessions, "most recent session" semantics
- `docs/nodes/index.md`, `docs/gateway/pairing.md`, `docs/cli/devices.md` — device pairing if the pet should register as a node
- `docs/plugins/` — plugin SDK, if a small gateway-side plugin is the cleanest way to get lifecycle events
- `docs/gateway/configuration.md`, `docs/gateway/configuration-reference.md`
- `docs/platforms/macos.md`, `docs/platforms/windows.md` — existing companion apps (menu bar app / Windows Hub) for reference on what already exists

## Hard rules

- **Do not modify `~/.openclaw/openclaw.json` or anything under `~/.openclaw/` and do not restart/stop the Gateway.** It is live and in use. Treat OpenClaw as read-only infrastructure to integrate with.
- If the integration needs a config change or a plugin installed on the OpenClaw side, implement it in this repo and document the exact steps/commands in `README.md` instead of applying them.
- Reading config via `openclaw config get ...` and calling read-only Gateway/CLI methods is fine.
- Work only inside `~/gitrepo/openclaw-pet/`.
