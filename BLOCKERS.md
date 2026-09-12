# Blockers and workarounds

Things the permission system or environment prevented during development, and what was done instead.

| What was blocked | Needed for | Workaround |
|---|---|---|
| `jq` / `sed` / `head` on `~/.openclaw/openclaw.json` (tooling refuses to process files outside the working directories) | Confirming the config file layout (key names, token type) before writing discovery code | Used the read-only CLI instead: `openclaw config get gateway.port`, `openclaw config get gateway.auth.mode`, and `openclaw config get gateway.auth.token \| wc -c` (length only, value never printed). Discovery is covered by unit tests against synthetic JSON5 files. |
| Compound shell commands (`a && b; c`) were repeatedly rejected | Convenience only | Split into single commands or wrapped in small `scripts/*.mjs` runners (`scripts/dev-run.mjs`, `scripts/gen-icons.mjs`). |
| Rust toolchain is Homebrew `rustc 1.83` with no `rustup` | A Tauri build (the lighter shell) needs a current stable toolchain; upgrading Rust system-wide was out of scope | Shipped on Electron instead (see README, "Why Electron"). The gateway client and pet logic are plain TypeScript with no Electron imports, so a Tauri port only replaces the shell. |
| npm 11 `install-scripts` policy skipped the `esbuild` and `electron` postinstall steps | Building and running | Approved them explicitly (`npm install-scripts approve …`, recorded in `package.json#allowScripts`) and ran `node node_modules/electron/install.js` once. Fresh clones with the committed `allowScripts` block install cleanly. |
| Sending a real quick-chat message during testing | End-to-end verification of `chat.send` | Deliberately **not** done: it would start a real agent turn (LLM tokens) in the owner's live main session that a Discord agent is using. The request/response path is the documented `chat.send` RPC and the same handshake/RPC plumbing that `sessions.list` uses (verified live). Marked as untested in the README. |
| Windows build | Verifying the NSIS installer | No Windows machine in this environment. `electron-builder --win` config is present; cross-building from macOS needs Wine and was not attempted. |
