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
  "praise",
  "encourage",
  "shy",
  "sad",
  "tired",
  "error",
  "question",
  "offline",
] as const;
export type PetState = (typeof PET_STATES)[number];

/** Reactions derived from the last reply (a subset of PetState). */
export const REACTION_STATES = ["happy", "praise", "encourage", "shy", "sad", "tired", "error", "question"] as const;
export type ReactionKind = (typeof REACTION_STATES)[number];
export type ReactionState = ReactionKind | null;

/** States that can have looping ambient motion. */
export const AMBIENT_STATES = ["idle", "thinking", "working", "question"] as const;
export type AmbientState = (typeof AMBIENT_STATES)[number];

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
  praise: ["happy", "idle"],
  encourage: ["happy", "idle"],
  shy: ["happy", "idle"],
  sad: ["idle"],
  tired: ["sad", "idle"],
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
  praise: "Praise",
  encourage: "Encourage",
  shy: "Shy",
  sad: "Sad",
  tired: "Tired",
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
  praise: "The reply praises you (\"great idea\", \"잘하셨어요\").",
  encourage: "The reply cheers you on (\"you can do it\", \"화이팅\").",
  shy: "The reply is bashful or embarrassed (\"부끄럽네요\").",
  sad: "The reply delivers bad or sad news.",
  tired: "The reply sounds worn out (\"phew\", \"힘들었어요\").",
  error: "The last run failed.",
  question: "OpenClaw is asking you something.",
  offline: "OpenClaw is off or unreachable.",
};

export interface Character {
  id: string;
  name: string;
  /**
   * Absolute paths per state, one or more variants each. The pet picks one at random every time it
   * enters the state. States with no variants use the fallback chain.
   */
  assets: Partial<Record<PetState, string[]>>;
  /** OpenClaw agent this character talks to. Unset = any agent, most recent session (the default). */
  agentId?: string;
  builtIn?: boolean;
}

/** One row of the gateway's `agents.list` roster, reduced to what the pickers need. */
export interface AgentOption {
  id: string;
  name: string;
  emoji?: string;
  isDefault?: boolean;
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

/** Looping motion for one state. `intensity` and `speed` are multipliers (1 = the built-in motion). */
export interface AmbientMotionSetting {
  enabled: boolean;
  intensity: number;
  speed: number;
}

export interface BubbleSettings {
  /** Bubble collapsed to a small pill. */
  collapsed: boolean;
  /** Bubble width in px. */
  width: number;
  /** Maximum bubble height in px; longer replies scroll inside. */
  maxHeight: number;
}

export interface Settings {
  /** Bumped whenever keys change shape; the store migrates older files. */
  settingsVersion: number;
  openclawEnabled: boolean;
  /** Whether the desktop character window is visible. The menu-bar icon always remains available. */
  petVisible: boolean;
  launchAtLogin: boolean;
  alwaysOnTop: boolean;
  characterId: string;
  size: number;
  reactionsEnabled: boolean;
  hoverChatEnabled: boolean;
  /** Per-state looping motion. Idle is off by default: it costs compositor time on an always-on-top window. */
  ambientMotion: Record<AmbientState, AmbientMotionSetting>;
  /** How long each reaction stays visible, in ms. */
  reactionHoldMs: Record<ReactionKind, number>;
  bubble: BubbleSettings;
  position?: { x: number; y: number };
  gateway: GatewaySettings;
}

export const SETTINGS_VERSION = 3;

export const AMBIENT_LIMITS = { intensity: { min: 0.2, max: 2.5 }, speed: { min: 0.25, max: 3 } } as const;
export const BUBBLE_LIMITS = { width: { min: 160, max: 640 }, maxHeight: { min: 48, max: 640 } } as const;
export const HOLD_LIMITS = { min: 1000, max: 60_000 } as const;

export const DEFAULT_SETTINGS: Settings = {
  settingsVersion: SETTINGS_VERSION,
  openclawEnabled: true,
  petVisible: true,
  launchAtLogin: false,
  alwaysOnTop: true,
  characterId: "momo",
  size: 160,
  reactionsEnabled: true,
  hoverChatEnabled: true,
  ambientMotion: {
    idle: { enabled: false, intensity: 1, speed: 1 },
    thinking: { enabled: false, intensity: 1, speed: 1 },
    working: { enabled: false, intensity: 1, speed: 1 },
    question: { enabled: false, intensity: 1, speed: 1 },
  },
  reactionHoldMs: {
    happy: 7000,
    praise: 7000,
    encourage: 7000,
    shy: 4000,
    sad: 8000,
    tired: 8000,
    error: 10_000,
    question: 12_000,
  },
  bubble: { collapsed: false, width: 260, maxHeight: 160 },
  gateway: { mode: "auto" },
};

export interface QuickChatResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

/** Recent OpenClaw conversation shown in the quick-chat target popover. */
export interface QuickChatSessionOption {
  key: string;
  label: string;
  agentId?: string;
  lastInteractionAt?: number;
  selected?: boolean;
}

export interface QuickChatActionResult {
  ok: boolean;
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
  setCharacterAgent: "characters:setAgent",
  addCharacterAssetVariant: "characters:addAssetVariant",
  addCharacterAssetVariantFromBytes: "characters:addAssetVariantFromBytes",
  removeCharacterAssetVariant: "characters:removeAssetVariant",
  duplicateCharacter: "characters:duplicate",
  revealCharacter: "characters:reveal",
  importCharacterFolder: "characters:importFolder",
  pickImage: "dialog:pickImage",
  getConnection: "connection:get",
  listAgents: "connection:listAgents",
  listSessions: "connection:listSessions",
  setTargetSession: "connection:setTargetSession",
  getSnapshot: "pet:getSnapshot",
  sendQuickChat: "chat:send",
  abortQuickChat: "chat:abort",
  dragStart: "pet:dragStart",
  dragEnd: "pet:dragEnd",
  setIgnoreMouse: "pet:setIgnoreMouse",
  setExtent: "pet:setExtent",
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
  debugSubmit: "pet:debugSubmit",
} as const;
