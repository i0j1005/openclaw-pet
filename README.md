# OpenClaw Pet

<p align="center">
  <img src="assets/icon.png" alt="OpenClaw Pet icon" width="128">
</p>

OpenClaw Pet is a small desktop companion for [OpenClaw](https://github.com/openclaw/openclaw). It stays above your windows, reacts to agent activity, and provides a compact quick chat without turning into another full chat client.

> The current build is tested on macOS. Windows packaging is configured, but the Windows runtime has not yet been verified on a Windows machine.

## What it does

- Finds a local OpenClaw Gateway automatically and reconnects when needed.
- Continues the most recently used OpenClaw session from a compact hover chat, with direct character, agent, and recent-session targeting.
- Binds individual characters to specific OpenClaw agents when desired.
- Shows thinking, working, success, error, question, and other reaction states from Gateway events and local text rules.
- Supports several images per state and picks a different variant when that state begins.
- Lets you add, rename, duplicate, import, and edit characters from Settings.
- Handles dragging, resizing, always-on-top behavior, launch at login, multi-monitor position recovery, and optional ambient motion.

Only a message submitted through quick chat starts an agent turn. Mouse interactions, animations, settings, and reaction classification stay local and do not use model tokens.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) with its Gateway running
- Node.js 22 or newer
- npm

## Run from source

```bash
git clone https://github.com/i0j1005/openclaw-pet.git
cd openclaw-pet
npm install
npm start
```

The pet appears near the bottom-right of the display, and a tray or menu-bar icon provides access to Settings, hide/show, connection control, and quit.

## OpenClaw connection

In automatic mode, the app reads OpenClaw's local configuration and connects to the Gateway on loopback. It supports `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR`, and it never modifies files under `~/.openclaw`.

If OpenClaw runs in WSL2, on another computer, or behind a tunnel, open **Settings → OpenClaw connection (advanced)** and enter the WebSocket URL and token manually.

The connection uses the Gateway WebSocket protocol with a signed device identity. A normal loopback connection is usually paired automatically. If the Gateway asks for approval, run:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

To revoke the app later:

```bash
openclaw devices list
openclaw devices remove <deviceId>
```

The device is listed as `OpenClaw Pet`.

## Using the pet

| Action | How |
| --- | --- |
| Move | Drag the character. Its position is remembered. |
| Quick chat | Hover or click the character. Enter sends; Shift+Enter adds a line. Click the destination label to choose a character, agent, or recent session. |
| Manage a run | Use **Stop** while a reply is running, or **Retry** after an error or stopped run. |
| Reuse a question | Choose **Edit & resend** below a finished reply to put the previous question back into the input. |
| Manage a reply | Use the bubble's Copy, collapse, and close buttons. A notification dot beside the character reopens a closed latest reply. |
| Resize a reply | Drag the grip at the bottom-right of the speech bubble. |
| Open Settings | Right-click the character or use the tray menu. |
| Hide or show | Use the tray/menu-bar item. The choice is remembered across launches. |

The status dot is green when connected, amber while connecting, red when attention is needed, and grey when OpenClaw is disabled.

### Choosing an agent

Each agent can have one character, and each character targets at most one agent. Manage the whole mapping under **Settings → Characters → Agent characters**, change only the selected character with **This character's agent**, or click the target label above quick chat. Reassigning an agent moves it from its previous character. Leaving a character at **Any agent** preserves the default behavior: quick chat continues the most recently active user session. An exact recent-session selection lasts until the agent changes or the app restarts.

Replies render a deliberately limited Markdown subset: links, ordered and unordered lists, inline code, and fenced code blocks. Code blocks scroll horizontally and include their own **Copy code** button; raw HTML and other Markdown formatting are displayed as plain text.

## Characters and assets

Characters are managed from Settings. You can start with one image, add more state images later, or import a folder. Supported formats are PNG, WebP, GIF, JPG, SVG, APNG, and AVIF.

