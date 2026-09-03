// server.ts API 계약 테스트. 임시 디렉토리와 임의 포트로 서버를 띄운다.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 47000 + Math.floor(Math.random() * 1000);
const URL = `http://127.0.0.1:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), "grill-web-test-"));
const SERVER = join(import.meta.dir, "server.ts");
const env = { ...process.env, GRILL_WEB_PORT: String(PORT), GRILL_WEB_DIR: DIR, GRILL_WEB_NO_OPEN: "1" };
// wait 프로세스가 준비됐다는 stderr 첫 줄을 기다린다
async function waitReady(proc: any): Promise<string> {
  const reader = proc.stderr.getReader();
  let text = "";
  while (!text.includes("기다리는 중")) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  reader.releaseLock();
  return text;
}
let proc: ReturnType<typeof Bun.spawn>;

const round1 = {
  intro: "first",
  questions: [
    { n: 1, title: "pick one", kind: "choice", options: ["A", "B"], recommendation: "A" },
    { n: 2, title: "yes or no", kind: "yesno", recommendation: "yes" },
    { n: 3, title: "many", kind: "multi", options: ["x", "y", "z"], recommendation: ["x"] },
    { n: 4, title: "how many", kind: "range", min: 1, max: 10, recommendation: 5 },
    { n: 5, title: "say it", kind: "text", recommendation: "..." },
  ],
};
const good = () => [
  { n: 1, value: "B", note: "" },
  { n: 2, value: "no", note: "because" },
  { n: 3, value: ["x", "z"], note: "" },
  { n: 4, value: 7, note: "" },
  { n: 5, value: "fine", note: "" },
];
const state = async () => (await fetch(`${URL}/api/state`)).json();
const rev = async (n = 1) => (await state()).rounds.find((r: any) => r.round === n)?.rev as string;
const withRev = async (body: any) => ({ rev: await rev(body.round), ...body });
const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${URL}/api/answers`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}`, ...headers }, body: JSON.stringify(body) });
const session = async () => (await state()).session as string;

beforeAll(async () => {
  Bun.spawnSync([process.execPath, SERVER, "reset", "test topic"], { env });
  proc = Bun.spawn([process.execPath, SERVER, "serve"], { env, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${URL}/api/health`)).ok) break; } catch {}
    await Bun.sleep(100);
  }
  writeFileSync(join(DIR, "rounds", "1.json"), JSON.stringify(round1));
});
afterAll(() => { proc.kill(); rmSync(DIR, { recursive: true, force: true }); });

describe("health and state", () => {
  test("health identifies itself as grill-web", async () => {
    expect(await (await fetch(`${URL}/api/health`)).json()).toEqual({ ok: true, app: "grill-web", dir: DIR });
  });
  test("state carries session id, title, rounds with rev", async () => {
    const s = await state();
    expect(typeof s.session).toBe("string");
    expect(s.title).toBe("test topic");
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0].round).toBe(1);
    expect(typeof s.rounds[0].rev).toBe("string");
    expect(s.rounds[0].answers).toBeNull();
    expect(s.summary).toBeNull();
  });
  test("rev is a content hash: same-size rewrite in the same instant still changes it", async () => {
    const before = await rev();
    const path = join(DIR, "rounds", "1.json");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace('"intro":"first"', '"intro":"fixed"')); // 같은 길이
    expect(await rev()).not.toBe(before);
    writeFileSync(path, text);
    expect(await rev()).toBe(before);
  });
  test("state and health refuse a foreign Host", async () => {
    expect((await fetch(`${URL}/api/state`, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await fetch(`${URL}/api/health`, { headers: { host: "evil.example" } })).status).toBe(403);
  });
  test("serve records its pid and port for the state dir", () => {
    const owner = JSON.parse(readFileSync(join(DIR, "server.json"), "utf8"));
    expect(owner.port).toBe(PORT);
    expect(typeof owner.pid).toBe("number");
  });
  test("serves the form and the sanitizer", async () => {
    expect((await fetch(`${URL}/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${URL}/sanitize.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${URL}/nope`)).status).toBe(404);
  });
});

