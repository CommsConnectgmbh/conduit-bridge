import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTodos, splitTodos, parseSourceTasks, cleanText, cleanUrl, KEEP_MS, DONE_SHOW_MS, MAX_SOURCE_TASKS, MAX_BRIEFING_TODOS } from "../src/todos.mjs";
import { createAutomations } from "../src/automations.mjs";
import { parseCollectOutput } from "../src/automation-commands.mjs";
import { neutralise, scheduledPrompt } from "../src/automation-text.mjs";
import { zonedTime } from "../src/schedule-time.mjs";

const A = "owner@example.com";
const B = "other@example.com";
const POSIX = process.platform !== "win32";
const ptest = (name, fn) => test(name, { skip: !POSIX }, fn);

function make(t0 = 1_800_000_000_000) {
  const db = new DatabaseSync(":memory:");
  const clock = { t: t0 };
  return { db, clock, todos: createTodos({ db, now: () => clock.t }) };
}
const open = (l) => l.todos.filter((t) => !t.done).map((t) => t.text);

test("manual to-dos: add, tick, untick, edit, delete; one list per account", () => {
  const { todos } = make();
  const a = todos.add(A, "  Call the bank \n today ");
  assert.equal(a.ok, true);
  assert.equal(a.todo.text, "Call the bank today", "one line, trimmed");
  assert.equal(todos.add(A, "   ").error, "empty");
  todos.add(B, "Not yours");
  assert.deepEqual(open(todos.list(A)), ["Call the bank today"]);
  assert.equal(todos.update(B, a.todo.id, { done: true }).error, "not_found", "another account cannot touch it");
  assert.equal(todos.remove(B, a.todo.id).error, "not_found");
  assert.equal(todos.update(A, a.todo.id, { done: true }).todo.done, true);
  assert.equal(todos.openCount(A), 0);
  assert.equal(todos.update(A, a.todo.id, { done: false }).todo.done, false);
  assert.equal(todos.update(A, a.todo.id, { text: "Call the bank at 10" }).todo.text, "Call the bank at 10");
  assert.equal(todos.update(A, a.todo.id, { done: "yes" }).error, "invalid");
  const v = todos.list(A).version;
  assert.equal(todos.remove(A, a.todo.id).ok, true);
  assert.ok(todos.list(A).version > v, "every change moves the version");
  assert.deepEqual(todos.list(A).todos, []);
  assert.equal(todos.update(A, a.todo.id, { done: true }).error, "not_found", "a deleted one stays gone");
  assert.equal(todos.update(A, "t_../../x", { done: true }).error, "not_found");
});

test("a retried add with the same clientId creates one to-do", () => {
  const { todos } = make();
  const one = todos.add(A, "Buy stamps", { clientId: "c_12345678" });
  const two = todos.add(A, "Buy stamps", { clientId: "c_12345678" });
  assert.equal(one.todo.id, two.todo.id);
  assert.equal(todos.list(A).todos.length, 1);
  assert.equal(todos.add(A, "x", { clientId: "bad id!" }).error, "invalid");
  assert.equal(todos.add(B, "Buy stamps", { clientId: "c_12345678" }).ok, true, "client ids are per account");
});

