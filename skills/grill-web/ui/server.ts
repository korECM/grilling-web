// grill-web: 고정 폼을 서빙하고 라운드/답변 JSON을 파일로 주고받는 작은 서버.
//
//   bun server.ts up "주제"   상태 초기화 + 서버 기동(이미 떠 있으면 재사용) + 브라우저 열기
//   bun server.ts serve       포그라운드로 서버만 실행
//   bun server.ts wait <n>    answers/<n>.json 이 생길 때까지 기다렸다가 내용을 출력
//   bun server.ts reset "주제" 상태만 초기화
//
// 상태 디렉토리: $GRILL_WEB_DIR (기본 ~/.cache/grill-web)
//   session.json      { id, title, startedAt }  id는 세션마다 새로 난다. 옛 탭의 답변을 거르는 기준
//   rounds/<n>.json   모델이 쓴 라운드
//   answers/<n>.json  폼이 쓴 답변
//   summary.md        있으면 폼이 마무리 화면으로 보여줌

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.GRILL_WEB_DIR ?? join(process.env.HOME ?? ".", ".cache", "grill-web");
const PORT = Number(process.env.GRILL_WEB_PORT ?? 4747);
const urlFor = (port: number) => `http://localhost:${port}`;
const URL = urlFor(PORT);
const HTML = join(import.meta.dir, "index.html");
const SANITIZE_JS = join(import.meta.dir, "sanitize.js");

const MARKER = () => join(DIR, ".grill-web"); // 이 폴더가 grill-web 것이라는 표식. 없는 비어 있지 않은 폴더는 건드리지 않는다
const LOCK = () => join(DIR, ".lock");
const roundsDir = () => join(DIR, "rounds");
const answersDir = () => join(DIR, "answers");

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function roundNumbers(): number[] {
  if (!existsSync(roundsDir())) return [];
  return readdirSync(roundsDir())
    .map((f) => /^(\d+)\.json$/.exec(f)?.[1])
    .filter((m): m is string => m !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

// 라운드 파일을 한 번 읽어 그 바이트로 판(rev)과 내용을 함께 만든다. rev는 내용 해시라 같은 크기로 고쳐 써도 달라진다.
function readRound(path: string): { data: any; rev: string } | null {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return null; }
  let data: any;
  try { data = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  return { data, rev: createHash("sha1").update(bytes).digest("hex").slice(0, 16) };
}

// 임시 파일에 쓰고 이름을 바꾼다. 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다.
function writeAtomic(path: string, content: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function state() {
  const session = readJson(join(DIR, "session.json")) ?? { id: null, title: "" };
  const rounds = roundNumbers().flatMap((n) => {
    const r = readRound(join(roundsDir(), `${n}.json`));
    if (!r) return []; // 쓰는 도중이거나 깨진 파일. 다음 폴링에서 다시 본다
    // round, rev, answers는 파일 내용이 덮어쓰지 못하게 뒤에 둔다. 답은 지금 판(rev)에 대한 것일 때만 붙인다
    const ans = readJson(join(answersDir(), `${n}.json`));
    return [{ ...r.data, round: n, rev: r.rev, answers: ans && ans.rev === r.rev ? ans : null }];
  });
  const summaryPath = join(DIR, "summary.md");
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : null;
  return { session: session.id, title: session.title, rounds, summary };
}

// 상태 폴더가 grill-web 것인지 확인한다. 새 폴더나 빈 폴더면 표식을 남기고, 남의 파일이 든 폴더면 멈춘다.
function ensureOwned() {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(MARKER())) return;
  // 표식이 생기기 전 버전이 만든 폴더는 grill-web 파일만 들어 있다. 그 경우엔 표식을 붙이고 이어 쓴다
  const KNOWN = new Set(["rounds", "answers", "session.json", "summary.md", "server.json", ".lock", ".DS_Store"]);
  const entries = readdirSync(DIR);
  if (entries.length > 0 && !(existsSync(join(DIR, "session.json")) && entries.every((e) => KNOWN.has(e)))) {
    console.error(`${DIR} 은 grill-web 폴더가 아닙니다(표식 없음, 파일 있음). 비어 있는 폴더나 전용 폴더를 GRILL_WEB_DIR로 지정하세요.`);
    process.exit(2);
  }
  writeFileSync(MARKER(), "grill-web state directory\n");
}

// 폴더 단위 배타 잠금. mkdir은 원자적이라 동시에 두 up이 들어와도 하나만 잡는다. 30초 넘은 잠금은 죽은 프로세스 것으로 보고 거둔다.
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureOwned();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { mkdirSync(LOCK()); break; } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const age = Date.now() - statSync(LOCK()).mtimeMs;
      if (age > 30_000 && attempt === 0) { rmSync(LOCK(), { recursive: true, force: true }); continue; }
      console.error(`다른 grill-web 명령이 ${DIR} 을 쓰는 중입니다. 잠시 뒤 다시 하세요.`);
      process.exit(5);
    }
  }
  try { return await fn(); } finally { rmSync(LOCK(), { recursive: true, force: true }); }
}

