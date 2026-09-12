// Pet window renderer: character display, mouse interaction, quick chat and the speech bubble.
// Everything visual is decided here or in the main process; nothing here talks to a model.
import {
  AMBIENT_STATES,
  BUBBLE_LIMITS,
  STATE_FALLBACKS,
  type AmbientState,
  type Character,
  type ChatStatusUpdate,
  type ConnectionInfo,
  type PetSnapshot,
  type PetState,
  type Settings,
} from "../../shared/types";

const api = window.pet;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>("stage");
const charEl = $<HTMLDivElement>("char");
const img = $<HTMLImageElement>("img");
const badge = $<HTMLDivElement>("badge");
const chat = $<HTMLDivElement>("chat");
const chatForm = $<HTMLFormElement>("chatForm");
const chatInput = $<HTMLInputElement>("chatInput");
const bubble = $<HTMLDivElement>("bubble");
const bubbleUser = $<HTMLDivElement>("bubbleUser");
const bubbleReply = $<HTMLDivElement>("bubbleReply");
const bubblePill = $<HTMLDivElement>("bubblePill");
const bubbleGrip = $<HTMLDivElement>("bubbleGrip");

/** Must match PET_PAD in src/main/windows.ts (the stage padding). */
const PAD = 12;

let settings: Settings | null = null;
let character: Character | null = null;
let snapshot: PetSnapshot = { activity: "idle", reaction: null, connection: "off" };
let connection: ConnectionInfo = { status: "off" };

// mouse state
let hovering = false;
let pressed = false;
let dragging = false;
let dropUntil = 0;
let pressStart: { x: number; y: number } | null = null;
let ignoringMouse = false;
let chatHideTimer: number | null = null;
let chatOverride = false; // opened by click; stays until Esc / blur
let currentSrc = "";

// speech bubble state (last exchange; stays until the next message is sent)
type BubblePhase = "sending" | "thinking" | "working" | "reply" | "error" | "aborted";
let bubbleState: { visible: boolean; user: string; reply: string; phase: BubblePhase; runId?: string } = {
  visible: false,
  user: "",
  reply: "",
  phase: "reply",
};
let resizing: { startX: number; startY: number; w: number; h: number } | null = null;
let bubblePress: { x: number; y: number } | null = null;

const BADGES: Partial<Record<PetState, string>> = {
  thinking: "…",
  working: "⚙",
  happy: "♥",
  praise: "★",
  encourage: "♪",
  shy: "~",
  sad: "☹",
  tired: "z",
  error: "!",
  question: "?",
  offline: "z",
};

// ---- state resolution ---------------------------------------------------------

/**
 * Precedence: drag > pressed > drop > working > thinking > reaction > hover > offline > idle.
 * Activity and reactions beat hover on purpose: the mouse is usually still over the character right
 * after sending from the quick chat, and the whole point is to see it think and react.
 */
function displayState(): PetState {
  const now = Date.now();
  if (dragging) return "drag";
  if (pressed) return "pressed";
  if (dropUntil > now) return "drop";
  if (snapshot.activity === "working") return "working";
  if (snapshot.activity === "thinking") return "thinking";
  if (snapshot.reaction) return snapshot.reaction;
  if (hovering) return "hover";
  if (settings?.openclawEnabled && snapshot.connection !== "connected") return "offline";
  return "idle";
}

/**
 * Which variant is on screen. A random variant is rolled each time the pet *enters* a state (or the
 * character changes), never on a plain re-render, so a pose stays put while the mouse moves or the
 * connection dot changes; re-entering the same state rolls again.
 */
let pick: { state: PetState; owner: PetState; index: number } | null = null;

function resolveAsset(state: PetState): { src: string | null; fallback: boolean } {
  if (!character) {
    pick = null;
    return { src: null, fallback: true };
  }
  const owner = ownerState(character, state);
  if (!owner) {
    pick = null;
    return { src: null, fallback: true };
  }
  const variants = character.assets[owner]!;
  if (!pick || pick.state !== state || pick.owner !== owner || pick.index >= variants.length) {
    pick = { state, owner, index: pickVariant(variants.length, pick?.owner === owner ? pick.index : -1) };
  }
  return { src: fileUrl(variants[pick.index]), fallback: owner !== state };
}

