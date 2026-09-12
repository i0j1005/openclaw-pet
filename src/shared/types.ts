// Types shared between the main process, preload and renderers.

/** Visual states a character can have. Only `idle` is required; everything else falls back. */
export const PET_STATES = [
  "idle",
  "hover",
  "pressed",
  "drag",
  "drop",
  "thinking",
  "working",
  "happy",
  "error",
  "question",
  "offline",
] as const;
export type PetState = (typeof PET_STATES)[number];

/** Fallback chain used when a character has no asset for a state. */
export const STATE_FALLBACKS: Record<PetState, PetState[]> = {
  idle: [],
  hover: ["idle"],
  pressed: ["hover", "idle"],
  drag: ["pressed", "hover", "idle"],
  drop: ["happy", "idle"],
  thinking: ["working", "idle"],
  working: ["thinking", "idle"],
  happy: ["idle"],
  error: ["idle"],
  question: ["thinking", "idle"],
  offline: ["idle"],
};

export const STATE_LABELS: Record<PetState, string> = {
  idle: "Idle",
  hover: "Hover",
  pressed: "Pressed",
  drag: "Dragging",
  drop: "Drop",
  thinking: "Thinking",
  working: "Working",
  happy: "Happy",
  error: "Error",
  question: "Question",
  offline: "Offline",
};

export const STATE_HINTS: Record<PetState, string> = {
  idle: "Default look. The only required image.",
  hover: "Mouse is over the character.",
  pressed: "Mouse button is held down.",
  drag: "Being dragged around the screen.",
  drop: "Short reaction right after being dropped.",
  thinking: "OpenClaw is generating a reply.",
  working: "OpenClaw is running a tool (files, shell, web…).",
  happy: "The last reply reported success.",
  error: "The last run failed.",
  question: "OpenClaw is asking you something.",
  offline: "OpenClaw is off or unreachable.",
};

export interface Character {
  id: string;
  name: string;
  /** Absolute paths per state. Missing states use the fallback chain. */
  assets: Partial<Record<PetState, string>>;
  builtIn?: boolean;
}

export type ConnectionStatus =
  | "off"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** Short, user-facing explanation when status is `error` (no stack traces, no ports). */
  hint?: string;
  /** Extra technical detail shown behind a "Details" toggle in Settings. */
  detail?: string;
  gatewayUrl?: string;
  /** Session the quick chat currently targets. */
  targetSession?: { key: string; label: string; agentId?: string };
}

export type ActivityState = "idle" | "thinking" | "working";
export type ReactionState = "happy" | "error" | "question" | null;

/** What the pet should currently look like, derived entirely locally. */
export interface PetSnapshot {
  activity: ActivityState;
  reaction: ReactionState;
  connection: ConnectionStatus;
  /** Latest assistant reply text (truncated) for the quick chat status line. */
  lastReply?: string;
  lastReplyAt?: number;
}

export interface GatewaySettings {
  mode: "auto" | "manual";
  url?: string;
  token?: string;
  password?: string;
}

export interface Settings {
  openclawEnabled: boolean;
  launchAtLogin: boolean;
  alwaysOnTop: boolean;
  characterId: string;
  size: number;
  reactionsEnabled: boolean;
  hoverChatEnabled: boolean;
  /** How long happy/error/question reactions stay visible, in ms. */
  reactionDurationMs: number;
  position?: { x: number; y: number };
  gateway: GatewaySettings;
}

export const DEFAULT_SETTINGS: Settings = {
  openclawEnabled: true,
  launchAtLogin: false,
  alwaysOnTop: true,
  characterId: "momo",
  size: 160,
  reactionsEnabled: true,
  hoverChatEnabled: true,
  reactionDurationMs: 7000,
  gateway: { mode: "auto" },
};

export interface QuickChatResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

export interface ChatStatusUpdate {
  runId: string;
  phase: "sent" | "thinking" | "working" | "reply" | "error" | "aborted";
  text?: string;
}

export const IMAGE_EXTENSIONS = ["png", "webp", "gif", "jpg", "jpeg", "svg", "apng", "avif"];

/** IPC channel names (single source of truth). */
export const IPC = {
  // renderer -> main (invoke)
  getSettings: "settings:get",
  updateSettings: "settings:update",
  getCharacters: "characters:list",
  addCharacter: "characters:add",
  renameCharacter: "characters:rename",
  deleteCharacter: "characters:delete",
  setCharacterAsset: "characters:setAsset",
  setCharacterAssetFromPath: "characters:setAssetFromPath",
  clearCharacterAsset: "characters:clearAsset",
  duplicateCharacter: "characters:duplicate",
  revealCharacter: "characters:reveal",
  importCharacterFolder: "characters:importFolder",
  pickImage: "dialog:pickImage",
  getConnection: "connection:get",
  getSnapshot: "pet:getSnapshot",
  sendQuickChat: "chat:send",
  dragStart: "pet:dragStart",
  dragEnd: "pet:dragEnd",
  setIgnoreMouse: "pet:setIgnoreMouse",
  openSettings: "app:openSettings",
  quit: "app:quit",
  openExternal: "app:openExternal",
  // main -> renderer (send)
  snapshot: "pet:snapshot",
  settingsChanged: "settings:changed",
  charactersChanged: "characters:changed",
  connectionChanged: "connection:changed",
  chatStatus: "chat:status",
  windowDropped: "pet:dropped",
} as const;