// grill-web이 만든 것만 지운다. 상태 폴더 자체는 건드리지 않는다.
function reset(title: string) {
  ensureOwned();
  for (const child of ["rounds", "answers"]) rmSync(join(DIR, child), { recursive: true, force: true });
  for (const f of ["session.json", "summary.md"]) rmSync(join(DIR, f), { force: true });
  mkdirSync(roundsDir(), { recursive: true });
  mkdirSync(answersDir(), { recursive: true });
  writeFileSync(join(DIR, "session.json"), JSON.stringify({ id: randomUUID(), title, startedAt: new Date().toISOString() }, null, 2));
}

// 포트 상태. "ours"는 같은 상태 폴더를 쓰는 grill-web이 떠 있음, "other"는 다른 프로세스(다른 폴더의 grill-web 포함)가 점유, "free"는 비어 있음.
async function portState(port = PORT): Promise<"ours" | "other" | "free"> {
  try {
    const res = await fetch(`${urlFor(port)}/api/health`, { signal: AbortSignal.timeout(500) });
    const body = await res.json().catch(() => null);
    return body?.app === "grill-web" && body?.dir === DIR ? "ours" : "other";
  } catch {
    return "free";
  }
}

// 답변이 라운드 파일과 맞는지 검사한다. 문제가 없으면 빈 배열.
function validateAnswers(round: any, body: any): string[] {
  const problems: string[] = [];
  if (!Array.isArray(body?.answers)) return ["answers 배열이 없습니다"];
  const questions: any[] = Array.isArray(round?.questions) ? round.questions : [];
  const seen = new Set<number>();
  for (const a of body.answers) {
    const q = questions.find((x) => x.n === a?.n);
    if (!q) { problems.push(`질문 ${a?.n}은 이 라운드에 없습니다`); continue; }
    if (seen.has(q.n)) { problems.push(`질문 ${q.n} 답이 두 번 왔습니다`); continue; }
    seen.add(q.n);
    if (typeof a.note !== "string") problems.push(`Q${q.n}: note는 문자열이어야 합니다`);
    if (a.skipped === true) { if (a.value !== null) problems.push(`Q${q.n}: 미룬 답은 value가 null이어야 합니다`); continue; }
    const v = a.value;
    switch (q.kind) {
      case "yesno": if (v !== "yes" && v !== "no") problems.push(`Q${q.n}: yes 또는 no여야 합니다`); break;
      case "choice":
        if (typeof v !== "string" || !v.trim()) problems.push(`Q${q.n}: 선택값이 비었습니다`);
        else if (!(q.options ?? []).includes(v) && a.other !== true) problems.push(`Q${q.n}: options 밖의 값은 other: true와 함께 보내야 합니다`);
        break;
      case "multi":
        if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !(q.options ?? []).includes(x))) problems.push(`Q${q.n}: options 안의 값만 고를 수 있습니다`);
        break;
      case "range": {
        const min = q.min ?? 0, max = q.max ?? 100;
        if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) problems.push(`Q${q.n}: ${min}과 ${max} 사이 숫자여야 합니다`);
        break;
      }
      case "text": if (typeof v !== "string" || !v.trim()) problems.push(`Q${q.n}: 답이 비었습니다`); break;
      default: problems.push(`Q${q.n}: 알 수 없는 kind "${q.kind}"`);
    }
  }
  for (const q of questions) if (!seen.has(q.n)) problems.push(`Q${q.n} 답이 없습니다`);
  return problems;
}

