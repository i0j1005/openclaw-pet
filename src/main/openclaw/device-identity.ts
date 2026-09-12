// Per-install Ed25519 device identity, as required by the Gateway handshake.
//
// The Gateway derives the device id from the raw public key (sha256 hex) and
// verifies a v3 payload signature bound to the connect challenge nonce. On a
// loopback connection the Gateway auto-approves pairing, so the user never
// sees a pairing prompt.
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
}

export function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as DeviceIdentity;
      if (parsed.publicKeyPem && parsed.privateKeyPem) {
        // Always recompute the id so a hand-edited file cannot desync.
        parsed.deviceId = deviceIdFromPublicKeyPem(parsed.publicKeyPem);
        return parsed;
      }
    } catch {
      // fall through and regenerate
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const identity: DeviceIdentity = {
    deviceId: deviceIdFromPublicKeyPem(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
    createdAt: Date.now(),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}

/** Raw 32-byte Ed25519 public key from a SPKI PEM. */
export function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }) as Buffer;
  // SPKI for Ed25519 is a fixed 12-byte prefix followed by the 32-byte key.
  return der.subarray(der.length - 32);
}

export function publicKeyBase64Url(publicKeyPem: string): string {
  return rawPublicKey(publicKeyPem).toString("base64url");
}

export function deviceIdFromPublicKeyPem(publicKeyPem: string): string {
  return createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex");
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
}

function normalizeMeta(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/** Mirrors `buildDeviceAuthPayloadV3` in @openclaw/gateway-client. */
export function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeMeta(params.platform),
    normalizeMeta(params.deviceFamily),
  ].join("|");
}
