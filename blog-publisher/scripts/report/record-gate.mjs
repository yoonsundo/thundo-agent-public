// record-gate.mjs — 결정론 게이트 결과를 오늘의 run.json에 멱등 기록.
// 목적: `npm run gate` 가 남긴 runs/<날짜>/gates/<writer>.gate.json 의 게이트 판정을
//       daily-brief 호환 스키마(drafts[].attempts[last].gate_gates)로 조인한다.
//       이게 없으면 실런에서 gate_gates 가 항상 [] 라 대시보드 게이트 열이 0/0 으로 뜬다
//       (게이트는 실제로 돌았는데 결과가 run.json 에 안 실림). record-validator 와 대칭.
//
// 사용: node scripts/report/record-gate.mjs <slug> <writer> [gateFile]
//   gateFile 기본값: runs/<오늘>/gates/<writer>.gate.json
//   예: node scripts/report/record-gate.mjs my-post beaver
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

const [slug, writer, gateFileArg] = process.argv.slice(2);

if (!slug || !writer) {
  console.error('사용: node scripts/report/record-gate.mjs <slug> <writer> [gateFile]');
  process.exit(2);
}

const DATE = new Date().toISOString().slice(0, 10);
const dir = `runs/${DATE}`;
const path = `${dir}/run.json`;
const gateFile = gateFileArg || `${dir}/gates/${writer}.gate.json`;

// 게이트 산출물 로드(없으면 오류 — record-gate 는 npm run gate 이후에 부른다).
let gateOut;
try {
  gateOut = JSON.parse(readFileSync(gateFile, 'utf8'));
} catch {
  console.error(`[record-gate] 게이트 산출물 없음: ${gateFile} (npm run gate 를 먼저 실행)`);
  process.exit(2);
}
// 대시보드엔 gate·pass·reason 만 필요 — 부피 큰 evidence 는 제외해 run.json 경량 유지.
const gates = (Array.isArray(gateOut.gates) ? gateOut.gates : [])
  .map(g => ({ gate: g.gate, pass: !!g.pass, reason: g.reason || '' }));

// run.json 로드(없으면 초기화). 기존 다른 필드(published 등)는 모두 보존.
let run;
try {
  run = JSON.parse(readFileSync(path, 'utf8'));
} catch {
  run = { date: DATE, status: 'ok', drafts: [] };
}

// drafts 배열 보장(레거시 스키마엔 없음 — 다른 필드는 건드리지 않고 배열만 추가).
if (!Array.isArray(run.drafts)) run.drafts = [];

// slug 로 draft 찾기(없으면 생성).
let draft = run.drafts.find(d => d && d.slug === slug);
if (!draft) {
  draft = { slug, writer, title: slug, attempts: [{ gate_gates: [], reviews: [] }] };
  run.drafts.push(draft);
}
if (!Array.isArray(draft.attempts) || draft.attempts.length === 0) {
  draft.attempts = [{ gate_gates: [], reviews: [] }];
}

// 마지막 attempt 의 gate_gates 갱신(reviews 는 record-validator 가 쓴 걸 보존).
const last = draft.attempts[draft.attempts.length - 1];
if (!Array.isArray(last.reviews)) last.reviews = [];
last.gate_gates = gates;

// ── pack_adoption 집계 (ralplan v6 S2 — 결정론 산출, 산문 지시 금지) ──────────
// excerpt 를 준비했는데(= runs/<date>/sources/*.json 존재) 작가가 frontmatter 에
// source_pack 을 기록했는가. sheepdog 이 "0 이 3일 연속" 경보를 이 값에 건다 —
// 추출(excerpt_coverage)이 건강해도 채택이 0 이면 게이트16 이 조용히 무력화되기 때문.
try {
  const { readdirSync: rd } = await import('node:fs');
  let packs = 0;
  try { packs = rd(`${dir}/sources`).filter(f => f.endsWith('.json')).length; } catch { packs = 0; }
  if (packs > 0) {
    let adopted = 0;
    let draftsFiles = [];
    try { draftsFiles = rd(`${dir}/drafts`).filter(f => f.endsWith('.md')); } catch { draftsFiles = []; }
    for (const f of draftsFiles) {
      try { if (/^source_pack:\s*\S/m.test(readFileSync(`${dir}/drafts/${f}`, 'utf8').slice(0, 2000))) adopted++; }
      catch { /* 개별 파일 실패 무시 */ }
    }
    run.pack_adoption = `${adopted}/${packs}`;
  }
} catch { /* 집계 실패는 기록 자체를 막지 않는다 */ }

// 원자적 쓰기(임시파일 → rename).
mkdirSync(dir, { recursive: true });
const tmp = `${path}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(run, null, 1), 'utf8');
renameSync(tmp, path);

const passed = gates.filter(g => g.pass).length;
console.log(`[record-gate] ${DATE} ${slug} gates ${passed}/${gates.length} (all_pass=${!!gateOut.all_pass})`);
