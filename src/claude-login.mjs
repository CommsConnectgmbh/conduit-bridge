// Claude sign-in watch and phone sign-in (bridge 3.7.0).
//
// Two sign-ins live on a Mac running the bridge:
//   - the bridge's own turns: whatever the bridge process has (a long-lived
//     CLAUDE_CODE_OAUTH_TOKEN, an API key, or the stored claude.ai login);
//   - the stored claude.ai login ("/login" in a terminal): used by terminal
//     sessions, Remote Control and, through them, connectors. It runs out
//     after a while and is renewed in a browser.
// The bridge already asks `claude auth status` for the first one (claudeReady).
// This module watches the stored login as well, tells the owner before and
// when it runs out, and lets the owner sign in again from the phone:
// `claude auth login` prints a sign-in link and then reads the code the
// browser shows from stdin. The bridge passes the link to the app and the
// code back, nothing else. No token ever leaves the CLI.
//
// It also hears about failed Claude turns (noteTurnFailure): a turn that the
// CLI rejected for its sign-in, or one that was accepted and then never
// started (see warm.mjs firstReplyMs), triggers a fresh check and an alert.
//
// Alerts go through `notify({ kind, title, text })` (phase4: Web Push and the
// owner's deliver command). Each distinct problem is told once, kept in
// bridge_kv so a restart does not repeat it; a recovery clears it.

import { spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const CHECK_INTERVAL_MS = 30 * 60_000;
export const EXPIRY_WARN_MS = 3 * 24 * 3600_000;
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const CODE_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 40_000;
const KV_KEY = "claude_login_alert";

/** The CLI's own words when a turn failed for its sign-in. */
export const AUTH_ERROR_RE = /(\/login\b|please run .{0,20}login|not (signed|logged) in|oauth token (has )?expired|token (has )?expired|invalid api key|authentication_error|invalid bearer|\b401\b|unauthori[sz]ed)/i;

/** The only sign-in pages the link may point at. */
// Taken only once whitespace follows it: the link can arrive split over
// several chunks, and an early match would cut off its OAuth parameters.
const LOGIN_URL_RE = /(https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s"'<>]{10,2000})\s/;
/** What a pasted code may look like (code#state, URL-safe characters). */
const CODE_RE = /^[A-Za-z0-9._~#-]{8,1024}$/;

/** env for the stored login: without the variables that would override it. */
export function storedLoginEnv(env) {
  const e = { ...env, FORCE_COLOR: "0", NO_COLOR: "1" };
  delete e.CLAUDE_CODE_OAUTH_TOKEN;
  delete e.ANTHROPIC_API_KEY;
  delete e.ANTHROPIC_AUTH_TOKEN;
  // Never open a browser on the Mac for a sign-in started from the phone.
  e.BROWSER = "/usr/bin/true";
  return e;
}

/** Parse `claude auth status --json`. Returns null when it is not that. */
export function parseAuthStatus(out) {
  let st = null;
  try { st = JSON.parse(String(out || "").trim()); } catch { return null; }
  if (!st || typeof st.loggedIn !== "boolean") return null;
  const exp = typeof st.loginExpiresAt === "string" ? Date.parse(st.loginExpiresAt) : NaN;
  return {
    loggedIn: st.loggedIn,
    method: typeof st.authMethod === "string" ? st.authMethod.slice(0, 40) : null,
    expiresAt: Number.isFinite(exp) ? exp : null,
  };
}

/**
 * The verdict on the stored login.
 *   ok | expiring | expired | signed_out | unknown
 */
export function judge(st, now) {
  if (!st) return "unknown";
  if (!st.loggedIn) return "signed_out";
  if (st.expiresAt != null) {
    if (st.expiresAt <= now) return "expired";
    if (st.expiresAt - now <= EXPIRY_WARN_MS) return "expiring";
  }
  return "ok";
}

export function createClaudeLogin({
  claudeBin, env = process.env, log = () => {}, notify = async () => "off",
  kvGet = () => null, kvSet = () => {}, now = Date.now, spawnFn = nodeSpawn,
  tz = () => null, intervalMs = CHECK_INTERVAL_MS,
}) {
  let stored = null;          // last parsed status of the stored login
  let state = "unknown";      // judge(stored)
  let checkedAt = 0;
  let checking = null;        // Promise while a check runs
  let lastTurn = null;        // { kind: "auth" | "no_reply", at }
  let login = null;           // the running `claude auth login`
  let timer = null;
  const pending = new Set();  // alert keys being sent right now

  function runCli(args, { stdin = null, timeoutMs }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(claudeBin, args, { env: storedLoginEnv(env), stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"] });
      } catch (e) { resolve({ code: -1, out: "", err: String(e?.message || e) }); return; }
      const dec = new StringDecoder("utf8"), dec2 = new StringDecoder("utf8");
      let out = "", err = "";
      child.stdout.on("data", (d) => { out = (out + dec.write(d)).slice(-64_000); });
      child.stderr.on("data", (d) => { err = (err + dec2.write(d)).slice(-16_000); });
      const to = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
      to.unref?.();
      child.on("error", (e) => { clearTimeout(to); resolve({ code: -1, out, err: String(e?.message || e) }); });
      child.on("close", (code) => { clearTimeout(to); resolve({ code, out, err }); });
      // A CLI that closes its input early reports EPIPE as a stream event;
      // unhandled, that would take the whole bridge down.
      child.stdin?.on?.("error", () => {});
      if (stdin != null) { try { child.stdin.end(stdin); } catch {} }
    });
  }

  function alerted() {
    try { const v = kvGet(KV_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
  }
  function remember(v) {
    try { kvSet(KV_KEY, v ? JSON.stringify(v) : ""); } catch {}
  }

  function dayLabel(ms) {
    try {
      return new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz() || undefined });
    } catch { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
  }

  /** The bridge's turns run on their own token, not on the stored login. */
  const ownToken = () => !!(env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY);

  /** Tell the owner once per distinct problem; forget it after a recovery.
   *  Order: what blocks work now (token, expired login, a failed chat) comes
   *  before the advance warning, so a sent warning never hides a failure. */
  async function maybeAlert(reason) {
    const prev = alerted();
    if (state === "ok" && !lastTurn) {
      if (prev) remember(null);
      return;
    }
    let key = null, title = null, text = null;
    // The bridge's chats run on its own token: a chat rejected for its
    // sign-in is that token's fault, whatever the stored login says.
    if (lastTurn?.kind === "auth" && ownToken()) {
      key = `turn:token:${Math.floor(lastTurn.at / 3600_000)}`;
      title = "Claude rejected the bridge's token";
      text = "A Conduit chat failed because Claude rejected the sign-in token the bridge runs with (CLAUDE_CODE_OAUTH_TOKEN). Create a new one on the Mac with `claude setup-token`, store it where the bridge reads it, and restart the bridge.";
    } else if (state === "expired" || state === "signed_out") {
      key = `stored:${state}`;
      title = "Claude sign-in expired";
      text = ownToken()
        ? "The Claude sign-in on the Mac has expired. Conduit chats keep running on the bridge's token, but terminal sessions, Remote Control and connectors need a new sign-in. Open Conduit, Today, and tap \"Sign in again\"."
        : "The Claude sign-in on the Mac has expired, so chats cannot run. Open Conduit, Today, and tap \"Sign in again\".";
    } else if (lastTurn?.kind === "auth") {
      key = `turn:auth:${Math.floor(lastTurn.at / 3600_000)}`;
      title = "Claude rejected the sign-in";
      text = "A Conduit chat failed on the Claude sign-in. Open Conduit, Today, and tap \"Sign in again\".";
    } else if (lastTurn?.kind === "no_reply") {
      key = `turn:no_reply:${Math.floor(lastTurn.at / 3600_000)}`;
      title = "Claude did not answer";
      text = "A Conduit chat was accepted, but Claude never started to answer. The sign-in checks out, so the Mac is most likely waiting for a confirmation window. Look at the Mac, confirm it, then send the message again.";
    } else if (state === "expiring" && stored?.expiresAt) {
      key = `stored:expiring:${new Date(stored.expiresAt).toISOString().slice(0, 10)}`;
      title = "Claude sign-in expires soon";
      text = `The Claude sign-in on the Mac expires on ${dayLabel(stored.expiresAt)}. Open Conduit, Today, and tap "Sign in again" to renew it.`;
    }
    if (!key || prev?.key === key || pending.has(key)) return;
    let res = "failed";
    pending.add(key);
    try { res = await notify({ kind: "claude_login", title, text }); } catch { res = "failed"; } finally { pending.delete(key); }
    // Remembered only once a channel took it: a failed send is tried again
    // on the next check instead of being swallowed for good.
    if (res === "sent") remember({ key, at: now() });
    log(res === "failed" ? "warn" : "info", "claude_login_alert", { key: key.split(":").slice(0, 2).join(":"), reason, delivered: res });
  }

  async function doCheck(reason) {
    const r = await runCli(["auth", "status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS });
    const st = parseAuthStatus(r.out);
    stored = st;
    state = judge(st, now());
    checkedAt = now();
    log("info", "claude_login_checked", { reason, state, method: st?.method || null, expiresInH: st?.expiresAt ? Math.round((st.expiresAt - now()) / 3600_000) : null });
    await maybeAlert(reason);
    return status();
  }

  /** fresh: never answer with a check that started before this call. */
  function check(reason = "timer", { fresh = false } = {}) {
    if (checking && !fresh) return checking;
    const prev = checking || Promise.resolve();
    const run = prev.catch(() => {}).then(() => doCheck(reason));
    checking = run.finally(() => { if (checking === tracked) checking = null; });
    const tracked = checking;
    return run;
  }

  /** A Claude turn ended with an error. kind/error as stored for the turn. */
  function noteTurnFailure({ kind, error }) {
    const authish = typeof error === "string" && AUTH_ERROR_RE.test(error);
    if (!authish && kind !== "startup" && kind !== "no_reply") return false;
    lastTurn = { kind: authish ? "auth" : "no_reply", at: now() };
    check("turn_" + lastTurn.kind).catch(() => {});
    return true;
  }

  /** A Claude turn answered: whatever went wrong before is over. */
  function noteTurnSuccess() {
    if (!lastTurn) return;
    lastTurn = null;
    maybeAlert("turn_ok").catch(() => {});
  }

  function status() {
    return {
      state,
      method: stored?.method || null,
      expiresAt: stored?.expiresAt ?? null,
      checkedAt: checkedAt || null,
      lastTurnProblem: lastTurn ? { kind: lastTurn.kind, at: lastTurn.at } : null,
      ownToken: ownToken(),
      login: login ? { id: login.id, url: login.url, startedAt: login.startedAt, state: login.state } : null,
    };
  }

  function endLogin(l, st) {
    if (!l || l.ended) return;
    l.ended = true;
    l.state = st;
    clearTimeout(l.timer);
    try { l.child.kill("SIGKILL"); } catch {}
    if (login === l) login = null;
  }

  /** Start `claude auth login`. Resolves with { ok, id, url } once the link is printed. */
  function startLogin() {
    if (login && !login.ended) {
      if (login.url) return Promise.resolve({ ok: true, id: login.id, url: login.url, reused: true });
      return login.ready;
    }
    const id = Math.random().toString(36).slice(2, 12) + now().toString(36);
    let child;
    try {
      child = spawnFn(claudeBin, ["auth", "login", "--claudeai"], { env: storedLoginEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      log("warn", "claude_login_spawn_failed", { err: String(e?.message || e).slice(0, 120) });
      return Promise.resolve({ ok: false, error: "spawn_failed" });
    }
    const l = { id, child, url: null, startedAt: now(), state: "waiting_link", out: "", ended: false, exit: null };
    login = l;
    let resolveReady;
    l.ready = new Promise((r) => { resolveReady = r; });
    l.exited = new Promise((r) => { l.markExit = r; });
    const dec = new StringDecoder("utf8"), dec2 = new StringDecoder("utf8");
    const onData = (txt) => {
      l.out = (l.out + txt).slice(-16_000);
      if (!l.url) {
        const m = l.out.match(LOGIN_URL_RE);
        if (m) {
          l.url = m[1];
          l.state = "waiting_code";
          log("info", "claude_login_link", { host: new URL(l.url).host });
          resolveReady({ ok: true, id: l.id, url: l.url });
        }
      }
    };
    child.stdout.on("data", (d) => onData(dec.write(d)));
    child.stderr.on("data", (d) => onData(dec2.write(d)));
    child.on("error", () => {});
    // See runCli: an asynchronous EPIPE on the code must not crash the bridge.
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      l.exit = code;
      l.markExit(code);
      if (!l.url) resolveReady({ ok: false, error: "no_link" });
      if (!l.ended) endLogin(l, code === 0 ? "done" : "failed");
    });
    l.timer = setTimeout(() => {
      log("info", "claude_login_timeout", {});
      resolveReady({ ok: false, error: "timeout" });
      endLogin(l, "timeout");
    }, LOGIN_TIMEOUT_MS);
    l.timer.unref?.();
    log("info", "claude_login_started", {});
    return l.ready;
  }

  /** Pass the code from the browser to the waiting CLI. */
  async function submitCode(id, code) {
    const l = login;
    if (!l || l.ended || l.id !== id) return { ok: false, error: "no_login" };
    if (l.state !== "waiting_code") return { ok: false, error: "not_ready" };
    const c = String(code || "").trim();
    if (!CODE_RE.test(c)) return { ok: false, error: "bad_code" };
    l.state = "checking_code";
    try { l.child.stdin.write(c + "\n"); } catch { endLogin(l, "failed"); return { ok: false, error: "failed" }; }
    let to;
    const exit = await Promise.race([l.exited, new Promise((r) => { to = setTimeout(() => r("timeout"), CODE_TIMEOUT_MS); to.unref?.(); })]);
    clearTimeout(to);
    if (exit === "timeout") { endLogin(l, "timeout"); return { ok: false, error: "timeout" }; }
    const ok = exit === 0;
    // Only the CLI's verdict, in its own short words (no paths, no tokens).
    const said = l.out.split("\n").map((s) => s.trim()).filter(Boolean).pop() || "";
    endLogin(l, ok ? "done" : "failed");
    log(ok ? "info" : "warn", "claude_login_finished", { ok });
    // The new stored login fixes what it is about. A rejected bridge token is
    // not renewed by it, so that problem (and its alert) stays.
    if (ok && !(lastTurn?.kind === "auth" && ownToken())) lastTurn = null;
    const st = await check("after_login", { fresh: true });
    return ok
      ? { ok: true, status: st }
      : { ok: false, error: "rejected", message: said.replace(/https?:\/\/\S+/g, "").slice(0, 200), status: st };
  }

  function cancelLogin() {
    if (!login) return false;
    endLogin(login, "cancelled");
    log("info", "claude_login_cancelled", {});
    return true;
  }

  function start() {
    setTimeout(() => { check("boot").catch(() => {}); }, 5_000).unref?.();
    timer = setInterval(() => { check("timer").catch(() => {}); }, intervalMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (login) endLogin(login, "cancelled");
  }

  return { start, stop, check, status, noteTurnFailure, noteTurnSuccess, startLogin, submitCode, cancelLogin };
}
