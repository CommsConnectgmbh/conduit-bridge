# Bridge release signing (Ed25519)

The bridge self-updates by pulling `bridge.tar.gz` from the app origin and running
the shipped code with `bypassPermissions`. A gzip-magic-bytes check only proves
the download is *a* gzip — not that **we** produced it. Anyone able to MITM the
origin (or the origin itself, if compromised) could otherwise ship arbitrary code.

To close that, each release tarball is signed with an **Ed25519 private key**, and
the running bridge verifies the detached signature (`bridge.tar.gz.sig`) against a
**pinned public key** before extracting or executing anything.

## 1. Generate the keypair (once)

Run this on a trusted, offline machine. It writes a PKCS8 private key and an SPKI
public key.

```js
// keygen.mjs — run: node keygen.mjs
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync("bridge_update_ed25519_private.pem",
  privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync("bridge_update_ed25519_public.pem",
  publicKey.export({ type: "spki", format: "pem" }));
console.log("wrote bridge_update_ed25519_private.pem and bridge_update_ed25519_public.pem");
```

- **Private key** → keep it OFFLINE or in a CI secret store (e.g. a GitHub Actions
  secret). NEVER commit it, and NEVER place it on the app origin / server that
  serves `bridge.tar.gz`. If it serves the tarball, it must not also hold the key.
- **Public key** → this is the pin. It is safe to publish.

## 2. Pin the public key on the bridge

The public key is compiled into `PINNED_UPDATE_PUBKEY` in `src/selfupdate.mjs`.
The pin always wins: `BRIDGE_UPDATE_PUBKEY` in the environment is refused, since
anything able to set the service environment would otherwise pick the signing
key. Rotating the key means first shipping a release with the new pin, signed
with the old key, and only then signing with the new key.

## Status

Live since 2.7.0, mandatory since 2.12.0. The private key lives offline on the
release machine (mode 600); it is not in any repo and never goes near the origin.

## 3. Build and sign every release

There are two channels on the origin:

- `/bridge/v3/bridge.tar.gz` (+ `.sig`): every 3.x bridge and every new
  install reads this one.
- `/bridge.tar.gz` (+ `.sig`): read by bridges older than 3.0. It stays frozen
  on the 3.0.0 stepping stone (flat `src/`, the 2.x dependency list, so the old
  updater never has to run npm). Rebuild it only if the stepping stone itself
  needs a fix.

```bash
# in the bridge directory; <public> is the directory the app origin serves
npm install --package-lock-only                       # lockfile matches package.json
node scripts/build-release.mjs --out <public>         # v3 channel
# once, for the cut-over from 2.x:
node scripts/build-release.mjs --out <public> --stepping-stone
node scripts/sign-release.mjs <public>/bridge/v3/bridge.tar.gz <private-key.pem>
node scripts/sign-release.mjs <public>/bridge.tar.gz <private-key.pem>
# Publish each tarball together with its .sig; a tarball published
# without its .sig is rejected by every install.
```

The build is reproducible (fixed mtimes from the commit, no owner, no extended
attributes), so the same commit always gives the same bytes and signature.

## 4. Enforcement

Every bridge from 2.12.0 on rejects an update with a missing or invalid
signature, or without a pinned key (`selfupdate_sig_rejected`). There is no
opt-out; to develop against unsigned builds, switch self-update off with
`CONDUIT_SELFUPDATE=0`. Installers (`install.sh`, `install.ps1`) verify the same
signature against the same pin before unpacking anything.
