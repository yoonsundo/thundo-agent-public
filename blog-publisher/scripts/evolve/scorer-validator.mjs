// scorer-validator.mjs — 검증자(bee) 진화 채점기 (3권분립의 '채점' 담당, elephant 와 독립).
// 작가용 scorer.mjs 와 달리 글을 생성하지 않는다 — 라벨된 골든셋(benchmark/validator-labels.json)에
// bee 변종(EVOLVE-BLOCK)을 실행해 판정 정확도를 fitness 로 계산한다. 설계: docs/bee-aeo-design.md §2.2.
//
//   validator_fitness = 50·TPR + 40·TNR − 10·중복fail율   (0~90 스케일)
//     TPR       = expect=pass 표본에 pass 를 준 비율 (양품을 통과시키는가)
//     TNR       = expect=fail 표본에 fail, expect=flag 표본에 플래그≥1 을 준 비율 (불량을 잡는가)
//     중복fail율 = fail reasons 가 결정론 게이트 담당 항목(음절 수·H2 개수 등)을 중복 인용한 비율
//
// 사용:
//   node scripts/evolve/scorer-validator.mjs --dry            # 라벨·파일 정합만 검사 (API 불필요)
//   node scripts/evolve/scorer-validator.mjs --self-test      # 지표 계산 단위 테스트 (API 불필요)
//   node scripts/evolve/scorer-validator.mjs [--sample N]     # 실채점 (ANTHROPIC_API_KEY 필요)
// evolve-cycle.mjs 에서는 scoreValidatorVariant() 를 import 해 사용.
import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { claudeText } from '../lib/claude-cli.mjs';
const LABELS_PATH = 'benchmark/validator-labels.json';
const CRITERIA_PATH = 'config/aeo-criteria.json';
const W = { tpr: 50, tnr: 40, dup: 10 };
// 결정론 게이트가 담당하는 항목 — bee 가 fail 사유로 재사용하면 계약 위반(중복 fail)
const DUP_RE = /음절\s*수|글자\s*수|H2\s*(개수|섹션\s*수)|1500|2000|kebab|마크다운\s*린트/;

function log(m) { console.log(`[scorer-validator] ${m}`); }

/** 라벨 로드 → [{path, expect}] (glob 먼저, files 오버라이드) */
export function loadLabeledSet(labelsPath = LABELS_PATH) {
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
  const map = new Map();
  for (const g of labels.globs || []) {
    const m = g.pattern.match(/^(.+)\/\*\.md$/);
    if (!m) throw new Error(`지원하지 않는 glob: ${g.pattern} ("<dir>/*.md" 만 지원)`);
    if (!existsSync(m[1])) continue;
    for (const f of readdirSync(m[1]).filter(f => f.endsWith('.md'))) {
      map.set(`${m[1]}/${f}`, g.expect);
    }
  }
  for (const f of labels.files || []) map.set(f.path, f.expect);
  const set = [...map.entries()].map(([path, expect]) => ({ path, expect }));
  const missing = set.filter(s => !existsSync(s.path));
  if (missing.length) throw new Error(`라벨 파일 부재: ${missing.map(m => m.path).join(', ')}`);
  return set;
}

/** bee 변종 프롬프트 구성 — EVOLVE-BLOCK(변종) + AEO 기준 데이터(고정) + 초안 */
function buildPrompt({ evolveBlock, criteria, draft }) {
  const activeLlm = (criteria.criteria || []).filter(c => c.status === 'active');
  return `너는 bee — SEO/AEO 검증자다. 아래 역할(EVOLVE-BLOCK)과 AEO 기준 데이터에 따라 초안을 검증하고 Review JSON 만 출력하라(설명·코드펜스 금지).

=== 역할/휴리스틱 (EVOLVE-BLOCK) ===
${evolveBlock}

=== AEO 기준 데이터 (config/aeo-criteria.json v${criteria.version}, status=active) ===
${activeLlm.map(c => `- [${c.id}] ${c.claim}\n  검사: ${c.check} (weight=${c.weight})`).join('\n')}

=== 검증 대상 초안 ===
${draft}

=== 출력 (Review JSON 한 개만 — reasons·flags·aeo_flags 는 각 최대 3개, issue 는 한 문장으로 짧게) ===
{"draft_id":"eval","validator":"bee","verdict":"pass|fail","authority":"advisory","reasons":[],"flags":[{"type":"...","location":"...","issue":"..."}],"seo_scores":{},"criteria_version":${criteria.version},"aeo_scores":{},"aeo_flags":[{"criterion_id":"...","location":"...","issue":"..."}],"checked_at":"<ISO8601>"}`;
}

