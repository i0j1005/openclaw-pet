// Character library: one folder per character under userData/characters/<id>/
//
//   characters/
//     momo/
//       character.json      { "id": "momo", "name": "Momo", "assets": { "idle": "idle.svg", ... } }
//       idle.svg
//       thinking.png
//       …
//
// Users never need to touch this; the Settings UI does everything. The layout
// is intentionally trivial so packs can be shared by copying a folder.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { IMAGE_EXTENSIONS, PET_STATES, type Character, type PetState } from "../shared/types";

interface CharacterManifest {
  id: string;
  name: string;
  assets: Partial<Record<PetState, string>>; // file names relative to the character folder
  builtIn?: boolean;
}

export class CharacterLibrary {
  readonly root: string;

  constructor(userDataDir: string, private readonly bundledDir: string) {
    this.root = join(userDataDir, "characters");
    mkdirSync(this.root, { recursive: true });
    this.installBundled();
  }

  /** Copies bundled characters into userData on first run so everything is editable and uniform. */
  private installBundled(): void {
    if (!existsSync(this.bundledDir)) return;
    for (const entry of readdirSync(this.bundledDir)) {
      const src = join(this.bundledDir, entry);
      const dst = join(this.root, entry);
      if (!statSync(src).isDirectory() || existsSync(dst)) continue;
      mkdirSync(dst, { recursive: true });
      for (const file of readdirSync(src)) copyFileSync(join(src, file), join(dst, file));
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

  /** Creates a character from a name and one idle image. */
  add(name: string, idleImagePath: string): Character {
    const id = this.uniqueId(slugify(name) || "character");
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true });
    const manifest: CharacterManifest = { id, name: name.trim() || "Character", assets: {} };
    this.writeManifest(manifest);
    return this.setAsset(id, "idle", idleImagePath);
  }

  rename(id: string, name: string): Character {
    const m = this.manifest(id);
    m.name = name.trim() || m.name;
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
    this.writeManifest({ id: newId, name: `${src.name} copy`, assets: { ...src.assets } });
    return this.read(newId)!;
  }

  /** Copies an image into the character folder and points the state at it. */
  setAsset(id: string, state: PetState, sourcePath: string): Character {
    if (!PET_STATES.includes(state)) throw new Error(`unknown state ${state}`);
    const ext = extname(sourcePath).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Unsupported image type .${ext}. Use PNG, WebP, GIF, JPG or SVG.`);
    const m = this.manifest(id);
    const dir = join(this.root, id);
    // Unique file name per change so the renderer's cache never shows a stale image.
    const fileName = `${state}-${Date.now().toString(36)}.${ext}`;
    copyFileSync(sourcePath, join(dir, fileName));
    const old = m.assets[state];
    m.assets[state] = fileName;
    this.writeManifest(m);
    if (old && old !== fileName && existsSync(join(dir, old))) rmSync(join(dir, old), { force: true });
    return this.read(id)!;
  }

  /** Writes raw image bytes (drag & drop from the renderer) then assigns them. */
  setAssetFromBytes(id: string, state: PetState, fileName: string, bytes: Uint8Array): Character {
    const ext = extname(fileName).slice(1).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new Error(`Unsupported image type .${ext}. Use PNG, WebP, GIF, JPG or SVG.`);
    const tmp = join(this.root, id, `.incoming-${Date.now()}.${ext}`);
    writeFileSync(tmp, bytes);
    try {
      return this.setAsset(id, state, tmp);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  clearAsset(id: string, state: PetState): Character {
    if (state === "idle") throw new Error("The idle image is required.");
    const m = this.manifest(id);
    const file = m.assets[state];
    delete m.assets[state];
    this.writeManifest(m);
    if (file && existsSync(join(this.root, id, file))) rmSync(join(this.root, id, file), { force: true });
    return this.read(id)!;
  }

  /** Imports a folder that contains either a character.json or images named after states (idle.png, happy.gif…). */
  importFolder(folder: string): Character {
    const manifestPath = join(folder, "character.json");
    let name = basename(folder);
    let assets: Partial<Record<PetState, string>> = {};
    if (existsSync(manifestPath)) {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<CharacterManifest>;
      name = parsed.name || name;
      for (const [state, file] of Object.entries(parsed.assets ?? {})) {
        if (PET_STATES.includes(state as PetState) && typeof file === "string" && existsSync(join(folder, file))) {
          assets[state as PetState] = join(folder, file);
        }
      }
    } else {
      for (const file of readdirSync(folder)) {
        const state = basename(file, extname(file)).toLowerCase() as PetState;
        const ext = extname(file).slice(1).toLowerCase();
        if (PET_STATES.includes(state) && IMAGE_EXTENSIONS.includes(ext)) assets[state] = join(folder, file);
      }
    }
    if (!assets.idle) throw new Error("The folder needs at least an idle image (idle.png / idle.gif / …).");
    const id = this.uniqueId(slugify(name) || "character");
    mkdirSync(join(this.root, id), { recursive: true });
    this.writeManifest({ id, name, assets: {} });
    for (const [state, src] of Object.entries(assets)) this.setAsset(id, state as PetState, src);
    return this.read(id)!;
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
      const m = JSON.parse(readFileSync(file, "utf8")) as CharacterManifest;
      const assets: Character["assets"] = {};
      for (const [state, rel] of Object.entries(m.assets ?? {})) {
        if (typeof rel === "string" && existsSync(join(dir, rel))) assets[state as PetState] = join(dir, rel);
      }
      return { id: m.id || id, name: m.name || id, assets, builtIn: Boolean(m.builtIn) };
    } catch {
      return null;
    }
  }

  private manifest(id: string): CharacterManifest {
    const file = join(this.root, id, "character.json");
    if (!existsSync(file)) throw new Error(`character ${id} not found`);
    return JSON.parse(readFileSync(file, "utf8")) as CharacterManifest;
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
