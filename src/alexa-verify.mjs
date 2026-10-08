// Verifies that a request really comes from Amazon's Alexa service.
//
// Amazon signs every skill request; the rules are in "Host a Custom Skill as a
// Web Service" (developer.amazon.com/docs/custom-skills). With this check in
// the bridge, Amazon can call the bridge directly through the tunnel and our
// cloud no longer needs any secret that opens the bridge.
//
//   1. SignatureCertChainUrl: https, host s3.amazonaws.com, path under
//      /echo.api/, port 443 if given (after normalising "..").
//   2. Certificate chain from that URL: leaf valid now, its subject alt names
//      contain echo-api.amazon.com, every link signed by the next, the last one
//      issued by a CA in the trust store.
//   3. Signature-256 header: RSA-SHA256 over the raw request body, verified
//      with the leaf's public key.
//   4. request.timestamp within 150 seconds of now.
// Fail closed on everything; cache certificate chains by URL.

import { X509Certificate, createVerify } from "node:crypto";
import { rootCertificates } from "node:tls";

export const MAX_SKEW_MS = 150_000;
const CERT_HOST = "s3.amazonaws.com";
const SAN_REQUIRED = "echo-api.amazon.com";
const CHAIN_CACHE_MAX = 16;

export class AlexaVerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AlexaVerifyError";
  }
}

/** Validate and normalise the certificate URL; returns the URL to fetch. */
export function checkCertUrl(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw new AlexaVerifyError("bad certificate URL"); }
  if (u.protocol !== "https:") throw new AlexaVerifyError("certificate URL is not https");
  if (u.hostname.toLowerCase() !== CERT_HOST) throw new AlexaVerifyError("certificate URL host is not s3.amazonaws.com");
  if (u.port && u.port !== "443") throw new AlexaVerifyError("certificate URL port is not 443");
  // URL() already resolved ".." segments; the path is case-sensitive.
  if (!u.pathname.startsWith("/echo.api/")) throw new AlexaVerifyError("certificate URL path is not under /echo.api/");
  return u.toString();
}

function splitPem(pem) {
  const certs = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!certs.length) throw new AlexaVerifyError("no certificates in chain");
  return certs.map((c) => new X509Certificate(c));
}

/**
 * @param {{ fetchImpl?: typeof fetch, roots?: string[], now?: () => number }} opts
 */
export function createAlexaVerifier({ fetchImpl = fetch, roots = rootCertificates, now = Date.now } = {}) {
  const trust = roots.map((pem) => new X509Certificate(pem));
  const cache = new Map();

  function checkChain(chain) {
    const t = now();
    const leaf = chain[0];
    for (const c of chain) {
      if (t < Date.parse(c.validFrom) || t > Date.parse(c.validTo)) throw new AlexaVerifyError("certificate not valid now");
    }
    const sans = String(leaf.subjectAltName || "").split(/,\s*/).map((s) => s.replace(/^DNS:/, "").toLowerCase());
    if (!sans.includes(SAN_REQUIRED)) throw new AlexaVerifyError("certificate is not for echo-api.amazon.com");
    for (let i = 0; i < chain.length - 1; i++) {
      if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
        throw new AlexaVerifyError("certificate chain is broken");
      }
    }
    const last = chain[chain.length - 1];
    const anchored = trust.some((root) => (last.fingerprint256 === root.fingerprint256)
      || (last.checkIssued(root) && last.verify(root.publicKey)));
    if (!anchored) throw new AlexaVerifyError("certificate chain does not end in a trusted root");
    return leaf;
  }

  async function chainFor(url) {
    const hit = cache.get(url);
    if (hit && now() < Date.parse(hit[0].validTo)) return hit;
    const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new AlexaVerifyError(`certificate download failed (${res.status})`);
    const text = await res.text();
    if (text.length > 64 * 1024) throw new AlexaVerifyError("certificate chain too large");
    const chain = splitPem(text);
    checkChain(chain);
    if (cache.size >= CHAIN_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(url, chain);
    return chain;
  }

  /**
   * @param {{ certUrl: string, signature256: string, body: Buffer | string }} req
   * @returns {Promise<object>} the parsed request body
   */
  return async function verify({ certUrl, signature256, body }) {
    const url = checkCertUrl(certUrl);
    if (!signature256) throw new AlexaVerifyError("missing Signature-256");
    const chain = await chainFor(url);
    const leaf = checkChain(chain);
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const v = createVerify("RSA-SHA256");
    v.update(raw);
    if (!v.verify(leaf.publicKey, String(signature256), "base64")) throw new AlexaVerifyError("signature does not match");
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); } catch { throw new AlexaVerifyError("body is not JSON"); }
    const ts = Date.parse(payload?.request?.timestamp || "");
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > MAX_SKEW_MS) throw new AlexaVerifyError("request timestamp out of range");
    return payload;
  };
}