async function callBee({ prompt, apiKey, model }) {
  // 구독(Claude Code) claude -p 로 채점 — API 종량제 대체. apiKey 는 미사용(하위호환).
  const raw = await claudeText({ prompt, model });
  const text = raw.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Review JSON 파싱 실패');
  return JSON.parse(m[0]);
}

/** 리뷰 1건을 기대 라벨과 대조 → {hit, dup} */
export function judgeReview(review, expect) {
  const verdict = review?.verdict === 'pass' ? 'pass' : 'fail';
  const flagCount = (review?.aeo_flags?.length || 0) + (review?.flags?.length || 0);
  const dup = verdict === 'fail' && (review?.reasons || []).some(r => DUP_RE.test(String(r)));
  let hit;
  if (expect === 'pass') hit = verdict === 'pass';
  else if (expect === 'fail') hit = verdict === 'fail';
  else hit = flagCount >= 1; // expect === 'flag' — advisory 항목은 verdict 무관, 플래그 탐지로 판정
  return { hit, dup, verdict, flagCount };
}

/** 표본 집합 → fitness 집계 */
export function aggregate(judged) {
  const pos = judged.filter(j => j.expect === 'pass');
  const neg = judged.filter(j => j.expect !== 'pass');
  const failVerdicts = judged.filter(j => j.verdict === 'fail');
  const tpr = pos.length ? pos.filter(j => j.hit).length / pos.length : 0;
  const tnr = neg.length ? neg.filter(j => j.hit).length / neg.length : 0;
  const dupRate = failVerdicts.length ? failVerdicts.filter(j => j.dup).length / failVerdicts.length : 0;
  const score = W.tpr * tpr + W.tnr * tnr - W.dup * dupRate;
  return { score, tpr, tnr, dup_rate: dupRate, n_pos: pos.length, n_neg: neg.length };
}

/**
 * bee EVOLVE-BLOCK 변종의 fitness 측정 — evolve-cycle·promote-criteria 에서 사용.
 * sample: expect=pass 표본 상한(비용 제어, 결정적 선두 N — Date/난수 없이 재현 가능). 부정 표본은 전수.
 * criteria: 기준셋 오버라이드(승격 게이트의 A/B 비교용) — 생략 시 CRITERIA_PATH 로드.
 * @returns {Promise<{score, tpr, tnr, dup_rate, n_pos, n_neg, misses}>}
 */
export async function scoreValidatorVariant({ evolveBlock, apiKey, model = 'claude-haiku-4-5', sample = 10, tag = 'base', criteria = null }) {
  criteria = criteria || JSON.parse(readFileSync(CRITERIA_PATH, 'utf8'));
  const set = loadLabeledSet();
  const pos = set.filter(s => s.expect === 'pass').slice(0, sample);
  const neg = set.filter(s => s.expect !== 'pass');
  const picked = [...pos, ...neg];
  const judged = [];
  for (const { path, expect } of picked) {
    const draft = readFileSync(path, 'utf8');
    let review;
    try { review = await callBee({ prompt: buildPrompt({ evolveBlock, criteria, draft }), apiKey, model }); }
    catch (e) { log(`채점 실패(${tag} ${path}): ${e.message}`); judged.push({ path, expect, hit: false, dup: false, verdict: 'error', flagCount: 0 }); continue; }
    judged.push({ path, expect, ...judgeReview(review, expect) });
  }
  const agg = aggregate(judged);
  return { ...agg, misses: judged.filter(j => !j.hit).map(j => `${j.expect}≠${j.verdict}(flags:${j.flagCount}) ${j.path}`) };
}

