import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLocalGateway, resolveConfigPath } from "../dist/tests/discovery.js";

test("falls back to the default port when no config exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-"));
  const found = discoverLocalGateway({ OPENCLAW_STATE_DIR: dir });
  assert.equal(found.url, "ws://127.0.0.1:18789");
  assert.equal(found.authMode, "unknown");
});

test("reads port and token from a JSON5 config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-"));
  writeFileSync(
    join(dir, "openclaw.json"),
    `{
      // comment
      gateway: { port: 19999, auth: { mode: "token", token: "secret-123", }, },
    }`,
  );
  const found = discoverLocalGateway({ OPENCLAW_STATE_DIR: dir });
  assert.equal(found.url, "ws://127.0.0.1:19999");
  assert.equal(found.token, "secret-123");
  assert.equal(found.authMode, "token");
});

test("SecretRef tokens produce a note instead of a token", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-"));
  writeFileSync(join(dir, "openclaw.json"), JSON.stringify({ gateway: { auth: { mode: "token", token: { source: "env", provider: "default", id: "X" } } } }));
  const found = discoverLocalGateway({ OPENCLAW_STATE_DIR: dir });
  assert.equal(found.token, undefined);
  assert.match(found.note ?? "", /secret reference/);
});

test("OPENCLAW_CONFIG_PATH wins", () => {
  assert.equal(resolveConfigPath({ OPENCLAW_CONFIG_PATH: "/tmp/x.json", OPENCLAW_STATE_DIR: "/nope" }), "/tmp/x.json");
});