describe("request origin", () => {
  test("rejects a cross-site simple POST and a foreign origin", async () => {
    const body = await withRev({ session: await session(), round: 1, answers: good() });
    const plain = await fetch(`${URL}/api/answers`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) });
    expect(plain.status).toBe(403);
    expect((await post(body, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(body, { host: "evil.example:80" })).status).toBe(403);
  });
  test("ignores non-numeric round files and cannot be overridden by file content", async () => {
    writeFileSync(join(DIR, "rounds", "1.json.bak"), "{}");
    writeFileSync(join(DIR, "rounds", "7.json"), JSON.stringify({ round: 99, rev: "x", answers: { fake: true }, questions: [] }));
    const s = await state();
    expect(s.rounds.map((r: any) => r.round)).toEqual([1, 7]);
    const r7 = s.rounds.find((r: any) => r.round === 7);
    expect(r7.answers).toBeNull();
    expect(r7.rev).not.toBe("x");
    rmSync(join(DIR, "rounds", "7.json")); rmSync(join(DIR, "rounds", "1.json.bak"));
  });
  test("skips a round file that is not valid JSON yet", async () => {
    writeFileSync(join(DIR, "rounds", "8.json"), '{"questions": [');
    expect((await state()).rounds.map((r: any) => r.round)).toEqual([1]);
    rmSync(join(DIR, "rounds", "8.json"));
  });
});

