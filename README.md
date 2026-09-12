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

The pet listens to three kinds of Gateway pushes (all metadata-only):

- `sessions.subscribe` gives it `sessions.changed` events for every session this operator can read, including
  the `chat.run.started` / `chat.run.settled` reasons and the `hasActiveRun` flag.
- `sessions.messages.subscribe` on the session the quick chat targets gives it `session.message` transcript
  events: the authoritative reply text, whatever runtime produced it (embedded runner, Claude CLI runtime, resumed
  or recovered runs).
- The plain `chat` / `agent` / `session.tool` broadcasts, when the Gateway projects them.

From those it derives:

| Gateway signal | Pet state |
|---|---|
| `chat.send` accepted, `sessions.changed` `chat.run.started` / `hasActiveRun`, a user transcript entry, `chat` `status`/`delta`, `agent` lifecycle `start` | **thinking** |
| `agent` / `session.tool` `tool` stream `start` (until the tool ends) | **working** (only visible for the pet's own quick chats; the Gateway sends tool events to the run's sender) |
| Reply (via `session.message` or `chat` `final`) whose text ends with `?` or asks the user something | **question** |
| Reply that reports success (`done`, `✅`, `완료`…) | **happy** |
| Reply that compliments you (`great question`, `잘하셨어요`) | **praise** |
| Reply that cheers you on (`you can do it`, `화이팅`) | **encourage** |
| Bashful reply (`*blushes*`, `부끄럽네요`, 😳) | **shy** |
| Bad news or sympathy (`sorry to hear`, `unfortunately`, `안타깝게도`) | **sad** |
| Worn-out reply (`phew`, `that was a lot`, `힘들었어요`) | **tired** |
| `chat` `error`, or a reply that opens with a failure | **error** |
| `session.observer` digest with `waiting-on-user` | **question** |
| No connection while OpenClaw is ON | **offline** |

Cron, heartbeat, webhook and internal model-probe sessions are ignored. The heuristics live in
`src/main/openclaw/reactions.ts` (Korean + English regexes, most specific first: question > error > shy >
praise > encourage > tired > sad > happy) and are covered by unit tests. **No LLM call is ever made to decide a mood.**

Precedence on screen: dragging > pressed > drop > working > thinking > reaction > hover > offline > idle.
Activity and reactions deliberately beat hover, because the mouse is usually still over the character right
after sending from the quick chat.

### Quick chat

`chat.send` is the only method in the whole app that starts an agent turn. It targets the session with the
most recent real user interaction (`lastInteractionAt`, from `sessions.subscribe` / `sessions.changed`),
excluding automation sessions, so it continues where you left off in Discord, the web chat, etc.

After Enter the input bar disappears and a **speech bubble** under the character shows your message and the
reply, updated live (Thinking…, Working on it…, streamed text, the final reply, or an error). The bubble stays
until you send the next message. Click it to collapse it to a small pill (click again to expand); drag the
grip in its bottom-right corner to resize it (longer replies scroll inside). The size and collapsed state are
remembered. The transparent pet window grows and shrinks around the character to fit the bubble and still
lets clicks through on empty areas; if there is no room below, the window is nudged up only while the bubble
needs it. Slash commands such as `/status` are handled by the Gateway and show their output in the bubble too.

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
- **Quick chat**: hover the character (or click it on a trackpad) → type → Enter. `Esc` closes it. The reply
  appears in a speech bubble under the character (click to collapse, drag the corner to resize).
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
- **Behavior**:
  - Reactions on/off, Hover chat on/off, **Reset size** for the speech bubble.
  - **Ambient motion**: one row per state (Idle breathing, Thinking swaying, Working bouncing, Question head
    tilt) with its own switch, **Intensity** (20–250 %) and **Speed** (0.25–3×). All off by default: a looping
    transform on a transparent always-on-top window keeps the GPU slightly busy. Implemented as CSS custom
    properties (`--amb-i`, `--amb-speed`) on the existing keyframes, no JavaScript animation loop.
  - **Reaction length**: one slider per reaction (Happy, Praise, Encourage, Shy, Sad, Tired, Error, Question),
    1–30 s. Defaults: 7 s for happy/praise/encourage, 4 s shy, 8 s sad/tired, 10 s error, 12 s question.
- **OpenClaw connection (advanced)**: auto / manual URL, token, password.

Settings live in `settings.json` in the app data folder and carry a `settingsVersion`. Files from the first
release (single `ambientMotionEnabled` / `reactionDurationMs`) are migrated on load: the old toggle enables
all four ambient rows, the old duration becomes the happy/error/question hold time.

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
- States: `idle` (required), `hover`, `pressed`, `drag`, `drop`, `thinking`, `working`, `happy`, `praise`,
  `encourage`, `shy`, `sad`, `tired`, `error`, `question`, `offline`. Missing states fall back sensibly
  (`working → thinking → idle`, `praise/encourage/shy → happy → idle`, `tired → sad → idle`), and one-shot CSS
  motion (hop, cheer, wiggle, droop, sag, shake) plus a small badge make even a single-image character feel alive.
