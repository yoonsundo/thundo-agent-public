// record-validator.mjs — 검증자 verdict를 오늘의 run.json에 멱등 기록.
// 목적: 검증자 4명(eagle/swan/raven/peacock) 차단권 심사 결과를 daily-brief 호환 스키마
//       (drafts[].attempts[last].reviews[]) 로 결정론적으로 기록해, LLM이 손으로 JSON을
//       짜다 생기는 실수를 없앤다. daily-brief.mjs buildPipeline 이 이 reviews[] 를 읽어
//       대시보드 검증자 tri-state(pass/blocked/unreached)를 만든다.
//
// 사용: node scripts/report/record-validator.mjs <slug> <writer> <validator> <verdict:pass|fail> [사유...]
//   예: node scripts/report/record-validator.mjs my-post beaver eagle pass "수치·출처 정합"
//       node scripts/report/record-validator.mjs my-post beaver raven fail "3섹션 진부표현 재진술"
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';

const [slug, writer, validator, verdict, ...reasonParts] = process.argv.slice(2);

if (!slug || !writer || !validator || !verdict) {
  console.error('사용: node scripts/report/record-validator.mjs <slug> <writer> <validator> <verdict:pass|fail> [사유...]');
  process.exit(2);
}
if (verdict !== 'pass' && verdict !== 'fail') {
  console.error(`[record-validator] verdict 는 pass|fail 이어야 함 (받음: ${verdict})`);
  process.exit(2);
}

const DATE = new Date().toISOString().slice(0, 10);
const dir = `runs/${DATE}`;
const path = `${dir}/run.json`;
const reasons = reasonParts.join(' ');

// 로드(없으면 초기화). 기존 다른 필드(published 등)는 모두 보존.
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

// 마지막 attempt 의 reviews[] 에서 같은 validator 항목 갱신(없으면 push).
const last = draft.attempts[draft.attempts.length - 1];
if (!Array.isArray(last.reviews)) last.reviews = [];
const existing = last.reviews.find(r => r && r.validator === validator);
if (existing) {
  existing.verdict = verdict;
  existing.reasons = reasons || '';
} else {
  last.reviews.push({ validator, verdict, reasons: reasons || '' });
}

// 원자적 쓰기(임시파일 → rename).
mkdirSync(dir, { recursive: true });
const tmp = `${path}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(run, null, 1), 'utf8');
renameSync(tmp, path);

console.log(`[record-validator] ${DATE} ${slug} ${validator}=${verdict}`);
