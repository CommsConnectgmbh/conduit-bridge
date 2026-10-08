// Speech models: catalog, download, verification.
//
// Every downloadable file is pinned here with its size and SHA-256. This file
// ships inside the signed bridge tarball, so the bridge release signature is
// the only trust root: the model host can serve bytes, but it cannot make the
// bridge accept a file we did not pin. There are no archives to unpack and no
// path in a download decides where something lands on disk.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MODELS_DIR = process.env.CONDUIT_MODELS_DIR || join(homedir(), ".conduit", "models");
// Release assets of the public bridge repository: one release per model id,
// so a file is at <base>/<model id>/<file name>. The host is not trusted with
// anything; every byte is checked against the pins below.
export const MODELS_BASE_URL = (process.env.CONDUIT_MODELS_URL || "https://github.com/CommsConnectgmbh/conduit-bridge/releases/download").replace(/\/+$/, "");

// Keep this much free space after a download, so a full disk never becomes
// the bridge's problem (its SQLite history lives on the same volume).
const DISK_RESERVE_BYTES = 1024 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * @typedef {{ name: string, size: number, sha256: string }} ModelFile
 * @typedef {{
 *   id: string, kind: "stt" | "tts" | "engine", langs: string[], title: string,
 *   license: string, attribution: string, files: ModelFile[],
 *   requires?: string[], voices?: { id: string, name: string }[],
 * }} Model
 */

const f = (name, size, sha256) => ({ name, size, sha256 });

/**
 * @type {Model[]}
 * "engine" packages are not offered on their own; they come with the models
 * that need them. Voices are listed in the order of their voices.bin.
 */