- The bundled Momo has an image for every state. An already-installed Momo picks up images for newly added
  states on the next launch without touching anything you changed.
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

**Why one session subscription.** By not advertising `session-scoped-events`, the pet is eligible for the
`chat` and `agent` broadcasts of all readable sessions and can follow whatever session the user is actually
using (Discord today, web chat tomorrow) without polling `sessions.list`. In practice those broadcasts are
not projected for every runtime (a real run on the Claude CLI runtime produced none), so the pet also calls
`sessions.messages.subscribe` for the one session the quick chat targets and takes replies from the
transcript events, the same source the bundled TUI uses. It re-subscribes when the target changes.

**Prior art reviewed.** DesktopClaw (Electron, Gateway WS, PNG sprite sheets), kkclaw (Electron,
CSS animation), OC-Claw (Tauri, polls session JSONL files rather than the Gateway), and Codex Pets
(system-wide pixel pet driven by agent hooks). The folder-of-images pack format and the
idle/thinking/working/happy/error/question state set follow their conventions so assets are easy to port.

**Privacy.** Nothing leaves the machine except the WebSocket to your own Gateway. No analytics, no
sentiment API. Reply text is kept in memory only for the speech bubble and is gone when the app quits.

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
| `npm run probe` | connect to the local Gateway like the app does, list sessions; add `-- --watch=10` to stream events or `-- --history=agent:main:main` to print the last transcript entries. Costs no tokens. |
| `node scripts/dev-run.mjs 20 --capture /tmp/pet` | run for 20 s with debug logging and write `pet.png`, `settings*.png`; `--shots N` keeps capturing the pet every 3 s |
| `… --send "/status"` | submit one quick-chat message through the real UI path; `/status` is answered by the Gateway itself, so it is a **token-free** end-to-end test of the bubble and the thinking state |
| `… --send-dry "hi"` | same UI path with a locally faked reply (no network); `--collapse-at 3` clicks the bubble before shot 3 |
| `… --eval "<js>"` | run JS in the pet page before the first capture (`--eval-end` after the last) |
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
- `npm run dist:mac -- --dir` packaging (unsigned).
- Unit tests: 27 passing (`npm test`): reaction heuristics for all eight reactions in Korean and English,
  settings migration/clamping, discovery, device auth.
- Round 2 (2026-09-13), with the app running against the live Gateway:
  - Speech bubble: shows the sent message, the live "Thinking…" state, the streamed/final reply and errors;
    click collapses it to a pill; corner grip resizes; the window grew from 316 to 381 px and back as the
    bubble appeared / collapsed (`--send-dry` run, screenshots inspected).
  - Ambient motion: enabling Idle at intensity 2 / speed 1.5 yields the `breathe` animation with a 2.4 s period
    and the CSS variables set; the setting was restored afterwards.
  - Thinking asset: with the token-free `/status` quick chat the character switched to the thinking image
    right after Enter (`state-thinking` in the capture), the Gateway's reply reached the bubble via
    `session.message`, and the character went back to idle.
  - One real quick-chat message (the single message the maintainer allowed) was sent to the owner's main
    session. `chat.history` confirms the reply "Pet test done ✅" arrived 7 s later, but the Gateway
    broadcast **no** `chat`/`agent` event for that Claude-CLI-runtime run, which is exactly why the pet
    previously never left idle. The `session.message` subscription above was added in response.
- Idle footprint in dev mode (`node scripts/dev-run.mjs 12`): about 400 MB of *summed* resident memory across the
  Electron main, GPU and renderer processes. That figure double-counts shared framework pages, so the real
  unique memory is well under half of it, and CPU is at zero while idle (no timers, no polling). A Tauri
  shell would cut this further; see BLOCKERS.md for why it was not used here.

Not verified here (see `BLOCKERS.md`):

- A real model reply flowing into the bubble and triggering a reaction (happy/praise/…) end-to-end. The
  `session.message` path that now carries replies was verified with the Gateway-handled `/status` command,
  not with a second real agent turn (only one was allowed). To confirm on your own session:
  `node scripts/dev-run.mjs 60 --capture /tmp/pet --shots 12 --send "reply with just: done ✅"`.
- The **working** state with a real tool call in flight (needs a quick chat that makes the agent use a tool).
- Windows build and runtime (no Windows machine available).
- Bubble resizing with a real mouse drag (the grip logic runs on mouse events; only the collapse click was
  driven programmatically in the captures).
