import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CharacterLibrary, normalizeManifest } from "../dist/tests/characters.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "pet-chars-"));
  const images = join(dir, "images");
  mkdirSync(images);
  const img = (name) => {
    const p = join(images, name);
    writeFileSync(p, PNG);
    return p;
  };
  return { dir, img };
}

function bundled(dir, manifest, files) {
  const b = join(dir, "bundled", manifest.id);
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "character.json"), JSON.stringify(manifest));
  for (const f of files) writeFileSync(join(b, f), PNG);
  return join(dir, "bundled");
}

test("normalizeManifest upgrades bare strings to one-element lists and reports it", () => {
  const { manifest, migrated } = normalizeManifest({ id: "x", name: "X", assets: { idle: "idle.png", happy: ["a.png", "b.png"], bogus: "z.png", sad: 3 } }, "x");
  assert.equal(migrated, true);
  assert.deepEqual(manifest.assets, { idle: ["idle.png"], happy: ["a.png", "b.png"] });
  const again = normalizeManifest(manifest, "x");
  assert.equal(again.migrated, false);
  assert.deepEqual(again.manifest, manifest);
});

test("an old one-file-per-state manifest is migrated on read and rewritten once", () => {
  const { dir } = scratch();
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  const cdir = join(lib.root, "old");
  mkdirSync(cdir);
  writeFileSync(join(cdir, "idle.png"), PNG);
  writeFileSync(join(cdir, "happy.png"), PNG);
  writeFileSync(join(cdir, "character.json"), JSON.stringify({ id: "old", name: "Old", assets: { idle: "idle.png", happy: "happy.png" } }));
  const c = lib.get("old");
  assert.deepEqual(c.assets, { idle: [join(cdir, "idle.png")], happy: [join(cdir, "happy.png")] });
  const onDisk = JSON.parse(readFileSync(join(cdir, "character.json"), "utf8"));
  assert.deepEqual(onDisk.assets, { idle: ["idle.png"], happy: ["happy.png"] });
});

test("add / addAssetVariant / removeAssetVariant keep the file list and folder in sync", () => {
  const { dir, img } = scratch();
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  let c = lib.add("Kiki", img("first.png"), "coder");
  assert.equal(c.id, "kiki");
  assert.equal(c.agentId, "coder");
  assert.equal(c.assets.idle.length, 1);
  c = lib.addAssetVariant("kiki", "idle", img("second.png"));
  c = lib.addAssetVariant("kiki", "idle", img("third.png"));
  c = lib.addAssetVariant("kiki", "happy", img("h.png"));
  assert.equal(c.assets.idle.length, 3);
  assert.equal(c.assets.happy.length, 1);
  const files = () => readdirSync(lib.dir("kiki")).filter((f) => f !== "character.json");
  assert.equal(files().length, 4);
  const middle = basename(c.assets.idle[1]);
  c = lib.removeAssetVariant("kiki", "idle", 1);
  assert.equal(c.assets.idle.length, 2);
  assert.equal(files().includes(middle), false);
  c = lib.removeAssetVariant("kiki", "happy", 0);
  assert.equal("happy" in c.assets, false);
  assert.equal(files().length, 2);
  assert.throws(() => lib.removeAssetVariant("kiki", "idle", 5), /no longer there/);
  assert.throws(() => lib.removeAssetVariant("kiki", "happy", 0), /no longer there/);
});

test("idle always keeps at least one variant", () => {
  const { dir, img } = scratch();
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  lib.add("Solo", img("a.png"));
  assert.throws(() => lib.removeAssetVariant("solo", "idle", 0), /at least one image/);
  assert.throws(() => lib.clearAsset("solo", "idle"), /required/);
  lib.addAssetVariant("solo", "idle", img("b.png"));
  assert.equal(lib.removeAssetVariant("solo", "idle", 0).assets.idle.length, 1);
});

test("setAgent stores and clears the target agent", () => {
  const { dir, img } = scratch();
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  lib.add("Nina", img("a.png"));
  assert.equal(lib.get("nina").agentId, undefined);
  assert.equal(lib.setAgent("nina", "research").agentId, "research");
  assert.equal(JSON.parse(readFileSync(join(lib.dir("nina"), "character.json"), "utf8")).agentId, "research");
  assert.equal(lib.setAgent("nina", "").agentId, undefined);
  assert.equal("agentId" in JSON.parse(readFileSync(join(lib.dir("nina"), "character.json"), "utf8")), false);
});