describe("answer validation", () => {
  test("rejects a missing or stale session", async () => {
    expect((await post(await withRev({ round: 1, answers: good() }))).status).toBe(409);
    expect((await post(await withRev({ session: "stale", round: 1, answers: good() }))).status).toBe(409);
  });
  test("rejects a submission made against an older revision, or with no rev at all", async () => {
    expect((await post({ session: await session(), round: 1, rev: "stale-rev", answers: good() })).status).toBe(409);
    expect((await post({ session: await session(), round: 1, answers: good() })).status).toBe(400);
    const ok = await post(await withRev({ session: await session(), round: 1, answers: [{ n: 1, value: "A", note: "" }] }));
    expect(ok.status).toBe(400); // rev는 맞지만 답이 모자라서 400. rev 검사는 통과했다
  });
  test("rejects an unknown round", async () => {
    expect((await post({ session: await session(), round: 9, answers: [] })).status).toBe(404);
  });
  test("rejects a missing round number", async () => {
    expect((await post({ session: await session(), answers: [] })).status).toBe(400);
  });
  const bad: [string, unknown[]][] = [
    ["yesno outside yes/no", good().map((a) => (a.n === 2 ? { ...a, value: "maybe" } : a))],
    ["choice empty", good().map((a) => (a.n === 1 ? { ...a, value: "" } : a))],
    ["multi outside options", good().map((a) => (a.n === 3 ? { ...a, value: ["x", "q"] } : a))],
    ["multi empty", good().map((a) => (a.n === 3 ? { ...a, value: [] } : a))],
    ["range out of bounds", good().map((a) => (a.n === 4 ? { ...a, value: 11 } : a))],
    ["range not a number", good().map((a) => (a.n === 4 ? { ...a, value: "7" } : a))],
    ["text empty", good().map((a) => (a.n === 5 ? { ...a, value: "  " } : a))],
    ["note not a string", good().map((a) => (a.n === 5 ? { ...a, note: 1 } : a))],
    ["missing question", good().slice(0, 4)],
    ["duplicate question", [...good(), { n: 1, value: "A", note: "" }]],
    ["unknown question", [...good(), { n: 42, value: "A", note: "" }]],
    ["skipped with a value", good().map((a) => (a.n === 2 ? { ...a, value: "yes", skipped: true } : a))],
  ];
  for (const [name, answers] of bad) {
    test(`rejects ${name}`, async () => {
      const res = await post(await withRev({ session: await session(), round: 1, answers }));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    });
  }
  test("accepts a valid submission with a skipped answer, then refuses a resubmit", async () => {
    const answers = good().map((a) => (a.n === 2 ? { n: 2, value: null, note: "", skipped: true } : a));
    const res = await post(await withRev({ session: await session(), round: 1, answers }));
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(DIR, "answers", "1.json"), "utf8"));
    expect(saved.answers).toEqual(answers);
    expect(saved.session).toBe(await session());
    expect(saved.rev).toBe(await rev());
    expect(typeof saved.submittedAt).toBe("string");
    expect(readdirSync(join(DIR, "answers")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect((await state()).rounds[0].answers.answers).toEqual(answers);
    expect((await post(await withRev({ session: await session(), round: 1, answers }))).status).toBe(409);
  });
  test("choice accepts a value outside options only when flagged as other", async () => {
    writeFileSync(join(DIR, "rounds", "2.json"), JSON.stringify({ questions: [{ n: 1, title: "pick", kind: "choice", options: ["A"], recommendation: "A" }] }));
    const bad = await post(await withRev({ session: await session(), round: 2, answers: [{ n: 1, value: "something else", note: "" }] }));
    expect(bad.status).toBe(400);
    const res = await post(await withRev({ session: await session(), round: 2, answers: [{ n: 1, value: "something else", note: "", other: true }] }));
    expect(res.status).toBe(200);
  });
  test("rejects an unknown question kind instead of treating it as text", async () => {
    writeFileSync(join(DIR, "rounds", "3.json"), JSON.stringify({ questions: [{ n: 1, title: "typo", kind: "chocie", options: ["A"], recommendation: "A" }] }));
    const res = await post(await withRev({ session: await session(), round: 3, answers: [{ n: 1, value: "A", note: "" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("chocie");
  });
});

describe("server reuse and ownership", () => {
  test("up refuses a port held by a grill-web with a different state dir", async () => {
    const other = mkdtempSync(join(tmpdir(), "grill-web-other-"));
    const r = Bun.spawnSync([process.execPath, SERVER, "up", "x"], { env: { ...env, GRILL_WEB_DIR: other }, stdout: "pipe", stderr: "pipe" });
    rmSync(other, { recursive: true, force: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("GRILL_WEB_PORT");
  });
  test("up on another port reuses the live server that already owns the dir", async () => {
    const r = Bun.spawnSync([process.execPath, SERVER, "up", "reuse me"], { env: { ...env, GRILL_WEB_PORT: String(PORT + 1) }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain(`localhost:${PORT} `);
    let second = false;
    try { second = (await fetch(`http://127.0.0.1:${PORT + 1}/api/health`)).ok; } catch {}
    expect(second).toBe(false);
    expect((await state()).title).toBe("reuse me");
  });
  test("reset refuses a non-empty directory that grill-web does not own", () => {
    const foreign = mkdtempSync(join(tmpdir(), "grill-web-foreign-"));
    mkdirSync(join(foreign, "rounds")); writeFileSync(join(foreign, "rounds", "mine.txt"), "keep");
    const r = Bun.spawnSync([process.execPath, SERVER, "reset", "x"], { env: { ...env, GRILL_WEB_DIR: foreign }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
    expect(readFileSync(join(foreign, "rounds", "mine.txt"), "utf8")).toBe("keep");
    rmSync(foreign, { recursive: true, force: true });
  });
  test("an empty directory is adopted and marked", () => {
    const fresh = mkdtempSync(join(tmpdir(), "grill-web-fresh-"));
    const r = Bun.spawnSync([process.execPath, SERVER, "reset", "x"], { env: { ...env, GRILL_WEB_DIR: fresh }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(fresh, ".grill-web"))).toBe(true);
    rmSync(fresh, { recursive: true, force: true });
  });
  test("a live lock blocks reset; a stale lock is reclaimed", () => {
    mkdirSync(join(DIR, ".lock"));
    const blocked = Bun.spawnSync([process.execPath, SERVER, "reset", "x"], { env, stdout: "pipe", stderr: "pipe" });
    expect(blocked.exitCode).toBe(5);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(DIR, ".lock"), old, old);
    const ok = Bun.spawnSync([process.execPath, SERVER, "reset", "after stale lock"], { env, stdout: "pipe", stderr: "pipe" });
    expect(ok.exitCode).toBe(0);
    expect(existsSync(join(DIR, ".lock"))).toBe(false);
    writeFileSync(join(DIR, "rounds", "1.json"), JSON.stringify(round1));
  });
});

describe("answers are bound to the round revision", () => {
  test("rewriting an answered round detaches the old answer, wait exits 6, resubmission overwrites", async () => {
    writeFileSync(join(DIR, "rounds", "5.json"), JSON.stringify({ questions: [{ n: 1, title: "t", kind: "yesno", recommendation: "yes" }] }));
    // 답이 오기 전에 라운드가 바뀌면 wait는 6으로 끝난다
    const waiter = Bun.spawn([process.execPath, SERVER, "wait", "5"], { env, stdout: "ignore", stderr: "pipe" });
    await waitReady(waiter);
    writeFileSync(join(DIR, "rounds", "5.json"), JSON.stringify({ questions: [{ n: 1, title: "t2", kind: "yesno", recommendation: "yes" }] }));
    expect(await waiter.exited).toBe(6);
    // 답한 뒤 라운드가 바뀌면 옛 답은 떨어져 나간다
    expect((await post(await withRev({ session: await session(), round: 5, answers: [{ n: 1, value: "yes", note: "" }] }))).status).toBe(200);
    expect((await state()).rounds.find((r: any) => r.round === 5).answers.answers[0].value).toBe("yes");
    writeFileSync(join(DIR, "rounds", "5.json"), JSON.stringify({ questions: [{ n: 1, title: "changed", kind: "yesno", recommendation: "no" }] }));
    expect((await state()).rounds.find((r: any) => r.round === 5).answers).toBeNull();
    expect((await post(await withRev({ session: await session(), round: 5, answers: [{ n: 1, value: "no", note: "" }] }))).status).toBe(200);
    expect((await state()).rounds.find((r: any) => r.round === 5).answers.answers[0].value).toBe("no");
    rmSync(join(DIR, "rounds", "5.json")); rmSync(join(DIR, "answers", "5.json"));
  });
});

describe("summary and reset", () => {
  test("summary.md shows up in state", async () => {
    writeFileSync(join(DIR, "summary.md"), "# done");
    expect((await state()).summary).toBe("# done");
  });
  test("reset starts a new session, wipes rounds, and leaves unrelated files alone", async () => {
    const before = await session();
    writeFileSync(join(DIR, "keep.txt"), "mine");
    Bun.spawnSync([process.execPath, SERVER, "reset", "second topic"], { env });
    const s = await state();
    expect(s.session).not.toBe(before);
    expect(s.title).toBe("second topic");
    expect(s.rounds).toEqual([]);
    expect(s.summary).toBeNull();
    expect(readFileSync(join(DIR, "keep.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(DIR, "server.json"))).toBe(true);
  });
  test("wait gives up when a new session starts underneath it", async () => {
    writeFileSync(join(DIR, "rounds", "1.json"), JSON.stringify({ questions: [{ n: 1, title: "t", kind: "yesno", recommendation: "yes" }] }));
    const waiter = Bun.spawn([process.execPath, SERVER, "wait", "1"], { env, stdout: "ignore", stderr: "pipe" });
    await waitReady(waiter);
    Bun.spawnSync([process.execPath, SERVER, "reset", "third topic"], { env });
    expect(await waiter.exited).toBe(4); // stderr는 waitReady가 이미 읽고 있어 다시 읽지 않는다
  });
  test("wait prints the answer file when it appears", async () => {
    writeFileSync(join(DIR, "rounds", "1.json"), JSON.stringify({ questions: [{ n: 1, title: "t", kind: "yesno", recommendation: "yes" }] }));
    const waiter = Bun.spawn([process.execPath, SERVER, "wait", "1"], { env, stdout: "pipe", stderr: "pipe" });
    await waitReady(waiter);
    const res = await post(await withRev({ session: await session(), round: 1, answers: [{ n: 1, value: "yes", note: "" }] }));
    expect(res.status).toBe(200);
    const out = await new Response(waiter.stdout).text();
    expect(await waiter.exited).toBe(0);
    expect(JSON.parse(out).answers[0].value).toBe("yes");
  });
});
