import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, migrateSettings } from "../dist/tests/settings-store.js";

test("a v1 settings.json loads with the new defaults filled in", () => {
  const s = migrateSettings({ openclawEnabled: false, size: 200, ambientMotionEnabled: false, reactionDurationMs: 5000 });
  assert.equal(s.settingsVersion, 2);
  assert.equal(s.openclawEnabled, false);
  assert.equal(s.size, 200);
  assert.equal(s.ambientMotion.idle.enabled, false);
  assert.equal(s.ambientMotion.thinking.intensity, 1);
  assert.equal(s.reactionHoldMs.happy, 5000);
  assert.equal(s.reactionHoldMs.error, 5000);
  assert.equal(s.reactionHoldMs.shy, 4000); // new reaction keeps its own default
  assert.deepEqual(s.bubble, { collapsed: false, width: 260, maxHeight: 160 });
  assert.equal("ambientMotionEnabled" in s, false);
  assert.equal("reactionDurationMs" in s, false);
});

test("v1 ambientMotionEnabled=true turns every state on", () => {
  const s = migrateSettings({ ambientMotionEnabled: true });
  for (const state of ["idle", "thinking", "working", "question"]) assert.equal(s.ambientMotion[state].enabled, true);
});

test("an empty or corrupt file yields defaults", () => {
  const s = migrateSettings(null);
  assert.equal(s.settingsVersion, 2);
  assert.equal(s.characterId, "momo");
});

test("values are clamped and partial record patches merge", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-settings-"));
  const store = new SettingsStore(dir);
  let s = store.update({ ambientMotion: { thinking: { enabled: true, intensity: 99 } } });
  assert.equal(s.ambientMotion.thinking.enabled, true);
  assert.equal(s.ambientMotion.thinking.intensity, 2.5);
  assert.equal(s.ambientMotion.thinking.speed, 1);
  assert.equal(s.ambientMotion.idle.enabled, false);
  s = store.update({ reactionHoldMs: { error: 100 }, bubble: { width: 5000 } });
  assert.equal(s.reactionHoldMs.error, 1000);
  assert.equal(s.reactionHoldMs.question, 12000);
  assert.equal(s.bubble.width, 640);
  // persisted and reloadable
  const again = new SettingsStore(dir).get();
  assert.equal(again.ambientMotion.thinking.enabled, true);
  assert.equal(again.bubble.width, 640);
  // the file never carries the legacy keys
  const json = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(json.settingsVersion, 2);
  assert.equal("reactionDurationMs" in json, false);
});

test("an on-disk v1 file is migrated on load", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-settings-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ reactionDurationMs: 3000, ambientMotionEnabled: true, size: 120 }));
  const s = new SettingsStore(dir).get();
  assert.equal(s.size, 120);
  assert.equal(s.reactionHoldMs.question, 3000);
  assert.equal(s.ambientMotion.question.enabled, true);
});
