#!/usr/bin/env node
// Sign a bridge release tarball with an Ed25519 private key, producing a detached
// base64 signature next to it (<tarball>.sig). The running bridge verifies this
// signature at self-update time against the PINNED public key
// (BRIDGE_UPDATE_PUBKEY). See RELEASE_SIGNING.md.
//
// Usage:
//   node scripts/sign-release.mjs <path/to/bridge.tar.gz> <path/to/ed25519_private.pem>
//
// SECURITY: the PRIVATE key must NEVER live on the app origin/server or in this
// repo. Keep it offline or in a CI secret; only the detached .sig and the public
// key ever ship.
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const [tarPath, keyPath] = process.argv.slice(2);
if (!tarPath || !keyPath) {
  console.error("usage: node scripts/sign-release.mjs <bridge.tar.gz> <ed25519_private.pem>");
  process.exit(2);
}

let data, key;
try {
  data = readFileSync(tarPath);
} catch (e) {
  console.error(`cannot read tarball ${tarPath}: ${e.message}`);
  process.exit(1);
}
try {
  key = createPrivateKey(readFileSync(keyPath, "utf8"));
} catch (e) {
  console.error(`cannot load private key ${keyPath}: ${e.message}`);
  process.exit(1);
}
if (key.asymmetricKeyType !== "ed25519") {
  console.error(`expected an Ed25519 private key, got ${key.asymmetricKeyType}`);
  process.exit(1);
}

const signature = sign(null, data, key);   // Ed25519 → algorithm arg is null
const outPath = tarPath + ".sig";
writeFileSync(outPath, signature.toString("base64") + "\n");
console.log(`wrote ${outPath} (${signature.length}-byte Ed25519 signature, base64)`);
