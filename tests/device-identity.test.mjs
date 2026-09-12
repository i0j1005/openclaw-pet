import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDeviceAuthPayloadV3,
  loadOrCreateDeviceIdentity,
  publicKeyBase64Url,
  signPayload,
} from "../dist/tests/device-identity.js";

test("device id is sha256(raw public key) hex, like the gateway derives it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-"));
  const id = loadOrCreateDeviceIdentity(join(dir, "id.json"));
  const raw = Buffer.from(publicKeyBase64Url(id.publicKeyPem), "base64url");
  assert.equal(raw.length, 32);
  assert.equal(id.deviceId, createHash("sha256").update(raw).digest("hex"));
  // Reloading yields the same identity.
  assert.equal(loadOrCreateDeviceIdentity(join(dir, "id.json")).deviceId, id.deviceId);
});

test("signature verifies with the raw public key the way the gateway checks it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-"));
  const id = loadOrCreateDeviceIdentity(join(dir, "id.json"));
  const payload = buildDeviceAuthPayloadV3({
    deviceId: id.deviceId,
    clientId: "gateway-client",
    clientMode: "ui",
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    signedAtMs: 1737264000000,
    token: "tok",
    nonce: "nonce-1",
    platform: "macos",
    deviceFamily: "Mac",
  });
  assert.equal(payload, `v3|${id.deviceId}|gateway-client|ui|operator|operator.read,operator.write|1737264000000|tok|nonce-1|macos|mac`);
  const sig = Buffer.from(signPayload(id.privateKeyPem, payload), "base64url");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyBase64Url(id.publicKeyPem), "base64url")]), type: "spki", format: "der" });
  assert.equal(verify(null, Buffer.from(payload, "utf8"), key, sig), true);
});