/** The state whose variants are shown for `state`: itself, else the first fallback that has any. */
function ownerState(c: Character, state: PetState): PetState | null {
  if (c.assets[state]?.length) return state;
  for (const fb of STATE_FALLBACKS[state]) if (c.assets[fb]?.length) return fb;
  return null;
}

/** Uniform random index; with two or more variants it avoids repeating the one just shown. */
function pickVariant(count: number, previous: number): number {
  if (count <= 1) return 0;
  let i = Math.floor(Math.random() * count);
  if (i === previous) i = (i + 1 + Math.floor(Math.random() * (count - 1))) % count;
  return i;
}

/** Dev/test hook (window.__pet.variant()): which file is showing, so captures can prove the rotation. */
(window as any).__pet = {
  variant: () => (pick ? { state: pick.state, owner: pick.owner, index: pick.index, src: currentSrc } : null),
  state: () => displayState(),
};

function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function render(): void {
  const state = displayState();
  const { src, fallback } = resolveAsset(state);
  if (src && src !== currentSrc) {
    currentSrc = src;
    img.src = src;
    img.style.visibility = "visible";
  } else if (!src) {
    currentSrc = "";
    img.removeAttribute("src");
    img.style.visibility = "hidden";
  }
  const ambient = settings && (AMBIENT_STATES as readonly string[]).includes(state) ? settings.ambientMotion[state as AmbientState] : null;
  if (ambient?.enabled) {
    stage.style.setProperty("--amb-i", String(ambient.intensity));
    stage.style.setProperty("--amb-speed", String(ambient.speed));
  }
  stage.className = [
    `state-${state}`,
    fallback ? "fallback" : "",
    `conn-${snapshot.connection}`,
    settings?.openclawEnabled ? "show-dot" : "",
    ambient?.enabled ? "ambient" : "",
    fallback && BADGES[state] ? "badge" : "",
    chatOpen() ? "chat-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  badge.textContent = BADGES[state] ?? "";
  requestExtent();
}

function applySettings(s: Settings): void {
  settings = s;
  charEl.style.setProperty("--size", `${s.size}px`);
  chatInput.disabled = !s.openclawEnabled;
  chatInput.placeholder = s.openclawEnabled ? "Ask OpenClaw…" : "OpenClaw is off";
  if (!resizing) {
    bubble.style.setProperty("--bubble-w", `${s.bubble.width}px`);
    bubble.style.setProperty("--bubble-h", `${s.bubble.maxHeight}px`);
  }
  bubble.classList.toggle("collapsed", s.bubble.collapsed);
  render();
}

// ---- window extent (the main process grows the transparent window to fit the bubble) ------------

let extentRaf = 0;
let lastExtent = { w: -1, h: -1 };
function requestExtent(): void {
  if (extentRaf) return;
  extentRaf = window.requestAnimationFrame(() => {
    extentRaf = 0;
    let bottom = charEl.getBoundingClientRect().bottom;
    let width = 0;
    if (stage.classList.contains("chat-open")) bottom = Math.max(bottom, chat.getBoundingClientRect().bottom);
    if (!bubble.hidden) {
      const r = bubble.getBoundingClientRect();
      bottom = Math.max(bottom, r.bottom);
      width = r.width + PAD * 2;
    }
    const w = Math.ceil(width);
    const h = Math.ceil(bottom + PAD);
    if (w === lastExtent.w && h === lastExtent.h) return;
    lastExtent = { w, h };
    void api.pet.setExtent(w, h);
  });
}
new ResizeObserver(() => requestExtent()).observe(bubble);

// ---- chat bar -------------------------------------------------------------------

function chatOpen(): boolean {
  if (!settings) return false;
  if (chatOverride) return true;
  if (!settings.hoverChatEnabled) return false;
  return hovering || document.activeElement === chatInput || chatInput.value.trim().length > 0;
}

function scheduleChatHide(): void {
  if (chatHideTimer) window.clearTimeout(chatHideTimer);
  chatHideTimer = window.setTimeout(() => {
    chatHideTimer = null;
    render();
  }, 700);
}

async function submitQuickChat(text: string): Promise<void> {
  chatInput.value = "";
  chatOverride = false;
  chatInput.blur();
  bubbleState = { visible: true, user: text, reply: "", phase: "sending" };
  renderBubble();
  render();
  const res = await api.openclaw.sendQuickChat(text);
  if (!res.ok) {
    bubbleState = { ...bubbleState, reply: res.error ?? "Could not send.", phase: "error" };
  } else if (bubbleState.phase === "sending") {
    bubbleState = { ...bubbleState, runId: res.runId, phase: "thinking" };
  } else {
    bubbleState.runId = res.runId;
  }
  renderBubble();
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  void submitQuickChat(text);
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    chatInput.value = "";
    chatOverride = false;
    chatInput.blur();
    render();
  }
});
chatInput.addEventListener("blur", () => scheduleChatHide());
chatInput.addEventListener("focus", () => render());