test("assigning an agent moves it to one character", () => {
  const { dir, img } = scratch();
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  lib.add("Nina", img("a.png"), "research");
  lib.add("Momo", img("b.png"));
  assert.equal(lib.setAgent("momo", "research").agentId, "research");
  assert.equal(lib.get("nina").agentId, undefined);
});

test("duplicate copies every variant but starts without an agent", () => {
  const { dir, img } = scratch();
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  lib.add("Dup", img("a.png"), "coder");
  lib.addAssetVariant("dup", "idle", img("b.png"));
  const copy = lib.duplicate("dup");
  assert.equal(copy.id, "dup-copy");
  assert.equal(copy.agentId, undefined);
  assert.equal(lib.get("dup").agentId, "coder");
  assert.equal(copy.assets.idle.length, 2);
  assert.ok(copy.assets.idle.every((p) => p.startsWith(lib.dir("dup-copy"))));
});

test("importFolder collects numbered variants from a folder of images", () => {
  const { dir } = scratch();
  const folder = join(dir, "pack");
  mkdirSync(folder);
  for (const f of ["idle.png", "idle-2.png", "idle_3.png", "happy.gif", "readme.txt"]) writeFileSync(join(folder, f), PNG);
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  const c = lib.importFolder(folder);
  assert.equal(c.assets.idle.length, 3);
  assert.equal(c.assets.happy.length, 1);
  assert.equal(c.name, "pack");
});

test("importFolder reads both old and new manifests", () => {
  const { dir } = scratch();
  const oldPack = join(dir, "oldpack");
  mkdirSync(oldPack);
  writeFileSync(join(oldPack, "i.png"), PNG);
  writeFileSync(join(oldPack, "character.json"), JSON.stringify({ name: "Old Pack", assets: { idle: "i.png" } }));
  const newPack = join(dir, "newpack");
  mkdirSync(newPack);
  for (const f of ["a.png", "b.png"]) writeFileSync(join(newPack, f), PNG);
  writeFileSync(join(newPack, "character.json"), JSON.stringify({ name: "New Pack", agentId: "coder", assets: { idle: ["a.png", "b.png", "missing.png"] } }));
  const lib = new CharacterLibrary(dir, join(dir, "no-bundled"));
  const a = lib.importFolder(oldPack);
  assert.equal(a.assets.idle.length, 1);
  const b = lib.importFolder(newPack);
  assert.equal(b.assets.idle.length, 2);
  assert.equal(b.agentId, "coder");
});

test("installBundled fills in only states without variants and understands both manifest shapes", () => {
  const { dir } = scratch();
  const bundledDir = bundled(dir, { id: "momo", name: "Momo", builtIn: true, assets: { idle: ["idle.png"], happy: ["happy.png"], sad: ["sad.png"] } }, ["idle.png", "happy.png", "sad.png"]);
  // First run: copied verbatim.
  let lib = new CharacterLibrary(dir, bundledDir);
  let momo = lib.get("momo");
  assert.equal(momo.assets.sad.length, 1);
  // The user replaced happy with two variants of their own and cleared sad; an old-shape manifest is simulated.
  const cdir = lib.dir("momo");
  writeFileSync(join(cdir, "mine1.png"), PNG);
  writeFileSync(join(cdir, "mine2.png"), PNG);
  writeFileSync(join(cdir, "character.json"), JSON.stringify({ id: "momo", name: "Momo", builtIn: true, assets: { idle: "idle.png", happy: ["mine1.png", "mine2.png"] } }));
  // A newer bundled version adds a "tired" image.
  bundled(dir, { id: "momo", name: "Momo", builtIn: true, assets: { idle: ["idle.png"], happy: ["happy.png"], sad: ["sad.png"], tired: ["tired.png"] } }, ["idle.png", "happy.png", "sad.png", "tired.png"]);
  lib = new CharacterLibrary(dir, bundledDir);
  momo = lib.get("momo");
  assert.deepEqual(momo.assets.happy.map((p) => basename(p)), ["mine1.png", "mine2.png"]);
  assert.deepEqual(momo.assets.tired.map((p) => basename(p)), ["tired.png"]);
  // sad has no manifest entry but its file is still in the folder (the user cleared it): not resurrected.
  assert.equal(existsSync(join(cdir, "sad.png")), true);
  assert.equal("sad" in momo.assets, false);
  assert.deepEqual(momo.assets.idle.map((p) => basename(p)), ["idle.png"]);
  // The old-shape manifest was rewritten in the new shape.
  assert.deepEqual(JSON.parse(readFileSync(join(cdir, "character.json"), "utf8")).assets.idle, ["idle.png"]);
});
