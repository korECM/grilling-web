// grill-web: 고정 폼을 서빙하고 라운드/답변 JSON을 파일로 주고받는 작은 서버.
//
//   bun server.ts up "주제"   상태 초기화 + 서버 기동(이미 떠 있으면 재사용) + 브라우저 열기
//   bun server.ts serve       포그라운드로 서버만 실행
//   bun server.ts wait <n>    answers/<n>.json 이 생길 때까지 기다렸다가 내용을 출력
//   bun server.ts reset "주제" 상태만 초기화
//
// 상태 디렉토리: $GRILL_WEB_DIR (기본 ~/.cache/grill-web)
//   session.json      { title, startedAt }
//   rounds/<n>.json   모델이 쓴 라운드
//   answers/<n>.json  폼이 쓴 답변
//   summary.md        있으면 폼이 마무리 화면으로 보여줌

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.GRILL_WEB_DIR ?? join(process.env.HOME ?? ".", ".cache", "grill-web");
const PORT = Number(process.env.GRILL_WEB_PORT ?? 4747);
const URL = `http://localhost:${PORT}`;
const HTML = join(import.meta.dir, "index.html");

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
    .map((f) => Number(f.replace(/\.json$/, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

function state() {
  const session = readJson(join(DIR, "session.json")) ?? { title: "" };
  const rounds = roundNumbers().map((n) => ({
    round: n,
    ...readJson(join(roundsDir(), `${n}.json`)),
    answers: readJson(join(answersDir(), `${n}.json`)),
  }));
  const summaryPath = join(DIR, "summary.md");
  const summary = existsSync(summaryPath) ? readFileSync(summaryPath, "utf8") : null;
  return { title: session.title, rounds, summary };
}

function reset(title: string) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(roundsDir(), { recursive: true });
  mkdirSync(answersDir(), { recursive: true });
  writeFileSync(join(DIR, "session.json"), JSON.stringify({ title, startedAt: new Date().toISOString() }, null, 2));
}

async function alive(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

function serve() {
  mkdirSync(roundsDir(), { recursive: true });
  mkdirSync(answersDir(), { recursive: true });
  Bun.serve({
    port: PORT,
    async fetch(req) {
      const { pathname } = new globalThis.URL(req.url);
      if (pathname === "/api/health") return Response.json({ ok: true });
      if (pathname === "/api/state") return Response.json(state());
      if (pathname === "/api/answers" && req.method === "POST") {
        const body = await req.json();
        const n = Number(body?.round);
        if (!Number.isFinite(n) || !Array.isArray(body?.answers)) {
          return Response.json({ error: "round와 answers가 필요합니다" }, { status: 400 });
        }
        const path = join(answersDir(), `${n}.json`);
        if (existsSync(path)) return Response.json({ error: "이미 보낸 라운드입니다" }, { status: 409 });
        writeFileSync(path, JSON.stringify({ ...body, submittedAt: new Date().toISOString() }, null, 2));
        return Response.json({ ok: true });
      }
      if (pathname === "/") return new Response(Bun.file(HTML), { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`grill-web ${URL} (state: ${DIR})`);
}

async function up(title: string) {
  reset(title);
  if (!(await alive())) {
    const child = Bun.spawn([process.execPath, import.meta.path, "serve"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    child.unref();
    for (let i = 0; i < 40 && !(await alive()); i++) await Bun.sleep(100);
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([opener, URL], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  console.log(`${URL} 열었습니다. 라운드는 ${roundsDir()}/<n>.json 에 쓰세요.`);
}

async function wait(n: number, maxSeconds = 570) {
  const path = join(answersDir(), `${n}.json`);
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      console.log(readFileSync(path, "utf8"));
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
    reset(arg ?? "");
    console.log(`초기화: ${DIR}`);
    break;
  case "wait":
    await wait(Number(arg));
    break;
  default:
    console.error("사용법: bun server.ts up <주제> | serve | wait <n> | reset <주제>");
    process.exit(1);
}