// ── 지표 계산 자체 테스트 (LLM 불필요 — 순수 산술) ─────────────────────────
function selfTest() {
  const eq = (a, b, msg) => { if (Math.abs(a - b) > 1e-9) throw new Error(`self-test 실패: ${msg} (${a} ≠ ${b})`); };
  // 완벽 판정: TPR=1, TNR=1, dup=0 → 90
  let j = [
    { expect: 'pass', ...judgeReview({ verdict: 'pass', reasons: [] }, 'pass') },
    { expect: 'fail', ...judgeReview({ verdict: 'fail', reasons: ['키워드 스터핑'] }, 'fail') },
    { expect: 'flag', ...judgeReview({ verdict: 'pass', aeo_flags: [{ criterion_id: 'x' }] }, 'flag') },
  ];
  eq(aggregate(j).score, 90, '완벽 판정 = 90');
  // 전부 오판 + 중복 fail: TPR=0, TNR=0, dup=1 → -10
  j = [
    { expect: 'pass', ...judgeReview({ verdict: 'fail', reasons: ['음절 수 1400 미달'] }, 'pass') },
    { expect: 'fail', ...judgeReview({ verdict: 'pass', reasons: [] }, 'fail') },
    { expect: 'flag', ...judgeReview({ verdict: 'pass', flags: [], aeo_flags: [] }, 'flag') },
  ];
  eq(aggregate(j).score, -10, '전오판+중복 = -10');
  // 중복 fail 탐지: H2 개수 인용
  if (!judgeReview({ verdict: 'fail', reasons: ['H2 개수 2개로 부족'] }, 'fail').dup) throw new Error('self-test 실패: H2 개수 중복 미탐지');
  // 정상 fail 사유는 중복 아님
  if (judgeReview({ verdict: 'fail', reasons: ['제목에 핵심 키워드 없음'] }, 'fail').dup) throw new Error('self-test 실패: 정상 사유를 중복 오탐');
  log('self-test 통과 (4/4)');
}

// ── CLI ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv.includes('--self-test')) { selfTest(); process.exit(0); }
  if (argv.includes('--dry')) {
    const set = loadLabeledSet();
    const byExpect = set.reduce((a, s) => ((a[s.expect] = (a[s.expect] || 0) + 1), a), {});
    JSON.parse(readFileSync(CRITERIA_PATH, 'utf8')); // 기준 파일 파싱 검증
    log(`dry OK — 표본 ${set.length}개 (${Object.entries(byExpect).map(([k, v]) => `${k}:${v}`).join(', ')}), 기준 파일 파싱 OK`);
    process.exit(0);
  }
  // 구독(Claude Code) 사용 — API 키 불필요. apiKey 는 하위호환 파라미터로만 전달(미사용).
  const apiKey = process.env.ANTHROPIC_API_KEY || null;
  const sample = parseInt((argv.find(a => a.startsWith('--sample=')) || '--sample=10').split('=')[1], 10);
  const md = readFileSync('.claude/agents/bee.md', 'utf8');
  const m = md.match(/<!--\s*EVOLVE-BLOCK:start version=(\d+)[^>]*-->([\s\S]*?)<!--\s*EVOLVE-BLOCK:end\s*-->/);
  if (!m) { log('bee.md EVOLVE-BLOCK 없음'); process.exit(2); }
  scoreValidatorVariant({ evolveBlock: m[2].trim(), apiKey, sample, tag: 'cli' })
    .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch(e => { log(`치명 오류: ${e.message}`); process.exit(2); });
}