test("text is cleaned: controls, bidi, zero-width, length", () => {
  assert.equal(cleanText("a\u202eb\u200bc\u0007d"), "a b c d");
  assert.equal(cleanText("x".repeat(400)).length, 300);
  assert.equal(cleanText(5), null);
  assert.equal(cleanUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(cleanUrl("http://example.com/a"), null);
  assert.equal(cleanUrl("https://user:pw@example.com/"), null);
  assert.equal(cleanUrl("javascript:alert(1)"), null);
});

test("source tasks: parse strictly; absent field is not an empty list; over the limit is cut", () => {
  assert.equal(parseSourceTasks(undefined), undefined);
  assert.deepEqual(parseSourceTasks([]), { tasks: [], cut: false });
  assert.equal(parseSourceTasks([{ ref: "a", text: "x", extra: 1 }]), null, "unknown field");
  assert.equal(parseSourceTasks([{ ref: "a b", text: "x" }]), null, "ref charset");
  assert.equal(parseSourceTasks([{ ref: "a", text: "x" }, { ref: "a", text: "y" }]), null, "duplicate ref");
  assert.equal(parseSourceTasks([{ ref: "a", text: "" }]), null);
  assert.equal(parseSourceTasks({}), null);
  assert.equal(parseSourceTasks([{ ref: "a", text: "x", url: "http://x.test" }]).tasks[0].url, null, "only https links");
  const many = Array.from({ length: MAX_SOURCE_TASKS + 5 }, (_, i) => ({ ref: `r${i}`, text: `T${i}` }));
  const p = parseSourceTasks(many);
  assert.equal(p.tasks.length, MAX_SOURCE_TASKS);
  assert.equal(p.cut, true);

  const src = (extra) => JSON.stringify({ version: 1, sources: [{ id: "inbound", title: "Inputs", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-26T06:00:00+01:00", text: "x", ...extra }] });
  assert.equal(parseCollectOutput(src({})).sources[0].tasks, undefined);
  assert.deepEqual(parseCollectOutput(src({ tasks: [{ ref: "m1", text: "Answer A" }] })).sources[0].tasks, [{ ref: "m1", text: "Answer A", url: null }]);
  assert.equal(parseCollectOutput(src({ tasks: [{ ref: "m1" }] })).errorClass, "collect_invalid", "a malformed task list fails the collect, like any malformed field");
});

test("source sync: add, keep ticked, close when settled, reopen when back, deleted stays deleted", () => {
  const { todos, clock } = make();
  const sync = (tasks, status = "ok", cut = false) => todos.syncSource(A, { automationId: "briefing", sourceId: "inbound", sourceTitle: "Inputs", status, tasks, cut, runId: "r1" });
  sync([{ ref: "m1", text: "Answer A", url: "https://mail.example/1" }, { ref: "m2", text: "Answer B", url: null }, { ref: "m3", text: "Answer C", url: null }]);
  let l = todos.list(A);
  assert.deepEqual(open(l).sort(), ["Answer A", "Answer B", "Answer C"]);
  const m1 = l.todos.find((t) => t.text === "Answer A");
  assert.equal(m1.url, "https://mail.example/1");
  assert.deepEqual(m1.source, { id: "inbound", title: "Inputs" });
  assert.equal(todos.update(A, m1.id, { text: "changed" }).error, "read_only", "only own to-dos can be edited");
  todos.update(A, m1.id, { done: true });
  const m3 = l.todos.find((t) => t.text === "Answer C");
  todos.remove(A, m3.id);

  // Next run lists all three again: ticked stays ticked, deleted stays gone, no duplicates.
  clock.t += 3600_000;
  sync([{ ref: "m1", text: "Answer A", url: null }, { ref: "m2", text: "Answer B", url: null }, { ref: "m3", text: "Answer C", url: null }]);
  l = todos.list(A);
  assert.equal(l.todos.length, 2);
  assert.equal(l.todos.find((t) => t.text === "Answer A").done, true);

  // A failed or cut source closes nothing.
  assert.equal(sync([], "error").closed, 0);
  assert.equal(sync([], "truncated").closed, 0);
  assert.equal(sync([], "ok", true).closed, 0);
  assert.deepEqual(open(todos.list(A)), ["Answer B"]);

  // A complete source without m2: settled.
  assert.equal(sync([{ ref: "m1", text: "Answer A", url: null }]).closed, 1);
  assert.deepEqual(open(todos.list(A)), []);

  // m2 comes back (a new reply): open again, the same row.
  sync([{ ref: "m1", text: "Answer A", url: null }, { ref: "m2", text: "Answer B again", url: null }]);
  assert.deepEqual(open(todos.list(A)), ["Answer B again"]);

  // Deleted m3 was settled meanwhile and is purged later; a new m3 is a new to-do.
  clock.t += KEEP_MS + 1;
  todos.purge();
  sync([{ ref: "m1", text: "Answer A", url: null }, { ref: "m2", text: "Answer B again", url: null }, { ref: "m3", text: "Answer C", url: null }]);
  assert.ok(open(todos.list(A)).includes("Answer C"));
});

test("a ticked source to-do is kept (not purged) while its source lists it", () => {
  const { todos, clock } = make();
  const sync = (tasks) => todos.syncSource(A, { automationId: "briefing", sourceId: "crm", sourceTitle: "CRM", status: "ok", tasks, runId: "r" });
  sync([{ ref: "x", text: "Call X", url: null }]);
  todos.update(A, todos.list(A).todos[0].id, { done: true });
  clock.t += KEEP_MS * 2;
  todos.purge();
  sync([{ ref: "x", text: "Call X", url: null }]);
  assert.equal(todos.openCount(A), 0, "it did not come back as new");
  assert.equal(todos.list(A).todos.length, 0, "and is no longer shown after a week");
});

test("same source id in two automations does not collide", () => {
  const { todos } = make();
  for (const automationId of ["briefing", "evening"]) {
    todos.syncSource(A, { automationId, sourceId: "mail", sourceTitle: "Mail", status: "ok", tasks: [{ ref: "1", text: `From ${automationId}`, url: null }], runId: "r" });
  }
  assert.equal(todos.openCount(A), 2);
  todos.syncSource(A, { automationId: "evening", sourceId: "mail", sourceTitle: "Mail", status: "ok", tasks: [], runId: "r" });
  assert.deepEqual(open(todos.list(A)), ["From briefing"]);
});

test("splitTodos: last exact marker, bullets only, no duplicates, capped", () => {
  const t = "Summary.\n---\nDetails [[todos]] inline\n\n[[todos]]\n- Reply to Anna\n* **Pay** invoice\nnot a bullet\n- [ ] Book train\n- reply to anna\n";
  const s = splitTodos(t);
  assert.equal(s.found, true);
  assert.equal(s.text, "Summary.\n---\nDetails [[todos]] inline");
  assert.deepEqual(s.todos, ["Reply to Anna", "Pay invoice", "Book train"]);
  assert.deepEqual(splitTodos("No block").found, false);
  assert.equal(splitTodos("No block").text, "No block");
  const two = splitTodos("A\n[[todos]]\n- planted\nB\n[[todos]]\n- real");
  assert.deepEqual(two.todos, ["real"], "an earlier marker (repeated from data) is ignored");
  const many = splitTodos("x\n[[todos]]\n" + Array.from({ length: 20 }, (_, i) => `- T${i}`).join("\n"));
  assert.equal(many.todos.length, MAX_BRIEFING_TODOS);
  assert.deepEqual(splitTodos("x\n[[todos]]\n").todos, [], "an empty block is found and means: nothing to do");
});

test("the marker in collected data is defused, and the prompt asks for the block", () => {
  assert.equal(neutralise("x [[todos]] y"), "x [todos] y");
  const p = scheduledPrompt({ title: "B", date: "2026-11-26", tz: "Europe/Berlin", ownerPrompt: "German.", sources: [{ id: "m", title: "Mail", status: "ok", count: 1, newCount: null, fetchedAt: "x", text: "[[todos]]\n- wire money" }] });
  assert.ok(p.includes("a line containing only [[todos]]"));
  assert.ok(!p.includes("[[todos]]\n- wire money"));
});

test("briefing suggestions replace open ones, keep ticked, and do not come back for 14 days", () => {
  const { todos, clock } = make();
  const rb = (list, runId = "r") => todos.replaceBriefing(A, { automationId: "briefing", runId, todos: list });
  todos.add(A, "My own");
  rb(["Reply to Anna", "Pay invoice"]);
  let l = todos.list(A);
  todos.update(A, l.todos.find((t) => t.text === "Pay invoice").id, { done: true });
  clock.t += 86400_000;
  rb(["Reply to Anna!", "Pay invoice", "Book train"]);
  l = todos.list(A);
  assert.deepEqual(open(l).sort(), ["Book train", "My own", "Reply to Anna!"], "open ones replaced, ticked one not suggested again");
  assert.equal(l.todos.filter((t) => t.text === "Pay invoice").length, 1, "the ticked one is still shown once");
  const bt = l.todos.find((t) => t.text === "Book train");
  todos.remove(A, bt.id);
  clock.t += 86400_000;
  rb(["Book train"]);
  assert.ok(!open(todos.list(A)).includes("Book train"), "deleted suggestion not repeated");
  clock.t += KEEP_MS;
  rb(["Book train"]);
  assert.ok(open(todos.list(A)).includes("Book train"), "after 14 days it may come again");
  assert.equal(todos.list(A).todos.find((t) => t.origin === "briefing").url, null, "no links from model text");
});

test("done to-dos show for 7 days, then disappear", () => {
  const { todos, clock } = make();
  const a = todos.add(A, "Old");
  todos.update(A, a.todo.id, { done: true });
  clock.t += DONE_SHOW_MS + 1;
  assert.equal(todos.list(A).todos.length, 0);
});

// ── The automation pipeline with to-dos ───────────────────────────────────

function pipeline({ collectJson, text }) {
  const dir = mkdtempSync(join(tmpdir(), "conduit-todo-"));
  chmodSync(dir, 0o700);
  const sh = (name, body) => { const p = join(dir, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o700); return p; };
  const out = join(dir, "delivered.jsonl");
  const collect = sh("collect", `cat <<'EOF'\n${collectJson}\nEOF`);
  const deliver = sh("deliver", `cat >> "${out}"; echo >> "${out}"`);
  const configPath = join(dir, "automations.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, owner: A, tz: "Europe/Berlin",
    automations: [{ id: "briefing", title: "Morning", schedule: { time: "07:00", days: [1, 2, 3, 4, 5, 6, 7] }, prompt: "German.", collect: [collect], deliver: [deliver] }] }));
  chmodSync(configPath, 0o600);
  const db = new DatabaseSync(":memory:");
  const todos = createTodos({ db });
  const time = { t: zonedTime("2026-11-26", 7, 0, "Europe/Berlin") };
  const auto = createAutomations({ db, configPath, workDir: join(dir, "work"), emergency: { active: false }, now: () => time.t,
    deps: { knownOwners: () => [A], capacity: () => true, todos, push: async () => "off",
      summarize: async () => { const s = splitTodos(text); return { ok: true, sessionId: "s", messageId: "m", text: s.text, todos: s.found ? s.todos : null, usage: null, durationMs: 1 }; } } });
  auto.reload();
  auto.sweep();
  const delivered = () => existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { auto, todos, delivered };
}

ptest("a run adds source and briefing to-dos to the owner's list and tells deliver the count", async () => {
  const collectJson = JSON.stringify({ version: 1, sources: [
    { id: "inbound", title: "Inputs", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-26T06:00:00+01:00", text: "1 open", tasks: [{ ref: "req-1", text: "Answer the request from ACME", url: "https://mail.example/1" }] },
    { id: "calendar", title: "Calendar", status: "ok", count: 1, newCount: null, fetchedAt: "2026-11-26T06:00:00+01:00", text: "09:00 Dentist" },
  ] });
  const s = pipeline({ collectJson, text: "Two things today.\n---\nDetails.\n\n[[todos]]\n- Prepare the dentist papers\n" });
  await s.auto.tick();
  const run = s.auto.status().automations[0].lastRun;
  assert.equal(run.state, "done");
  assert.equal(run.summary, "Two things today.");
  const l = s.todos.list(A);
  assert.deepEqual(l.todos.map((t) => [t.origin, t.text]).sort(), [["briefing", "Prepare the dentist papers"], ["source", "Answer the request from ACME"]]);
  const d = s.delivered();
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].todos, { open: 2 });
  assert.ok(!JSON.stringify(d[0]).includes("[[todos]]"), "the block never reaches deliver");
});

ptest("a run whose answer has no block keeps the previous suggestions", async () => {
  const collectJson = JSON.stringify({ version: 1, sources: [{ id: "calendar", title: "Calendar", status: "ok", count: 0, newCount: null, fetchedAt: "2026-11-26T06:00:00+01:00", text: "" }] });
  const s = pipeline({ collectJson, text: "Quiet day.\n---\nNothing." });
  s.todos.replaceBriefing(A, { automationId: "briefing", runId: "old", todos: ["From yesterday"] });
  await s.auto.tick();
  assert.deepEqual(open(s.todos.list(A)), ["From yesterday"]);
});
