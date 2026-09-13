// Character library: one folder per character under userData/characters/<id>/
//
//   characters/
//     momo/
//       character.json      { "id": "momo", "name": "Momo", "assets": { "idle": ["idle.svg", "idle-2.png"], ... } }
//       idle.svg
//       idle-2.png
//       thinking.png
//       …
//
// Every state holds a list of variants; the pet picks one at random each time it enters the state.
// Older manifests with a bare file name per state are upgraded to one-element lists on first read.
// Users never need to touch this; the Settings UI does everything. The layout is intentionally
// trivial so packs can be shared by copying a folder.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { IMAGE_EXTENSIONS, PET_STATES, type Character, type PetState } from "../shared/types";

interface CharacterManifest {
  id: string;
  name: string;
  assets: Partial<Record<PetState, string[]>>; // file names relative to the character folder
  agentId?: string;
  builtIn?: boolean;
}

/** What may be on disk: the current shape, or the pre-variant shape with one file name per state. */
type RawManifest = Omit<Partial<CharacterManifest>, "assets"> & { assets?: Record<string, unknown> };

export class CharacterLibrary {
  readonly root: string;

  constructor(userDataDir: string, private readonly bundledDir: string) {
    this.root = join(userDataDir, "characters");
    mkdirSync(this.root, { recursive: true });
    this.installBundled();
  }

  /**
   * Copies bundled characters into userData on first run so everything is editable and uniform.
   * On later runs a built-in character only gains images for states it has no variant for yet (new
   * states added by an update); anything the user changed or cleared is left alone.
   */
  private installBundled(): void {
    if (!existsSync(this.bundledDir)) return;
    for (const entry of readdirSync(this.bundledDir)) {
      const src = join(this.bundledDir, entry);
      const dst = join(this.root, entry);
      if (!statSync(src).isDirectory()) continue;
      if (!existsSync(dst)) {
        mkdirSync(dst, { recursive: true });
        for (const file of readdirSync(src)) copyFileSync(join(src, file), join(dst, file));
        continue;
      }
      try {
        const bundled = normalizeManifest(JSON.parse(readFileSync(join(src, "character.json"), "utf8")), entry).manifest;
        const installed = this.manifest(entry);
        if (!installed.builtIn) continue;
        let changed = false;
        for (const [state, files] of Object.entries(bundled.assets)) {
          if (installed.assets[state as PetState]?.length) continue;
          const copied: string[] = [];
          for (const file of files ?? []) {
            if (existsSync(join(dst, file)) || !existsSync(join(src, file))) continue;
            copyFileSync(join(src, file), join(dst, file));
            copied.push(file);
          }
          if (copied.length) {
            installed.assets[state as PetState] = copied;
            changed = true;
          }
        }
        if (changed) this.writeManifest(installed);
      } catch {
        // A broken manifest is reported by list(); nothing to upgrade.
      }
    }
  }

  list(): Character[] {
    const out: Character[] = [];
    for (const id of readdirSync(this.root)) {
      const c = this.read(id);
      if (c) out.push(c);
    }
    out.sort((a, b) => (a.builtIn === b.builtIn ? a.name.localeCompare(b.name) : a.builtIn ? -1 : 1));
    return out;
  }

  get(id: string): Character | null {
    return this.read(id);
  }

