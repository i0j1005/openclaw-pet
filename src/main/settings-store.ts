// Tiny JSON settings store in the Electron userData directory.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "../shared/types";

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

  update(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.data, ...patch };
    if (patch.gateway) next.gateway = { ...this.data.gateway, ...patch.gateway };
    next.size = clamp(Math.round(next.size), 48, 640);
    next.reactionDurationMs = clamp(next.reactionDurationMs, 1000, 60_000);
    this.data = next;
    this.save();
    return this.get();
  }

  private load(): Settings {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return {
        ...structuredClone(DEFAULT_SETTINGS),
        ...parsed,
        gateway: { ...DEFAULT_SETTINGS.gateway, ...(parsed?.gateway ?? {}) },
      };
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

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}