api.openclaw.onChatStatus((u: ChatStatusUpdate) => {
  if (!bubbleState.visible) return;
  if (bubbleState.runId && u.runId !== bubbleState.runId) return;
  switch (u.phase) {
    case "sent":
      if (bubbleState.phase === "sending") bubbleState.phase = "thinking";
      break;
    case "thinking":
      bubbleState.phase = "thinking";
      if (u.text) bubbleState.reply = u.text; // streamed partial reply
      break;
    case "working":
      bubbleState.phase = "working";
      break;
    case "reply":
      bubbleState.phase = "reply";
      bubbleState.reply = u.text || "Done.";
      break;
    case "error":
      bubbleState.phase = "error";
      bubbleState.reply = u.text ?? "OpenClaw ran into an error.";
      break;
    case "aborted":
      bubbleState.phase = "aborted";
      bubbleState.reply = bubbleState.reply || "Stopped.";
      break;
  }
  renderBubble();
});

// ---- speech bubble ---------------------------------------------------------------

function renderBubble(): void {
  bubble.hidden = !bubbleState.visible;
  if (!bubbleState.visible) {
    requestExtent();
    return;
  }
  const pending = bubbleState.phase === "sending" || bubbleState.phase === "thinking" || bubbleState.phase === "working";
  bubble.classList.toggle("err", bubbleState.phase === "error");
  bubble.classList.toggle("pending", pending && !bubbleState.reply);
  bubbleUser.textContent = bubbleState.user;
  const placeholder =
    bubbleState.phase === "sending" ? "Sending" : bubbleState.phase === "working" ? "Working on it" : bubbleState.phase === "thinking" ? "Thinking" : "";
  bubbleReply.textContent = bubbleState.reply || placeholder;
  const pillText = bubbleState.reply ? bubbleState.reply : placeholder ? `${placeholder}…` : "";
  bubblePill.textContent = pillText.replace(/\s+/g, " ").trim().slice(0, 80);
  requestExtent();
}

function toggleBubbleCollapsed(): void {
  if (!settings) return;
  const collapsed = !settings.bubble.collapsed;
  bubble.classList.toggle("collapsed", collapsed);
  settings.bubble.collapsed = collapsed;
  requestExtent();
  void api.settings.update({ bubble: { collapsed } });
}

bubble.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target === bubbleGrip) return;
  bubblePress = { x: e.clientX, y: e.clientY };
});
bubble.addEventListener("click", (e) => {
  if (e.target === bubbleGrip || !bubblePress) return;
  const moved = Math.hypot(e.clientX - bubblePress.x, e.clientY - bubblePress.y) > 4;
  bubblePress = null;
  // A drag inside the bubble is a text selection, not a toggle.
  if (moved || (window.getSelection()?.toString().length ?? 0) > 0) return;
  toggleBubbleCollapsed();
});

bubbleGrip.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !settings) return;
  e.preventDefault();
  e.stopPropagation();
  resizing = { startX: e.clientX, startY: e.clientY, w: settings.bubble.width, h: settings.bubble.maxHeight };
  bubble.classList.add("resizing");
});
document.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const w = clamp(resizing.w + (e.clientX - resizing.startX) * 2, BUBBLE_LIMITS.width.min, BUBBLE_LIMITS.width.max);
  const h = clamp(resizing.h + (e.clientY - resizing.startY), BUBBLE_LIMITS.maxHeight.min, BUBBLE_LIMITS.maxHeight.max);
  bubble.style.setProperty("--bubble-w", `${Math.round(w)}px`);
  bubble.style.setProperty("--bubble-h", `${Math.round(h)}px`);
});
function endResize(): void {
  if (!resizing || !settings) return;
  resizing = null;
  bubble.classList.remove("resizing");
  const width = parseInt(bubble.style.getPropertyValue("--bubble-w"), 10) || settings.bubble.width;
  const maxHeight = parseInt(bubble.style.getPropertyValue("--bubble-h"), 10) || settings.bubble.maxHeight;
  settings.bubble.width = width;
  settings.bubble.maxHeight = maxHeight;
  void api.settings.update({ bubble: { width, maxHeight } });
}
document.addEventListener("mouseup", () => endResize());

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ---- mouse interaction ------------------------------------------------------------

