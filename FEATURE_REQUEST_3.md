# Feature request round 3 (from the project owner, 2026-09-13)

Two items, from a quick-chat message (Korean, verbatim): "오푸스5로, 아까 말했던 에이전트 변경, 그리고 에셋을 state로 바꾸고 state마다 에셋을 여러개 넣어서 랜덤으로 출력되게끔 구현하고 싶어."

("With Opus 5[this is just how the owner refers to me, ignore], the agent-switch thing I mentioned earlier, and: change assets to be per-state with several assets each, output at random.")

## A. Per-character target agent

Right now `pickTargetSession()` in `src/main/openclaw/controller.ts` picks the single most-recently-active session across *all* agents. The owner wants each **character** to be tied to one agent, so switching the active character in Settings switches who the quick chat talks to.

- The gateway already supports this: `agents.list` (RPC) returns the visible agent roster; `sessions.list`/`sessions.subscribe` rows carry `agentId`; `chat.send` takes an explicit `agentId`; the delivery-route fix already added in `resolveDeliveryRoute` works per-session regardless of agent.
- Add an optional `agentId` field to the character manifest (`Character` in `src/shared/types.ts`, `CharacterManifest` in `src/main/characters.ts`). Leave it unset for existing/bundled characters — unset means "any agent, most-recent session" (today's behavior), so this is backward compatible.
- Add an "Agent" dropdown to the Add Character flow and the per-character Settings row (fetch options via `agents.list`, filtering to `kind !== "system"` — see the docs quote in `OPENCLAW_ENV.md`/rpc-methods.md for the exact shape; advertise the `agent-kind` handshake capability if the client doesn't already, otherwise the roster silently omits `kind`).
- `pickTargetSession()`: when the active character has an `agentId`, filter candidate sessions to that `agentId` before picking the most-recent one (fall back to the `agent:<id>:main` session if none exist yet, same pattern as today's fallback). When the character has no `agentId`, keep today's global behavior.
- Only one character is ever "active" at a time today (`settings.characterId`), so only one agent needs to be targeted at once — no need for multiple simultaneous gateway subscriptions beyond what already exists, just re-subscribe/re-pick when the active character (and thus its agentId) changes.

## B. Multiple assets per state, random pick

Today `assets: Partial<Record<PetState, string>>` — one file per state. Change to `assets: Partial<Record<PetState, string[]>>` — a list of variants per state, and the renderer picks one at random **each time the pet enters that state** (not on every render frame/tick — that would flicker and defeats the point of a stable pose). Re-picking again the next time the same state is (re)entered is fine and expected (that's the "random variety" the owner wants).

- `src/shared/types.ts`: `Character.assets` → `Partial<Record<PetState, string[]>>`.
- `src/main/characters.ts`: `CharacterManifest.assets` → arrays. Add `addAssetVariant(id, state, sourcePath)` (append) and `removeAssetVariant(id, state, index)` alongside (or replacing) `setAsset`/`clearAsset`. **Migrate old manifests transparently on read**: a manifest with a bare string for a state should be treated as `[thatString]` (do this in the `read()`/manifest-loading path, and rewrite the file once so it doesn't need to re-migrate every load). `installBundled()`'s upgrade-merge logic (per-state "only fill in if missing") needs the same array-awareness.
- `src/renderer/pet/pet.ts` `resolveAsset()`: pick `assets[state][random index]` when entering a new resolved state (track "last resolved state" and only re-roll the pick when it changes); keep the existing state-fallback chain (`STATE_FALLBACKS`) for states with zero variants.
- Settings asset grid (`src/renderer/settings/settings.ts` + its HTML/CSS): each state row needs to show *all* variants (small thumbnail strip) with per-thumbnail remove, plus an "Add variant" control (button and/or drag-and-drop appends rather than replaces). `idle` must always keep at least one variant (same "required" rule as today, just index-aware now). Keep drag-and-drop working — dropping a file appends a variant instead of replacing state wholesale.
- IPC (`src/preload/index.ts`, `src/main/index.ts`, the `IPC` map in `src/shared/types.ts`): add channels for add/remove-variant; keep or repurpose `setAsset`/`clearAsset` as thin wrappers if that's simpler, your call.

## Constraints (same as before — read first)
- Read `REQUIREMENTS.md`, `OPENCLAW_ENV.md`, and the current README/source before starting.
- Never modify anything under `~/.openclaw`, never restart/stop the Gateway.
- Only the quick chat may start an agent turn (still true — none of this touches that boundary). Reuse the existing test discipline: at most one real quick-chat message if you need to prove the agent-routing end to end, prefer the token-free `/status` trick used last round if it still fits.
- Typecheck, run the full test suite, run the app once via `scripts/dev-run.mjs --capture` (it already supports `--send`/`--send-dry`/`--shots`/`--collapse-at`/`--eval`/`--payloads` and stops stale Electron instances) and look at the screenshots — verify random variety actually rotates across repeated state entries, and that switching the active character to one with an `agentId` set actually changes who receives the quick chat (a metadata-only check via `sessions.describe`/`sessions.list` is enough, no need to spend a real turn per agent).
- Commit in sensible increments, update `README.md` and `BLOCKERS.md`, and finish with a concise summary of what works, what's untested, and open blockers.
