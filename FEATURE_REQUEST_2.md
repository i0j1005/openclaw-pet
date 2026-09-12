# Feature request round 2 (from the project owner, 2026-09-13)

Original request (Korean, verbatim):

1. thinking할때 에셋이 안바뀌어.
2. ambient animation 강도와 시간을 조절할 수 있으면 좋겠고, 토글을 에셋별로 할 수 있으면 좋겠어.
3. 채팅을 입력하면 채팅창이 없어지고, 밑에 말풍선에 입력과 답변을 볼 수 있으면 좋겠어. 클릭해서 접었다 펼 수 있게, 다음 채팅이 들어오기 전까지 유지. 말풍선 크기도 조절 가능하게.
4. 감정을 좀더 세분화 (슬픔, 힘듦, 부끄러움, 유저칭찬, 격려 등). 유지 시간도 조정.

## Notes from the maintainer (read before implementing)

### 1. Thinking asset never shows — likely cause
`src/renderer/pet/pet.ts` `currentState()` resolves `hover` before `working`/`thinking`. The user sends from the quick chat with the mouse still over the character, so `hover` wins for the whole run and the thinking/working asset is never displayed. Also a lingering `reaction` (e.g. `happy`) outranks activity. Fix the precedence: `pressed` > `drag` > `drop` > `working` > `thinking` > `hover` > `reaction` > `offline` > `idle` (or similar — activity must beat hover). Then verify with a real run that `agent` lifecycle events actually mark runs (`touchRun` in `controller.ts`); add a one-line debug log if needed. Do the verification with a *single* real quick-chat message (that is one agent turn on the owner's live session; acceptable, but do not spam).

### 2. Ambient motion controls
Current: one boolean `ambientMotionEnabled` gating the looping `breathe`/`sway`/`bounce`/`tilt` animations (`pet.css`, `#stage.ambient.state-* #img`). Wanted:
- per-state toggle (idle, thinking, working, question),
- per-state **intensity** (amplitude) and **speed/duration**.
Drive them with CSS custom properties (e.g. `--amb-scale`, `--amb-rot`, `--amb-dur`) set from settings, so no JS animation loop is introduced. Keep the default off for idle (compositor cost on a transparent always-on-top window). Settings UI: a compact per-state row (switch + two small sliders). Keep the settings model flat and versioned (old `settings.json` without the new keys must still load with defaults).

### 3. Speech bubble instead of the input bar after sending
Wanted flow: hover/click shows the one-line input as now → user presses Enter → the input bar disappears → a speech bubble appears next to the character showing the user's message and the reply (update it live from the `chat` events: thinking…, then final text, or error). The bubble stays until the next message is sent (no auto-hide). Clicking the bubble collapses it to a small pill and clicking again expands it. The bubble must be resizable (a drag handle on a corner is ideal; at minimum a width/max-height setting with internal scroll). The bubble is part of the transparent pet window, so grow the window as needed and keep click-through for empty areas. Persist collapsed state and size in settings.

### 4. More emotions + per-emotion hold time
Extend `ReactionState` with: `sad`, `tired` (힘듦), `shy` (부끄러움), `praise` (the assistant praises the user), `encourage` (cheering the user on). Keep the existing ones. The classifier in `src/main/openclaw/reactions.ts` must stay a **local heuristic** (keyword/regex, Korean + English) — absolutely no extra LLM call. Add unit tests for the new classes (Korean and English phrases). Add asset rows for the new states in the settings asset grid with sensible fallbacks (e.g. sad→idle, praise→happy). Replace the single `reactionDurationMs` with per-reaction hold times editable in Behavior settings (defaults can differ: error longer, shy shorter, etc.).

## Constraints (unchanged)
- Read `REQUIREMENTS.md` (product spec) and `OPENCLAW_ENV.md` (environment + hard rules) first.
- Never modify anything under `~/.openclaw`, never restart/stop the Gateway.
- Only the quick chat may start an agent turn. UI interactions never call the LLM.
- Typecheck, run tests, run the app once with `scripts/dev-run.mjs --capture` and look at the screenshots.
- Commit in sensible increments; update `README.md` for the new settings; summarize what works / what is untested at the end.