  /** Creates a character from a name and one idle image, optionally bound to an OpenClaw agent. */
  add(name: string, idleImagePath: string, agentId?: string): Character {
    const id = this.uniqueId(slugify(name) || "character");
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true });
    const manifest: CharacterManifest = { id, name: name.trim() || "Character", assets: {} };
    this.writeManifest(manifest);
    const character = this.addAssetVariant(id, "idle", idleImagePath);
    return agentId?.trim() ? this.setAgent(id, agentId) : character;
  }

  rename(id: string, name: string): Character {
    const m = this.manifest(id);
    m.name = name.trim() || m.name;
    this.writeManifest(m);
    return this.read(id)!;
  }

  /**
   * Binds one character to one OpenClaw agent. An agent owns at most one character, so assigning it
   * here clears the same binding from another character. An empty id restores "any agent".
   */
  setAgent(id: string, agentId: string | null | undefined): Character {
    const m = this.manifest(id);
    const next = agentId?.trim() || undefined;
    if (next) {
      for (const otherId of readdirSync(this.root)) {
        if (otherId === id) continue;
        try {
          const other = this.manifest(otherId);
          if (other.agentId !== next) continue;
          delete other.agentId;
          this.writeManifest(other);
        } catch {
          // Broken character folders are ignored by list() too.
        }
      }
      m.agentId = next;
    } else delete m.agentId;
    this.writeManifest(m);
    return this.read(id)!;
  }

  delete(id: string): void {
    const dir = join(this.root, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  duplicate(id: string): Character {
    const src = this.manifest(id);
    const newId = this.uniqueId(`${id}-copy`);
    const dir = join(this.root, newId);
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(join(this.root, id))) {
      if (file === "character.json") continue;
      copyFileSync(join(this.root, id, file), join(dir, file));
    }
    const assets: CharacterManifest["assets"] = {};
    for (const [state, files] of Object.entries(src.assets)) assets[state as PetState] = [...(files ?? [])];
    // Agent assignments are one-to-one; a duplicate starts unassigned instead of stealing it.
    this.writeManifest({ id: newId, name: `${src.name} copy`, assets });
    return this.read(newId)!;
  }

  /** Copies an image into the character folder and appends it to the state's variants. */
  addAssetVariant(id: string, state: PetState, sourcePath: string): Character {
    if (!PET_STATES.includes(state)) throw new Error(`unknown state ${state}`);
    const ext = extname(sourcePath).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Unsupported image type .${ext}. Use PNG, WebP, GIF, JPG or SVG.`);
    const m = this.manifest(id);
    const dir = join(this.root, id);
    // Unique file name per addition so the renderer's cache never shows a stale image.
    const fileName = uniqueFileName(dir, state, ext);
    copyFileSync(sourcePath, join(dir, fileName));
    m.assets[state] = [...(m.assets[state] ?? []), fileName];
    this.writeManifest(m);
    return this.read(id)!;
  }

  /** Writes raw image bytes (drag & drop from the renderer) then appends them as a variant. */
  addAssetVariantFromBytes(id: string, state: PetState, fileName: string, bytes: Uint8Array): Character {
    const ext = extname(fileName).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Unsupported image type .${ext}. Use PNG, WebP, GIF, JPG or SVG.`);
    const tmp = join(this.root, id, `.incoming-${Date.now()}.${ext}`);
    writeFileSync(tmp, bytes);
    try {
      return this.addAssetVariant(id, state, tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  /** Removes one variant (by index) and its file. Idle always keeps at least one variant. */
  removeAssetVariant(id: string, state: PetState, index: number): Character {
    const m = this.manifest(id);
    const files = m.assets[state] ?? [];
    if (!Number.isInteger(index) || index < 0 || index >= files.length) throw new Error("That image is no longer there.");
    if (state === "idle" && files.length === 1) throw new Error("The idle state needs at least one image.");
    const [removed] = files.splice(index, 1);
    if (files.length) m.assets[state] = files;
    else delete m.assets[state];
    this.writeManifest(m);
    // The same file can be referenced twice (duplicates of a variant); only delete it when unreferenced.
    const stillUsed = Object.values(m.assets).some((list) => list?.includes(removed));
    if (!stillUsed && existsSync(join(this.root, id, removed))) rmSync(join(this.root, id, removed), { force: true });
    return this.read(id)!;
  }

  /** Replaces every variant of a state with one image (kept for the folder importer and old callers). */
  setAsset(id: string, state: PetState, sourcePath: string): Character {
    const m = this.manifest(id);
    const previous = m.assets[state] ?? [];
    const c = this.addAssetVariant(id, state, sourcePath);
    if (!previous.length) return c;
    let out = c;
    for (let i = previous.length - 1; i >= 0; i -= 1) out = this.removeAssetVariant(id, state, i);
    return out;
  }

  /** Drops every variant of a state (not allowed for idle). */
  clearAsset(id: string, state: PetState): Character {
    if (state === "idle") throw new Error("The idle image is required.");
    const m = this.manifest(id);
    const files = m.assets[state] ?? [];
    delete m.assets[state];
    this.writeManifest(m);
    for (const file of files) {
      const stillUsed = Object.values(m.assets).some((list) => list?.includes(file));
      if (!stillUsed && existsSync(join(this.root, id, file))) rmSync(join(this.root, id, file), { force: true });
    }
    return this.read(id)!;
  }

  /**
   * Imports a folder that contains either a character.json or images named after states. Bare names
   * (`idle.png`) and numbered variants (`idle-2.png`, `happy_3.gif`) are both accepted.
   */
  importFolder(folder: string): Character {
    const manifestPath = join(folder, "character.json");
    let name = basename(folder);
    let agentId: string | undefined;
    const assets: Partial<Record<PetState, string[]>> = {};
    if (existsSync(manifestPath)) {
      const { manifest } = normalizeManifest(JSON.parse(readFileSync(manifestPath, "utf8")), name);
      name = manifest.name || name;
      agentId = manifest.agentId;
      for (const [state, files] of Object.entries(manifest.assets)) {
        const found = (files ?? []).filter((f) => existsSync(join(folder, f))).map((f) => join(folder, f));
        if (found.length) assets[state as PetState] = found;
      }
    } else {
      for (const file of readdirSync(folder).sort()) {
        const stem = basename(file, extname(file)).toLowerCase();
        const state = stem.replace(/[-_ ]?\d+$/, "") as PetState;
        const ext = extname(file).slice(1).toLowerCase();
        if (PET_STATES.includes(state) && IMAGE_EXTENSIONS.includes(ext)) assets[state] = [...(assets[state] ?? []), join(folder, file)];
      }
    }
    if (!assets.idle?.length) throw new Error("The folder needs at least an idle image (idle.png / idle.gif / …).");
    const id = this.uniqueId(slugify(name) || "character");
    mkdirSync(join(this.root, id), { recursive: true });
    this.writeManifest({ id, name, assets: {} });
    for (const [state, sources] of Object.entries(assets)) {
      for (const src of sources ?? []) this.addAssetVariant(id, state as PetState, src);
    }
    return agentId ? this.setAgent(id, agentId) : this.read(id)!;
  }

  dir(id: string): string {
    return join(this.root, id);
  }

  // ---- internals -------------------------------------------------------------

  private read(id: string): Character | null {
    const dir = join(this.root, id);
    const file = join(dir, "character.json");
    if (!existsSync(file)) return null;
    try {
      const m = this.manifest(id);
      const assets: Character["assets"] = {};
      for (const [state, files] of Object.entries(m.assets)) {
        const present = (files ?? []).filter((rel) => existsSync(join(dir, rel))).map((rel) => join(dir, rel));
        if (present.length) assets[state as PetState] = present;
      }
      return { id: m.id || id, name: m.name || id, assets, builtIn: Boolean(m.builtIn), ...(m.agentId ? { agentId: m.agentId } : {}) };
    } catch {
      return null;
    }
  }

  /** Loads a manifest, upgrading the old one-file-per-state shape in place (written back once). */
  private manifest(id: string): CharacterManifest {
    const file = join(this.root, id, "character.json");
    if (!existsSync(file)) throw new Error(`character ${id} not found`);
    const { manifest, migrated } = normalizeManifest(JSON.parse(readFileSync(file, "utf8")), id);
    if (migrated) this.writeManifest(manifest);
    return manifest;
  }

  private writeManifest(m: CharacterManifest): void {
    writeFileSync(join(this.root, m.id, "character.json"), JSON.stringify(m, null, 2));
  }

  private uniqueId(base: string): string {
    let id = base;
    let n = 2;
    while (existsSync(join(this.root, id))) id = `${base}-${n++}`;
    return id;
  }
}

/**
 * Brings any manifest to the current shape: `assets[state]` is always a list of file names. A bare
 * string (pre-variant manifests) becomes a one-element list; unknown states and junk are dropped.
 * `migrated` says whether anything had to change, so callers can rewrite the file once.
 */
export function normalizeManifest(raw: unknown, fallbackId: string): { manifest: CharacterManifest; migrated: boolean } {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawManifest;
  let migrated = false;
  const assets: CharacterManifest["assets"] = {};
  for (const [state, value] of Object.entries(r.assets ?? {})) {
    if (!PET_STATES.includes(state as PetState)) {
      migrated = true;
      continue;
    }
    if (typeof value === "string") {
      migrated = true;
      if (value) assets[state as PetState] = [value];
      continue;
    }
    if (Array.isArray(value)) {
      const files = value.filter((v): v is string => typeof v === "string" && v.length > 0);
      if (files.length !== value.length) migrated = true;
      if (files.length) assets[state as PetState] = files;
      else migrated = true;
      continue;
    }
    migrated = true;
  }
  const manifest: CharacterManifest = {
    id: typeof r.id === "string" && r.id ? r.id : fallbackId,
    name: typeof r.name === "string" && r.name ? r.name : fallbackId,
    assets,
  };
  if (typeof r.agentId === "string" && r.agentId.trim()) manifest.agentId = r.agentId.trim();
  if (r.builtIn) manifest.builtIn = true;
  return { manifest, migrated };
}

function uniqueFileName(dir: string, state: PetState, ext: string): string {
  let name = `${state}-${Date.now().toString(36)}.${ext}`;
  let n = 2;
  while (existsSync(join(dir, name))) name = `${state}-${Date.now().toString(36)}-${n++}.${ext}`;
  return name;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
