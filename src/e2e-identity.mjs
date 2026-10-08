// The bridge's long-term X25519 identity.
//
// Created on first start, stored as 32 raw bytes in a file only the bridge's
// user can read, and never sent anywhere. Devices pin the public half when
// they pair; replacing this file therefore means re-pairing every device,
// which is the intended way to rotate it.

import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync, closeSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { importPrivateKey } from "./e2e-noise.mjs";

/** Load the identity, creating it atomically if it does not exist yet. */
export async function loadIdentity(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync("x25519");
    const raw = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, raw); } finally { closeSync(fd); }
    renameSync(tmp, path);
  }
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) {
    // Someone loosened the permissions; tighten them rather than run with a
    // key other local users could read.
    chmodSync(path, 0o600);
  }
  const raw = readFileSync(path);
  if (raw.length !== 32) throw new Error(`identity file ${path} is corrupt (${raw.length} bytes)`);
  return importPrivateKey(new Uint8Array(raw), false);
}