export const CATALOG = [
  {
    id: "espeak-ng-1.52.0",
    kind: "engine",
    langs: ["de", "en"],
    title: "espeak-ng 1.52.0 (WebAssembly)",
    license: "GPL-3.0-or-later",
    attribution: "espeak-ng, © the espeak-ng contributors, built from tag 1.52.0 without changes",
    files: [
      f("espeak-ng.wasm", 318139, "3e4fca392a3499c0f594b51ae9154723e5c3785f060bdda0f11371162abd01b1"),
      f("espeak-ng-data.tar", 10721280, "3b485f254e7cc0df5a700e1a8514cd34cb6210e0101390e6a43ef98ed5692acd"),
    ],
  },
  {
    id: "stt-parakeet-tdt-0.6b-v3",
    kind: "stt",
    langs: ["bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "hr", "hu", "it", "lt", "lv", "mt", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "uk"],
    title: "Parakeet TDT 0.6B v3",
    license: "CC-BY-4.0",
    attribution: "NVIDIA parakeet-tdt-0.6b-v3, CC-BY-4.0; int8 ONNX conversion by k2-fsa/sherpa-onnx",
    files: [
      f("encoder.int8.onnx", 652184281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
      f("decoder.int8.onnx", 11845275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
      f("joiner.int8.onnx", 6355277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
      f("tokens.txt", 93939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
    ],
  },
  {
    id: "tts-de-thorsten",
    kind: "tts",
    langs: ["de"],
    title: "Thorsten (Kokoro, Deutsch)",
    license: "Apache-2.0",
    attribution: "Thorsten-Voice/Kokoro by Thorsten Müller, Apache-2.0, trained on the CC0 Thorsten-Voice dataset; Kokoro-82M by hexgrad, Apache-2.0",
    requires: ["espeak-ng-1.52.0"],
    voices: [{ id: "thorsten", name: "Thorsten" }],
    files: [
      f("model.onnx", 325568796, "24ffa73cbe70cd2f2ac2bb0de5b517a57d692095b5e00eb62450191497cb7def"),
      f("voices.bin", 522240, "3195c20800f7684494a94b64f30928b9b22ffab1aa46175c784c93ba084e44c5"),
      f("vocab.json", 1144, "70abefbe8a1c8865e43e0a43bbdc25b91a33e4aa053479d443ccf23e20a59e5d"),
    ],
  },
  {
    id: "tts-en-kokoro-v1.0",
    kind: "tts",
    langs: ["en"],
    title: "Kokoro v1.0 (American English)",
    license: "Apache-2.0",
    attribution: "Kokoro-82M v1.0 by hexgrad, Apache-2.0; ONNX export by thewh1teagle/kokoro-onnx (MIT); pronunciation data from misaki (Apache-2.0) and spaCy en_core_web_sm (MIT)",
    requires: ["espeak-ng-1.52.0"],
    voices: [
      { id: "af_heart", name: "Heart" },
      { id: "af_bella", name: "Bella" },
      { id: "af_nicole", name: "Nicole" },
      { id: "af_sarah", name: "Sarah" },
      { id: "am_michael", name: "Michael" },
      { id: "am_fenrir", name: "Fenrir" },
      { id: "am_puck", name: "Puck" },
    ],
    files: [
      f("model.onnx", 325560556, "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11"),
      f("voices.bin", 3655680, "232ed8f8c0d62d289bf0e9f3c135ab22ea85e0bcdf6d869d0f22ca420dd74e62"),
      f("vocab.json", 1144, "70abefbe8a1c8865e43e0a43bbdc25b91a33e4aa053479d443ccf23e20a59e5d"),
      f("misaki-us-gold.json", 3000469, "4ffcb5b83593534261bef0298ca34dd88497696a29e0f65da2b3324013f63ad4"),
      f("misaki-us-silver.json", 3099517, "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475"),
      f("spacy-pyunicode.json", 124431, "b64fd93c12159e220d189660f404ae1c511b1874aeb0b3b038a389f1328f6652"),
      f("spacy-tokenizer.json", 270660, "2fbf02c33b430028c150f0304fe9149e42590b4ca53643fd3802b17ca0cb558e"),
      f("spacy-tagger.json", 3190, "ae6d58ad5f050b46ce873ee8f881090d7878a49b0f60bf45440ec927a2935a74"),
      f("spacy-tagger.bin", 6282056, "0f884fe5841b110c7457a3dd46c78236ad91dc6d028d4ebc37bb9f4c93c22bf3"),
    ],
  },
];

export function getModel(id) {
  return CATALOG.find((m) => m.id === id) || null;
}

function assertSafe(model) {
  if (!SAFE_NAME.test(model.id)) throw new Error(`unsafe model id ${model.id}`);
  for (const f of model.files) {
    if (!SAFE_NAME.test(f.name)) throw new Error(`unsafe file name ${f.name}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0) {
      throw new Error(`bad pin for ${model.id}/${f.name}`);
    }
  }
}

export const modelDir = (id) => join(MODELS_DIR, id);
export const modelPath = (id, name) => join(MODELS_DIR, id, name);

/** A model counts as installed only when every file is present with its pinned size. */
export function isInstalled(model) {
  return model.files.every((f) => {
    try { return statSync(modelPath(model.id, f.name)).size === f.size; } catch { return false; }
  });
}

/** Bytes still to fetch for a model (partial downloads count as fetched). */
export function missingBytes(model) {
  let n = 0;
  for (const f of model.files) {
    const p = modelPath(model.id, f.name);
    if (existsSync(p)) continue;
    let have = 0;
    try { have = statSync(p + ".part").size; } catch { /* none */ }
    n += Math.max(0, f.size - have);
  }
  return n;
}

function freeBytes(dir) {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

async function hashFile(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

/**
 * Download one model. Resumes partial files with a Range request, verifies the
 * SHA-256 of every file before it is moved into place, and reports progress.
 * @param {Model} model
 * @param {{ signal?: AbortSignal, onProgress?: (p: { done: number, total: number }) => void, fetchImpl?: typeof fetch }} opts
 */
export async function downloadModel(model, { signal, onProgress, fetchImpl = fetch } = {}) {
  assertSafe(model);
  const dir = modelDir(model.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const total = model.files.reduce((n, f) => n + f.size, 0);
  const need = missingBytes(model);
  if (need > 0 && freeBytes(dir) - need < DISK_RESERVE_BYTES) {
    throw new Error(`not enough disk space: ${Math.ceil(need / 1e6)} MB needed plus 1 GB reserve`);
  }

  let done = total - need;
  onProgress?.({ done, total });
  for (const f of model.files) {
    const final = modelPath(model.id, f.name);
    if (existsSync(final) && statSync(final).size === f.size) continue;
    const part = final + ".part";
    let have = 0;
    try { have = statSync(part).size; } catch { /* fresh */ }
    if (have > f.size) { rmSync(part, { force: true }); have = 0; }

    if (have < f.size) {
      const url = `${MODELS_BASE_URL}/${model.id}/${f.name}`;
      const res = await fetchImpl(url, { signal, headers: have ? { range: `bytes=${have}-` } : {} });
      if (have && res.status !== 206) {
        // The host ignored the range: start over rather than append a full copy.
        if (res.status !== 200) throw new Error(`${f.name}: HTTP ${res.status}`);
        rmSync(part, { force: true });
        done -= have;
        have = 0;
      } else if (!have && res.status !== 200) {
        throw new Error(`${f.name}: HTTP ${res.status}`);
      }
      const out = createWriteStream(part, { flags: have ? "a" : "w", mode: 0o600 });
      try {
        let written = have;
        for await (const chunk of res.body) {
          written += chunk.length;
          if (written > f.size) throw new Error(`${f.name}: larger than pinned size`);
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          done += chunk.length;
          onProgress?.({ done, total });
        }
      } finally {
        await new Promise((r) => out.end(r));
      }
    }

    const size = statSync(part).size;
    if (size !== f.size) throw new Error(`${f.name}: got ${size} bytes, expected ${f.size}`);
    const digest = await hashFile(part);
    if (digest !== f.sha256) {
      rmSync(part, { force: true });
      throw new Error(`${f.name}: checksum mismatch, download discarded`);
    }
    renameSync(part, final);
  }
  onProgress?.({ done: total, total });
}

/** Remove a model and any partial download. */
export function removeModel(model) {
  assertSafe(model);
  rmSync(modelDir(model.id), { recursive: true, force: true });
}
