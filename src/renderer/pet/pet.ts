// Pet window renderer: character display, mouse interaction, quick chat.
// Everything visual is decided here or in the main process; nothing here talks to a model.
import {
  STATE_FALLBACKS,
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
const chatStatus = $<HTMLDivElement>("chatStatus");

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
let statusTimer: number | null = null;
let currentSrc = "";

const BADGES: Partial<Record<PetState, string>> = {
  thinking: "…",
  working: "⚙",
  happy: "♥",
  error: "!",
  question: "?",
  offline: "z",
};

// ---- state resolution ---------------------------------------------------------

function displayState(): PetState {
  const now = Date.now();
  if (dragging) return "drag";
  if (pressed) return "pressed";
  if (dropUntil > now) return "drop";
  if (hovering) return "hover";
  if (snapshot.reaction) return snapshot.reaction;
  if (snapshot.activity === "working") return "working";
  if (snapshot.activity === "thinking") return "thinking";
  if (settings?.openclawEnabled && snapshot.connection !== "connected") return "offline";
  return "idle";
}

function resolveAsset(state: PetState): { src: string | null; fallback: boolean } {
  if (!character) return { src: null, fallback: true };
  const direct = character.assets[state];
  if (direct) return { src: fileUrl(direct), fallback: false };
  for (const fb of STATE_FALLBACKS[state]) {
    const p = character.assets[fb];
    if (p) return { src: fileUrl(p), fallback: true };
  }
  return { src: null, fallback: true };
}

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
  stage.className = [
    `state-${state}`,
    fallback ? "fallback" : "",
    `conn-${snapshot.connection}`,
    settings?.openclawEnabled ? "show-dot" : "",
    fallback && BADGES[state] ? "badge" : "",
    chatOpen() ? "chat-open" : "",
  ]
    .filter(Boolean)
    .join(" ");
  badge.textContent = BADGES[state] ?? "";
}

function applySettings(s: Settings): void {
  settings = s;
  charEl.style.setProperty("--size", `${s.size}px`);
  chatInput.disabled = !s.openclawEnabled;
  chatInput.placeholder = s.openclawEnabled ? "Ask OpenClaw…" : "OpenClaw is off";
  render();
}

// ---- chat bar -------------------------------------------------------------------

function chatOpen(): boolean {
  if (!settings) return false;
  if (chatOverride) return true;
  if (!settings.hoverChatEnabled) return false;
  return hovering || document.activeElement === chatInput || chatInput.value.trim().length > 0 || chatStatus.classList.contains("show");
}

function scheduleChatHide(): void {
  if (chatHideTimer) window.clearTimeout(chatHideTimer);
  chatHideTimer = window.setTimeout(() => {
    chatHideTimer = null;
    render();
  }, 700);
}

function showStatus(text: string, opts: { error?: boolean; sticky?: boolean } = {}): void {
  chatStatus.textContent = text;
  chatStatus.classList.toggle("err", Boolean(opts.error));
  chatStatus.classList.add("show");
  if (statusTimer) window.clearTimeout(statusTimer);
  statusTimer = null;
  if (!opts.sticky) {
    statusTimer = window.setTimeout(() => {
      chatStatus.classList.remove("show");
      statusTimer = null;
      render();
    }, 9000);
  }
  render();
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = "";
  showStatus("Sending…", { sticky: true });
  const res = await api.openclaw.sendQuickChat(text);
  if (!res.ok) showStatus(res.error ?? "Could not send.", { error: true });
  else showStatus("Sent. Thinking…", { sticky: true });
});
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    chatInput.value = "";
    chatOverride = false;
    chatInput.blur();
    chatStatus.classList.remove("show");
    render();
  }
});
chatInput.addEventListener("blur", () => scheduleChatHide());
chatInput.addEventListener("focus", () => render());

api.openclaw.onChatStatus((u: ChatStatusUpdate) => {
  switch (u.phase) {
    case "sent":
      showStatus("Sent. Thinking…", { sticky: true });
      break;
    case "thinking":
      showStatus("Thinking…", { sticky: true });
      break;
    case "working":
      showStatus("Working on it…", { sticky: true });
      break;
    case "reply":
      showStatus(u.text ? u.text : "Done.");
      break;
    case "error":
      showStatus(u.text ?? "OpenClaw ran into an error.", { error: true });
      break;
    case "aborted":
      showStatus("Stopped.");
      break;
  }
});

// ---- mouse interaction ------------------------------------------------------------

function setIgnore(ignore: boolean): void {
  if (ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  api.pet.setIgnoreMouse(ignore);
}

document.addEventListener("mousemove", (e) => {
  if (pressed || dragging) return;
  const overHit = Boolean((e.target as HTMLElement | null)?.closest?.(".hit"));
  // Transparent regions of the window must not swallow clicks meant for windows behind the pet.
  setIgnore(!overHit || (!chatOpen() && Boolean((e.target as HTMLElement | null)?.closest?.("#chat"))));
});
document.addEventListener("mouseleave", () => {
  if (!pressed && !dragging) setIgnore(true);
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

// ---- bootstrap -----------------------------------------------------------------

async function loadCharacter(): Promise<void> {
  if (!settings) return;
  const all = await api.characters.list();
  character = all.find((c) => c.id === settings!.characterId) ?? all[0] ?? null;
  currentSrc = "";
  render();
}

api.settings.onChange((s) => {
  const characterChanged = s.characterId !== settings?.characterId;
  applySettings(s);
  if (characterChanged) void loadCharacter();
});
api.characters.onChange((all) => {
  character = all.find((c) => c.id === settings?.characterId) ?? all[0] ?? null;
  currentSrc = "";
  render();
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