function serve() {
  ensureOwned();
  // 세션 id가 생기기 전 버전의 session.json이면 id를 붙여 준다. 그래야 그 세션의 답변을 받을 수 있다
  const legacy = readJson(join(DIR, "session.json"));
  if (legacy && !legacy.id) writeFileSync(join(DIR, "session.json"), JSON.stringify({ id: randomUUID(), ...legacy }, null, 2));
  mkdirSync(roundsDir(), { recursive: true });
  mkdirSync(answersDir(), { recursive: true });
  // 이 폴더를 어느 서버가 맡고 있는지 남긴다. up이 다른 포트의 살아 있는 서버를 찾아 재사용하는 근거
  writeFileSync(join(DIR, "server.json"), JSON.stringify({ pid: process.pid, port: PORT }));
  const localHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(req) {
      const { pathname } = new globalThis.URL(req.url);
      // 모든 경로에서 Host를 본다. DNS 리바인딩으로 다른 이름을 달고 오면 읽기도 막는다.
      if (!localHosts.includes(req.headers.get("host") ?? "")) return Response.json({ error: "로컬 주소로만 접근할 수 있습니다" }, { status: 403 });
      if (pathname === "/api/health") return Response.json({ ok: true, app: "grill-web", dir: DIR });
      if (pathname === "/api/state") return Response.json(state());
      if (pathname === "/api/answers" && req.method === "POST") {
        // 폼에서 온 요청만 받는다. 다른 사이트가 브라우저를 시켜 보내는 단순 POST(text/plain)와 DNS 리바인딩을 막는다.
        const origin = req.headers.get("origin");
        const ctype = req.headers.get("content-type") ?? "";
        if ((origin && !localHosts.some((h) => origin === `http://${h}`)) || !ctype.startsWith("application/json")) {
          return Response.json({ error: "이 폼에서 보낸 요청만 받습니다" }, { status: 403 });
        }
        const body = await req.json().catch(() => null);
        const n = Number(body?.round);
        if (!Number.isFinite(n)) return Response.json({ error: "round가 필요합니다" }, { status: 400 });
        const current = readJson(join(DIR, "session.json"))?.id ?? null;
        if (!body?.session || body.session !== current) {
          return Response.json({ error: "다른 세션의 답변입니다. 페이지를 새로 고치세요" }, { status: 409 });
        }
        const r = readRound(join(roundsDir(), `${n}.json`));
        if (!r) return Response.json({ error: `${n}라운드가 없습니다` }, { status: 404 });
        if (typeof body.rev !== "string") return Response.json({ error: "rev가 필요합니다" }, { status: 400 });
        if (body.rev !== r.rev) return Response.json({ error: "질문이 바뀌었습니다. 화면을 확인하고 다시 보내세요" }, { status: 409 });
        const problems = validateAnswers(r.data, body);
        if (problems.length) return Response.json({ error: problems.join(", ") }, { status: 400 });
        const path = join(answersDir(), `${n}.json`);
        const prev = readJson(path);
        if (prev && prev.rev === r.rev) return Response.json({ error: "이미 보낸 라운드입니다" }, { status: 409 });
        // 옛 판에 대한 답이 남아 있으면(질문이 바뀐 뒤) 덮어쓴다
        // 어느 세션의 어느 판에 대한 답인지 함께 남긴다. wait가 이걸로 남의 답을 거른다
        writeAtomic(path, JSON.stringify({ session: current, round: n, rev: r.rev, answers: body.answers, submittedAt: new Date().toISOString() }, null, 2));
        return Response.json({ ok: true });
      }
      if (pathname === "/") return new Response(Bun.file(HTML), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (pathname === "/sanitize.js") return new Response(Bun.file(SANITIZE_JS), { headers: { "content-type": "text/javascript; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`grill-web ${URL} (state: ${DIR})`);
}

async function up(title: string) {
  const port = await withLock(async () => {
    // 이 폴더를 이미 맡고 있는 서버가 다른 포트에 살아 있으면 그쪽을 쓴다. 한 폴더에 서버 둘이 붙는 일을 막는다
    let port = PORT;
    const owner = readJson(join(DIR, "server.json"));
    if (owner?.port && owner.port !== PORT && (await portState(owner.port)) === "ours") port = owner.port;
    const state = await portState(port);
    if (state === "other") {
      console.error(`포트 ${port}를 다른 프로세스가 쓰고 있습니다(다른 상태 폴더의 grill-web일 수도 있습니다). GRILL_WEB_PORT로 다른 포트를 지정하거나 그 프로세스를 끄세요.`);
      process.exit(2);
    }
    reset(title);
    if (state === "free") {
      const child = Bun.spawn([process.execPath, import.meta.path, "serve"], {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
        env: { ...process.env, GRILL_WEB_PORT: String(port) },
      });
      child.unref();
      for (let i = 0; i < 40 && (await portState(port)) !== "ours"; i++) await Bun.sleep(100);
    }
    return port;
  });
  if (!process.env.GRILL_WEB_NO_OPEN) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([opener, urlFor(port)], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  }
  console.log(`${urlFor(port)} 열었습니다. 상태 폴더: ${DIR}. 라운드는 ${roundsDir()}/<n>.json 에 쓰세요.`);
}

async function wait(n: number, maxSeconds = 570) {
  const path = join(answersDir(), `${n}.json`);
  const roundPath = join(roundsDir(), `${n}.json`);
  const sessionId = readJson(join(DIR, "session.json"))?.id ?? null;
  const rev = readRound(roundPath)?.rev ?? null;
  if (!rev) { console.error(`${roundPath} 이 없거나 JSON이 아닙니다.`); process.exit(1); }
  console.error(`기다리는 중: ${n}라운드 (${rev})`);
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    // 기다리는 사이 새 인터뷰가 시작됐으면 이 라운드는 끝난 것이다. 남의 답을 집어 오지 않는다
    if ((readJson(join(DIR, "session.json"))?.id ?? null) !== sessionId) {
      console.error("기다리는 동안 새 세션이 시작됐습니다. 이 라운드는 버리고 처음부터 다시 진행하세요.");
      process.exit(4);
    }
    // 라운드 파일이 바뀌었으면 지금 기다리는 판은 무효다. 새 판으로 다시 기다린다
    if ((readRound(roundPath)?.rev ?? null) !== rev) {
      console.error(`${n}라운드 파일이 바뀌었습니다. wait ${n} 을 다시 실행하세요.`);
      process.exit(6);
    }
    const answer = readJson(path);
    if (answer && answer.rev === rev) {
      if (answer.session !== sessionId) {
        console.error("다른 세션의 답변 파일입니다. 처음부터 다시 진행하세요.");
        process.exit(4);
      }
      console.log(JSON.stringify(answer, null, 2));
      return;
    }
    await Bun.sleep(500);
  }
  console.error(`아직 ${n}라운드 답변이 없습니다. 같은 명령을 다시 실행해 계속 기다리세요.`);
  process.exit(3);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "up":
    await up(arg ?? "");
    break;
  case "serve":
    serve();
    break;
  case "reset":
    await withLock(async () => reset(arg ?? ""));
    console.log(`초기화: ${DIR}`);
    break;
  case "wait":
    await wait(Number(arg));
    break;
  default:
    console.error("사용법: bun server.ts up <주제> | serve | wait <n> | reset <주제>");
    process.exit(1);
}
