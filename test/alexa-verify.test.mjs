// Alexa request verification against a locally generated CA chain.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";
import { createAlexaVerifier, checkCertUrl, AlexaVerifyError } from "../src/alexa-verify.mjs";

const URL_OK = "https://s3.amazonaws.com/echo.api/echo-api-cert.pem";
let d, rootPem, chainPem, leafKey, otherChainPem;

function ssl(...args) { execFileSync("openssl", args, { cwd: d, stdio: "ignore" }); }

before(() => {
  d = mkdtempSync(join(tmpdir(), "alexa-ca-"));
  writeFileSync(join(d, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  writeFileSync(join(d, "leaf.ext"), "basicConstraints=CA:FALSE\nsubjectAltName=DNS:echo-api.amazon.com\n");
  writeFileSync(join(d, "bad.ext"), "basicConstraints=CA:FALSE\nsubjectAltName=DNS:evil.example\n");
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.pem", "-days", "30", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "int.key", "-out", "int.csr", "-subj", "/CN=Test Intermediate");
  ssl("x509", "-req", "-in", "int.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-out", "int.pem", "-days", "30", "-extfile", "ca.ext");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=echo-api.amazon.com");
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "30", "-extfile", "leaf.ext");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "bad.key", "-out", "bad.csr", "-subj", "/CN=evil.example");
  ssl("x509", "-req", "-in", "bad.csr", "-CA", "int.pem", "-CAkey", "int.key", "-CAcreateserial", "-out", "bad.pem", "-days", "30", "-extfile", "bad.ext");
  rootPem = readFileSync(join(d, "root.pem"), "utf8");
  chainPem = readFileSync(join(d, "leaf.pem"), "utf8") + readFileSync(join(d, "int.pem"), "utf8");
  otherChainPem = readFileSync(join(d, "bad.pem"), "utf8") + readFileSync(join(d, "int.pem"), "utf8");
  leafKey = readFileSync(join(d, "leaf.key"), "utf8");
});

const sign = (body, key = leafKey) => { const s = createSign("RSA-SHA256"); s.update(body); return s.sign(key, "base64"); };
const body = (ts = new Date().toISOString()) => JSON.stringify({ version: "1.0", request: { type: "LaunchRequest", timestamp: ts } });
const verifier = (pem, roots) => createAlexaVerifier({ fetchImpl: async () => new Response(pem), roots: roots ?? [rootPem] });

test("certificate URL rules", () => {
  assert.equal(checkCertUrl(URL_OK), URL_OK);
  assert.equal(checkCertUrl("https://S3.amazonaws.com:443/echo.api/../echo.api/x.pem"), "https://s3.amazonaws.com/echo.api/x.pem");
  for (const bad of ["http://s3.amazonaws.com/echo.api/x.pem", "https://s3.amazonaws.com/EcHo.aPi/x.pem", "https://s3.amazonaws.com:563/echo.api/x.pem",
    "https://s3.amazonaws.com/invalid.path/x.pem", "https://evil.com/echo.api/x.pem", "https://s3.amazonaws.com/echo.api/../invalid.path/x.pem", ""]) {
    assert.throws(() => checkCertUrl(bad), AlexaVerifyError, bad);
  }
});

test("valid request passes", async () => {
  const b = body();
  const payload = await verifier(chainPem)({ certUrl: URL_OK, signature256: sign(b), body: b });
  assert.equal(payload.request.type, "LaunchRequest");
});

test("tampered body, wrong key, missing signature fail", async () => {
  const b = body();
  const v = verifier(chainPem);
  await assert.rejects(v({ certUrl: URL_OK, signature256: sign(b), body: b.replace("Launch", "Intent") }), /signature/);
  await assert.rejects(v({ certUrl: URL_OK, signature256: sign(b, readFileSync(join(d, "int.key"), "utf8")), body: b }), /signature/);
  await assert.rejects(v({ certUrl: URL_OK, signature256: "", body: b }), /Signature-256/);
});

test("old timestamp fails", async () => {
  const b = body(new Date(Date.now() - 151_000).toISOString());
  await assert.rejects(verifier(chainPem)({ certUrl: URL_OK, signature256: sign(b), body: b }), /timestamp/);
});

test("certificate without echo-api SAN fails", async () => {
  const b = body();
  await assert.rejects(verifier(otherChainPem)({ certUrl: URL_OK, signature256: sign(b, readFileSync(join(d, "bad.key"), "utf8")), body: b }), /echo-api/);
});

test("chain that does not end in a trusted root fails", async () => {
  const b = body();
  await assert.rejects(verifier(chainPem, [readFileSync(join(d, "leaf.pem"), "utf8")])({ certUrl: URL_OK, signature256: sign(b), body: b }), /trusted root/);
});

test("real system roots do not trust the test chain", async () => {
  const b = body();
  await assert.rejects(createAlexaVerifier({ fetchImpl: async () => new Response(chainPem) })({ certUrl: URL_OK, signature256: sign(b), body: b }), /trusted root/);
});

test("the skill answers only its owner's Alexa account", async () => {
  const { handleAlexaRequest } = await import("../src/alexa.mjs");
  const base = (user) => ({
    session: { application: { applicationId: "skill-1" }, user: { userId: user } },
    request: { type: "LaunchRequest", requestId: "r" },
  });
  const deps = { skillId: "skill-1", userId: "owner", ask: async () => ({ code: 200, body: { ok: true, text: "x" } }), log: () => {} };
  assert.equal((await handleAlexaRequest(base("owner"), deps)).body.response.shouldEndSession, false);
  const other = await handleAlexaRequest(base("someone-else"), deps);
  assert.equal(other.body.response.shouldEndSession, true);
  assert.match(other.body.response.outputSpeech.text, /anderen Konto/);
  assert.equal((await handleAlexaRequest(base("owner"), { ...deps, userId: "" })).status, 503);
});