function setIgnore(ignore: boolean): void {
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  api.pet.setIgnoreMouse(ignore);
}

document.addEventListener("mousemove", (e) => {
  if (pressed || dragging || resizing) return;
  const overHit = Boolean((e.target as HTMLElement | null)?.closest?.(".hit"));
  // Transparent regions of the window must not swallow clicks meant for windows behind the pet.
  setIgnore(!overHit);
});
document.addEventListener("mouseleave", () => {
  if (!pressed && !dragging && !resizing) setIgnore(true);
});

charEl.addEventListener("mouseenter", () => {
  hovering = true;
  if (chatHideTimer) window.clearTimeout(chatHideTimer);
  render();
});
charEl.addEventListener("mouseleave", () => {
  hovering = false;
  scheduleChatHide();
  render();
});
chat.addEventListener("mouseenter", () => {
  if (chatHideTimer) window.clearTimeout(chatHideTimer);
});
chat.addEventListener("mouseleave", () => scheduleChatHide());

charEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  pressed = true;
  pressStart = { x: e.clientX, y: e.clientY };
  render();
});

document.addEventListener("mousemove", (e) => {
  if (!pressed || !pressStart) return;
  if (!dragging) {
    const dx = e.clientX - pressStart.x;
    const dy = e.clientY - pressStart.y;
    if (Math.hypot(dx, dy) < 4) return;
    dragging = true;
    // Offset of the cursor inside the window in CSS px == DIPs, which is what the main process needs.
    void api.pet.dragStart(pressStart.x, pressStart.y);
    render();
  }
});

async function endPress(): Promise<void> {
  if (!pressed) return;
  const wasDragging = dragging;
  pressed = false;
  dragging = false;
  pressStart = null;
  if (wasDragging) {
    await api.pet.dragEnd();
  } else {
    // Plain click toggles the chat so trackpad users are not stuck with hover-only.
    chatOverride = !chatOverride;
    if (chatOverride) {
      render();
      chatInput.focus();
    } else chatInput.blur();
  }
  render();
}
document.addEventListener("mouseup", () => void endPress());
window.addEventListener("blur", () => {
  if (pressed) void endPress();
  endResize();
});

api.pet.onDropped(() => {
  dropUntil = Date.now() + 900;
  render();
  window.setTimeout(render, 950);
});

charEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void api.app.openSettings();
});
charEl.addEventListener("dblclick", (e) => {
  e.preventDefault();
});

// Dev-only hook used by scripts/dev-run.mjs --send to exercise the real quick-chat path once.
api.pet.onDebugSubmit((text) => {
  if (typeof text === "string" && text.trim()) void submitQuickChat(text.trim());
});

// ---- bootstrap -----------------------------------------------------------------

async function loadCharacter(): Promise<void> {
  if (!settings) return;
  const all = await api.characters.list();
  setCharacter(all.find((c) => c.id === settings!.characterId) ?? all[0] ?? null);
}

/** Swapping to another character re-rolls the variant; edits to the same character keep the current one. */
function setCharacter(next: Character | null): void {
  if (next?.id !== character?.id) pick = null;
  character = next;
  currentSrc = "";
  render();
}

api.settings.onChange((s) => {
  const characterChanged = s.characterId !== settings?.characterId;
  applySettings(s);
  if (characterChanged) void loadCharacter();
});
api.characters.onChange((all) => {
  setCharacter(all.find((c) => c.id === settings?.characterId) ?? all[0] ?? null);
});
api.openclaw.onSnapshot((snap) => {
  snapshot = snap;
  render();
});
api.openclaw.onConnection((info) => {
  connection = info;
  snapshot = { ...snapshot, connection: info.status };
  render();
});

(async () => {
  applySettings(await api.settings.get());
  await loadCharacter();
  snapshot = await api.openclaw.getSnapshot();
  connection = await api.openclaw.getConnection();
  render();
  setIgnore(true);
})();
