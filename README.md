# OpenClaw Pet

A small character that lives on your desktop and feels connected to [OpenClaw](https://github.com/openclaw/openclaw).
It idles, thinks, works, celebrates and frowns along with your OpenClaw agent, and has a one-line quick chat
that continues your most recent OpenClaw session. Codex-Pet style, for OpenClaw.

- macOS and Windows.
- Plug-and-play: install, launch, it finds the local OpenClaw Gateway by itself.
- One toggle to connect or disconnect OpenClaw.
- Drag it anywhere, resize it, swap in your own PNG / WebP / GIF / SVG characters from a GUI.
- Zero unnecessary token usage: only a message you type in the quick chat starts an agent turn.
  Every reaction is computed locally from Gateway events and the reply text.

```
        [ PET ]
   [ Ask OpenClaw… ]
```

---

## Contents

1. [Quick start](#quick-start)
2. [How the OpenClaw connection works](#how-the-openclaw-connection-works)
3. [OpenClaw-side steps you may need to run](#openclaw-side-steps-you-may-need-to-run)
4. [Using the pet](#using-the-pet)
5. [Characters and assets](#characters-and-assets)
6. [Architecture and decisions](#architecture-and-decisions)
7. [Build from source](#build-from-source)
8. [Troubleshooting](#troubleshooting)
9. [What is verified and what is not](#what-is-verified-and-what-is-not)

---

## Quick start

1. Install the app (`OpenClaw Pet-<version>.dmg` on macOS, `OpenClaw Pet Setup <version>.exe` on Windows) or run from source (below).
2. Launch it. A small character appears at the bottom-right of your screen and a tray / menu-bar icon shows up.
3. If OpenClaw is running on this computer, the status dot on the character turns green within a second or two.
4. Hover the character and type into **Ask OpenClaw…**, press Enter. Done.

No config files, ports, session IDs or tokens to deal with.

## How the OpenClaw connection works

### Auto-discovery

OpenClaw stores its settings in `~/.openclaw/openclaw.json` (JSON5), including the Gateway port
(default `18789`) and the shared gateway token. The pet **reads** that file (never writes it), builds
`ws://127.0.0.1:<port>`, and connects with the token. It honours `OPENCLAW_CONFIG_PATH` and
`OPENCLAW_STATE_DIR` if you set them, and falls back to the default port if the file is missing.

On Windows the same file lives under `%USERPROFILE%\.openclaw\openclaw.json` when OpenClaw runs natively.
If your Gateway runs inside WSL2 or on another machine, open **Settings → OpenClaw connection (advanced)**,
switch to **Manual**, and paste the URL and token once.

### Handshake and pairing

The pet speaks the Gateway WebSocket protocol (v4) directly:

1. Waits for `connect.challenge`, then sends `connect` with `role: operator`, scopes
   `operator.read` + `operator.write`, the shared token, and a signed Ed25519 **device identity**
   (generated once and kept in the app's data folder).
2. The Gateway auto-approves device pairing for direct loopback connections, so there is no prompt on
   the normal same-machine setup.
3. On success it receives `hello-ok` and starts listening for events.

### Events → character state (no polling, no extra prompts)

The pet does **not** advertise the `session-scoped-events` capability, so the Gateway pushes `chat` and
`agent` events for every session this operator can read: the main session, Discord/Telegram-driven sessions,
dashboard sessions, and so on. From those it derives:

| Gateway signal | Pet state |
|---|---|
| `chat` `status`/`delta`, `agent` lifecycle `start` | **thinking** |
| `agent` `tool` stream `start` (until the tool ends) | **working** |
| `chat` `final` whose text ends with `?` or asks the user something | **question** |
| `chat` `final` that reports success (`done`, `✅`, `완료`…) | **happy** |
| `chat` `error`, or a reply that opens with a failure | **error** |
| `session.observer` digest with `waiting-on-user` | **question** |
| No connection while OpenClaw is ON | **offline** |

Cron, heartbeat, webhook and internal model-probe sessions are ignored. The heuristics live in
`src/main/openclaw/reactions.ts` and are covered by unit tests. **No LLM call is ever made to decide a mood.**

### Quick chat

`chat.send` is the only method in the whole app that starts an agent turn. It targets the session with the
most recent real user interaction (`lastInteractionAt`, from `sessions.subscribe` / `sessions.changed`),
excluding automation sessions, so it continues where you left off in Discord, the web chat, etc.
The reply is shown as a short status line under the input; the character reacts as above.

### Toggle

Tray menu → **OpenClaw** (checkbox), or Settings → General → OpenClaw. Off closes the socket and stops all
reconnection; nothing else in the app touches the network.

## OpenClaw-side steps you may need to run

The pet never modifies anything under `~/.openclaw`. In the default setup nothing is required. If Settings
shows a hint, the corresponding fix is:

| Hint shown in the pet | What to run on the Gateway host |
|---|---|
| "OpenClaw is not running…" | `openclaw gateway start` (or `openclaw gateway`) |
| "OpenClaw needs a gateway token…" (token not in config, or stored as a secret reference) | `openclaw gateway auth-token --show`, paste it into Settings → OpenClaw connection → Token. If no token is configured at all: `openclaw doctor --generate-gateway-token`, then restart the Gateway. |
| "OpenClaw wants you to approve this device once…" (happens when `gateway.nodes.pairing.autoApproveLocal` is `false`, or over SSH/LAN) | `openclaw devices list` → `openclaw devices approve <requestId>` |
| "This device was paired with fewer permissions…" | Same as above; the pet asks for `operator.read` and `operator.write` only. |
| Remote Gateway (another machine / WSL2) | Nothing on the Gateway side beyond what OpenClaw already requires for remote clients (`gateway.bind`, TLS or an SSH tunnel). Enter the URL/token in Settings. |

To revoke the pet later: `openclaw devices list`, then `openclaw devices remove <deviceId>` (its display name is "OpenClaw Pet").

## Using the pet

- **Move**: drag the character. It never goes fully off-screen and the position is remembered.
- **Quick chat**: hover the character (or click it on a trackpad) → type → Enter. `Esc` closes it.
- **Settings**: right-click the character, or tray menu → Settings…
- **Hide / show**: tray menu.
- **Mouse reactions**: hover, pressed, dragging and a short landing bounce after a drop. These are local.
- The little dot on the character is the OpenClaw status: green connected, amber connecting, red needs attention,
  grey off.

Clicks on transparent parts of the pet window fall through to whatever is underneath.

### Settings

- **General**: OpenClaw on/off (+ a plain-language hint if it cannot connect), Launch at login, Always on top.
- **Character**: pick, Add Character (name → image → done), Rename, Duplicate, Delete, Import folder, Show files, Size slider.
- **Assets**: one row per state with a preview, **Change…**, **Clear**, and drag-and-drop of an image onto the row.
- **Behavior**: Reactions on/off, Hover chat on/off, reaction length.
- **OpenClaw connection (advanced)**: auto / manual URL, token, password.

## Characters and assets

A character is a folder with one image per state and a tiny manifest. You never have to edit it by hand,
but it is deliberately simple so packs can be shared by copying a folder:

```
<app data>/characters/momo/
  character.json      {"id":"momo","name":"Momo","assets":{"idle":"idle.svg","happy":"happy-x1.png",…}}
  idle.svg
  happy-x1.png
  …
```

- `<app data>` is `~/Library/Application Support/openclaw-pet` on macOS and `%APPDATA%\openclaw-pet` on Windows
  (Settings → Character → **Show files** opens it).
- States: `idle` (required), `hover`, `pressed`, `drag`, `drop`, `thinking`, `working`, `happy`, `error`,
  `question`, `offline`. Missing states fall back sensibly (e.g. `working → thinking → idle`), and CSS motion
  (breathing, wiggle, bounce, shake, hop) plus a small badge make even a single-image character feel alive.
- Formats: PNG, WebP, GIF (animated is fine), JPG, SVG, APNG, AVIF.
- **Import folder** accepts either a folder with `character.json` or a folder of images named after the states
  (`idle.png`, `happy.gif`, …).
- The bundled character **Momo** is copied into the data folder on first run, so it is editable like any other.

Only the images of the *current* character are loaded, one at a time, when the state changes.

## Architecture and decisions

```
src/
  shared/types.ts              states, settings, IPC channel names
  main/
    index.ts                   app bootstrap, windows, tray, IPC, drag loop
    windows.ts                 pet window (transparent / frameless / floating) + settings window
    tray.ts                    tray menu
    settings-store.ts          settings.json in userData
    characters.ts              character folders + manifests
    openclaw/
      discovery.ts             read ~/.openclaw/openclaw.json → ws url + token
      device-identity.ts       Ed25519 keypair, device id, v3 auth payload
      gateway-client.ts        WebSocket, handshake, RPC, events (≈250 lines)
      controller.ts            ON/OFF, reconnect, events → pet state, quick chat
      reactions.ts             local reply classifier
  preload/index.ts             contextBridge API (`window.pet`)
  renderer/pet/                the character + quick chat
  renderer/settings/           settings UI
  tools/probe.ts               `npm run probe` diagnostics
assets/characters/momo/        bundled character
```

**Why Electron.** The candidates were Electron and Tauri. Tauri would be lighter at idle, but on this
machine Rust is Homebrew's 1.83 without `rustup`, which is too old for a current Tauri build, and a
Windows Tauri build additionally depends on WebView2 and a Rust toolchain on the build machine.
Electron builds on macOS and Windows with only Node, yields a one-click installer, and every existing
OpenClaw desktop pet (DesktopClaw, kkclaw) uses it. To keep it light: one small transparent window,
background throttling on, no framework in the renderers, no devtools in production, only the current
character's image loaded, and no timers except the drag loop while dragging and the reconnect backoff.
The OpenClaw layer has no Electron imports, so a future Tauri shell can reuse it unchanged.

**Why a hand-written gateway client instead of `@openclaw/gateway-client`.** The published client is
a general SDK with device-token stores, node protocols and reconnect policies we do not need; the pet
needs the handshake, four RPC methods and an event stream. Implementing that directly (≈250 lines,
validated against the local Gateway's own protocol schema and the reference client's device-auth code)
keeps the bundle at ~230 KB with no runtime dependencies and makes the token policy auditable in one file.

**Why no Gateway plugin.** Everything the pet needs (run lifecycle, tool activity, final reply text,
session list) is already broadcast to operator clients, so a plugin would add an install step and a
restart for no gain, which conflicts with the plug-and-play goal.

**Why no session subscription.** By not advertising `session-scoped-events`, the pet receives `chat`
and `agent` events for all readable sessions and can follow whatever session the user is actually
using (Discord today, web chat tomorrow) without polling `sessions.list`.

**Prior art reviewed.** DesktopClaw (Electron, Gateway WS, PNG sprite sheets), kkclaw (Electron,
CSS animation), OC-Claw (Tauri, polls session JSONL files rather than the Gateway), and Codex Pets
(system-wide pixel pet driven by agent hooks). The folder-of-images pack format and the
idle/thinking/working/happy/error/question state set follow their conventions so assets are easy to port.

**Privacy.** Nothing leaves the machine except the WebSocket to your own Gateway. No analytics, no
sentiment API. Reply text is kept in memory only for the status line.

## Build from source

Requirements: Node.js 22+ (tested with 26) and npm. No Rust, no Python.

```bash
git clone <this repo> openclaw-pet && cd openclaw-pet
npm install          # esbuild + electron postinstall steps are pre-approved in package.json
npm start            # builds and launches
```

Useful commands:

| Command | Purpose |
|---|---|
| `npm run build` | bundle main / preload / renderers into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (reaction heuristics, discovery, device auth) |
| `npm run probe` | connect to the local Gateway like the app does, list sessions; add `-- --watch=10` to stream events. Costs no tokens. |
| `npm run dist:mac` | `.dmg` + `.zip` into `release/` (unsigned unless you provide signing env vars) |
| `npm run dist:win` | NSIS installer + portable `.exe` into `release/` (run on Windows) |
| `OPENCLAW_PET_DEBUG=1 npm start` | verbose connection logging |
| `OPENCLAW_PET_DEVTOOLS=1 npm start` | allow DevTools in the windows |

### macOS

`npm run dist:mac` produces `release/OpenClaw Pet-<version>.dmg`. The app is a menu-bar app (no Dock icon).
Unsigned builds show the usual Gatekeeper warning; right-click → Open once, or sign with
`CSC_LINK`/`CSC_KEY_PASSWORD`. Launch-at-login uses the system login items API and only works from the
built `.app` (not from `npm start`).

### Windows

On a Windows machine with Node installed: `npm install && npm run dist:win`. This yields a one-click NSIS
installer (per-user, no admin) and a portable `.exe`. Transparent always-on-top windows, drag & drop and
the tray menu all use stock Electron features on Windows. If the Gateway runs in WSL2, use Manual mode
in Settings with the WSL address, or forward the port to `127.0.0.1` (see OpenClaw's Windows docs).

## Troubleshooting

- **Grey dot, "OpenClaw off"** – the toggle is off. Tray → OpenClaw.
- **Red dot** – open Settings; the hint under the OpenClaw toggle says what to do, and **Details** shows the
  raw error code for bug reports.
- **The pet is invisible on Windows** – transparent windows require desktop composition (always on in Windows 10/11);
  check that the character has an idle image (Settings → Assets).
- **Quick chat says "No OpenClaw session found yet"** – your Gateway has no session with a real user
  interaction yet. Send one message from any OpenClaw client first (or the pet falls back to `agent:main:main`).
- **Diagnose from a terminal** – `npm run probe -- --watch=15` prints the discovered config, the handshake result,
  the sessions and live events.

## What is verified and what is not

Verified on this machine (macOS, OpenClaw 2026.9.3, live Gateway with a Discord-connected agent):

- Config discovery from `~/.openclaw/openclaw.json`, handshake with challenge + Ed25519 device auth,
  loopback auto-pairing, `hello-ok` with `operator.read`/`operator.write`, `sessions.subscribe` bootstrap.
- App launch: pet window, tray, settings window, connection turns green, sessions loaded.
- Unit tests: 14 passing (`npm test`).

Not verified here (see `BLOCKERS.md`):

- Sending a quick-chat message end-to-end. It would start a real, token-consuming agent turn in the owner's
  live session, so it was intentionally not exercised. The call is the documented `chat.send` RPC over the
  same connection that `sessions.list` was verified on.
- Windows build and runtime (no Windows machine available).
- Live `thinking`/`working`/reaction transitions with a real run in flight (the event handling is exercised
  by unit tests on the classifier and by watching the live event stream with `npm run probe -- --watch`).
