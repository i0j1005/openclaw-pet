// Tiny JSON settings store in the Electron userData directory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AMBIENT_LIMITS,
  AMBIENT_STATES,
  BUBBLE_LIMITS,
  DEFAULT_SETTINGS,
  HOLD_LIMITS,
  REACTION_STATES,
  SETTINGS_VERSION,
  type AmbientMotionSetting,
  type Settings,
} from "../shared/types";

/** Deep partial for the record-shaped keys so callers can patch one state at a time. */
export type SettingsPatch = Partial<Omit<Settings, "ambientMotion" | "reactionHoldMs" | "bubble" | "gateway">> & {
  ambientMotion?: Partial<Record<keyof Settings["ambientMotion"], Partial<AmbientMotionSetting>>>;
  reactionHoldMs?: Partial<Settings["reactionHoldMs"]>;
  bubble?: Partial<Settings["bubble"]>;
  gateway?: Partial<Settings["gateway"]>;
};

export class SettingsStore {
  private data: Settings;
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "settings.json");
    this.data = this.load();
  }

  get(): Settings {
    return structuredClone(this.data);
  }

  update(patch: SettingsPatch): Settings {
    this.data = normalizeSettings(mergeSettings(this.data, patch));
    this.save();
    return this.get();
  }

  private load(): Settings {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return migrateSettings(parsed);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * Loads any older settings.json: unknown keys are dropped, missing keys get defaults, and the
 * v1 keys `ambientMotionEnabled` / `reactionDurationMs` are folded into the per-state records.
 */
export function migrateSettings(raw: unknown): Settings {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const version = typeof parsed.settingsVersion === "number" ? parsed.settingsVersion : 1;
  const patch: SettingsPatch = { ...parsed };
  delete (patch as any).ambientMotionEnabled;
  delete (patch as any).reactionDurationMs;
  if (version < 2) {
    if (parsed.ambientMotionEnabled === true) {
      patch.ambientMotion = Object.fromEntries(AMBIENT_STATES.map((s) => [s, { enabled: true }])) as SettingsPatch["ambientMotion"];
    }
    if (typeof parsed.reactionDurationMs === "number") {
      const ms = parsed.reactionDurationMs;
      patch.reactionHoldMs = { happy: ms, error: ms, question: ms };
    }
  }
  patch.settingsVersion = SETTINGS_VERSION;
  return normalizeSettings(mergeSettings(structuredClone(DEFAULT_SETTINGS), patch));
}

function mergeSettings(base: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...base, ...(patch as Partial<Settings>) };
  next.gateway = { ...base.gateway, ...(patch.gateway ?? {}) };
  next.bubble = { ...base.bubble, ...(patch.bubble ?? {}) };
  next.reactionHoldMs = { ...base.reactionHoldMs, ...(patch.reactionHoldMs ?? {}) };
  next.ambientMotion = { ...base.ambientMotion };
  for (const state of AMBIENT_STATES) {
    next.ambientMotion[state] = { ...base.ambientMotion[state], ...(patch.ambientMotion?.[state] ?? {}) };
  }
  return next;
}

function normalizeSettings(s: Settings): Settings {
  s.settingsVersion = SETTINGS_VERSION;
  s.petVisible = Boolean(s.petVisible);
  s.size = clamp(Math.round(s.size), 48, 640);
  for (const state of AMBIENT_STATES) {
    const m = s.ambientMotion[state];
    m.enabled = Boolean(m.enabled);
    m.intensity = clamp(Number(m.intensity), AMBIENT_LIMITS.intensity.min, AMBIENT_LIMITS.intensity.max, 1);
    m.speed = clamp(Number(m.speed), AMBIENT_LIMITS.speed.min, AMBIENT_LIMITS.speed.max, 1);
  }
  for (const r of REACTION_STATES) {
    s.reactionHoldMs[r] = clamp(Number(s.reactionHoldMs[r]), HOLD_LIMITS.min, HOLD_LIMITS.max, DEFAULT_SETTINGS.reactionHoldMs[r]);
  }
  s.bubble.collapsed = Boolean(s.bubble.collapsed);
  s.bubble.width = clamp(Math.round(Number(s.bubble.width)), BUBBLE_LIMITS.width.min, BUBBLE_LIMITS.width.max, DEFAULT_SETTINGS.bubble.width);
  s.bubble.maxHeight = clamp(Math.round(Number(s.bubble.maxHeight)), BUBBLE_LIMITS.maxHeight.min, BUBBLE_LIMITS.maxHeight.max, DEFAULT_SETTINGS.bubble.maxHeight);
  return s;
}

function clamp(n: number, min: number, max: number, fallback = min): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