Each state accepts multiple variants. The app chooses a variant whenever the character enters that state and avoids immediately repeating the previous choice when possible. Only `idle` is required; missing states fall back to a related state or to `idle`.

Available states:

```text
idle       hover      pressed     drag
drop       thinking   working     happy
praise     encourage  shy         sad
tired      error      question    offline
```

A shareable character folder looks like this:

```text
my-character/
├── character.json
├── idle.png
├── idle-2.gif
├── thinking.png
└── happy.png
```

```json
{
  "id": "my-character",
  "name": "My Character",
  "agentId": "main",
  "assets": {
    "idle": ["idle.png", "idle-2.gif"],
    "thinking": ["thinking.png"],
    "happy": ["happy.png"]
  }
}
```

`agentId` is optional. A folder without `character.json` can also be imported when its files use state names such as `idle.png`, `happy.gif`, or numbered variants such as `idle-2.png`.

User characters are stored in:

- macOS: `~/Library/Application Support/openclaw-pet/characters`
- Windows: `%APPDATA%\openclaw-pet\characters`

Use **Settings → Character → Show files** to open the folder directly.

## Development

| Command | Purpose |
| --- | --- |
| `npm start` | Build and launch the app |
| `npm run build` | Build the app, tests, and diagnostic tool with source maps |
| `npm run build:app` | Build only the development app with source maps |
| `npm run build:prod` | Build only the minified production app |
| `npm run typecheck` | Run TypeScript checks without emitting files |
| `npm test` | Build and run the unit tests |
| `npm run probe` | Inspect Gateway discovery and sessions without starting an agent turn |
| `npm run dist:mac` | Build a macOS DMG and ZIP in `release/` |
| `npm run dist:win` | Build a Windows installer and portable executable |

For connection diagnostics:

```bash
npm run probe -- --agents
npm run probe -- --watch=15
OPENCLAW_PET_DEBUG=1 npm start
```

`scripts/dev-run.mjs` launches a time-limited development session and can capture the pet and Settings windows for visual checks:

```bash
node scripts/dev-run.mjs 20 --capture /tmp/openclaw-pet --shots 3
```

## Project structure

```text
src/
├── main/                 Electron lifecycle, windows, tray, settings, characters
│   └── openclaw/         Discovery, device identity, Gateway client, reactions
├── preload/              Safe renderer bridge
├── renderer/
│   ├── pet/              Character, quick chat, and speech bubble
│   └── settings/         Settings interface
└── shared/               Shared types and IPC channel names
assets/characters/momo/   Bundled character
scripts/                  Build, icon, and visual-test helpers
tests/                    Node test suite
```

The renderers use plain TypeScript, HTML, and CSS. The OpenClaw integration is event-driven; it does not poll the Gateway or call a model to decide the character's mood.

## Packaging notes

macOS builds are unsigned unless signing credentials are supplied, so Gatekeeper may require **right-click → Open** for a local build. Launch at login works from the packaged app, not from `npm start`.

Windows targets are configured for a per-user NSIS installer and a portable executable. Build them on Windows with `npm install && npm run dist:win`.

## Troubleshooting

- **The status dot is red:** open Settings and check the connection hint. Use **Details** for the Gateway error code.
- **The status dot is grey:** enable OpenClaw from Settings or the tray menu.
- **No session is found:** send a message from an OpenClaw client first, then retry quick chat.
- **The local Gateway is not running:** start it with `openclaw gateway start`.
- **Automatic discovery cannot read a token:** obtain it with `openclaw gateway auth-token --show` and enter it in the advanced connection settings.
- **More diagnostics are needed:** run `npm run probe -- --watch=15`.

## Privacy

OpenClaw Pet has no analytics or external sentiment service. It connects only to the configured OpenClaw Gateway. Reply text is kept in memory for the speech bubble and is discarded when the app exits.

## License

[MIT](LICENSE)
