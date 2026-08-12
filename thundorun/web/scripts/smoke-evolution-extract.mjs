/**
 * smoke-evolution-extract.mjs — 자가진화 '어디서' 추출(evolution.ts) 검증.
 *
 * 실행: (web/) node scripts/smoke-evolution-extract.mjs
 * node v20.6+ 네이티브 TS strip-types 로 순수 모듈 evolution.ts 를 직접 import.
 * DB·네트워크 미접촉 — daily-brief.mjs 가 만드는 elephant 레코드 형식을 그대로 흉내낸 픽스처만 사용.
 */
import { evolutionEntries, extractEvolution, verdictLabel } from '../src/server/evolution.ts';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.log(`  FAIL  ${name}`); failures++; }
}

// daily-brief.mjs 베이스라인·진화(5W1H) 형식 그대로 재현.
// beaver=과거 형식(evo 없음, legacy 폴백), fox=최신 형식(evo 상세 첨부).
const foxEvo = {
  writer: 'fox', verdict: 'adopt', version: 5,
  target_weakness: 'niche 이탈 (빈도집계 1위 — FAIL:niche 2회)',
  proposal: '보수적 +8줄: 니치 키워드 문단 사전배분·이탈 문장 삭감 규칙',
  scoring: 'continuous K=4: 40*density+30*niche+…',
  baseline: { score: 58.6, pass_rate: 0.25, avg_density: 0.36, avg_niche: 0.90, n: 4 },
  variant: { score: 61.2, pass_rate: 0.5, avg_density: 0.39, avg_niche: 0.94, n: 4 },
  improved: true, noRegress: true,
  note: '변종 score 61.2 > 59.8(=base×1.02) 개선마진 충족, 무회귀 → 채택. apply-evolve 호출, fox v6.',
};
const elephantRecords = [
  { when: '2026-07-03T05:10', where: 'state/evolve-history.jsonl', what: '검증 베이스라인 공식 갱신 (beaver 기준)', why: '기준 v3·score 88', how: 'scorer-validator 베이스라인' },
  { when: '2026-07-03T05:12', where: 'STEP7 → .claude/agents/beaver.md', what: '자가진화 판정=reject', why: 'fitness 15.2→14.5', how: '기각·현버전 유지(단조성)' },
  { when: '2026-07-03T05:14', where: 'STEP7 → .claude/agents/fox.md', what: '자가진화 판정=adopt', why: 'fitness 58.6→61.2', how: '채택·버전↑', evo: foxEvo },
];

// 1) evolutionEntries — 판정 레코드만(베이스라인 제외), 순서 보존, 필드 정확
const e = evolutionEntries(elephantRecords);
check('베이스라인 제외 — 판정 2건만 추출', e.length === 2);
check('첫 항목 writer=beaver (where 파싱)', e[0].writer === 'beaver');
check('첫 항목 verdict=reject', e[0].verdict === 'reject');
check('첫 항목 fitness 원문 보존', e[0].fitness === 'fitness 15.2→14.5');
check('첫 항목 where 원문 보존(어디서)', e[0].where === 'STEP7 → .claude/agents/beaver.md');
check('첫 항목 detail(how) 원문 보존', e[0].detail === '기각·현버전 유지(단조성)');
check('둘째 항목 writer=fox·verdict=adopt', e[1].writer === 'fox' && e[1].verdict === 'adopt');

// 1b) legacy(과거 행, evo 없음) → rich=false, 상세 필드 undefined
check('legacy 항목 rich=false', e[0].rich === false);
check('legacy 항목 targetWeakness/note undefined', e[0].targetWeakness === undefined && e[0].note === undefined);

// 1c) evo(최신 행) → rich=true, 상세 서사·지표 추출
const fox = e[1];
check('evo 항목 rich=true', fox.rich === true);
check('evo target_weakness → targetWeakness', fox.targetWeakness === foxEvo.target_weakness);
check('evo proposal 추출', fox.proposal === foxEvo.proposal);
check('evo note(판정 근거) 추출', fox.note === foxEvo.note);
check('evo version 추출', fox.version === 5);
check('evo baseline/variant score 추출', fox.baseScore === 58.6 && fox.variantScore === 61.2);
check('evo pass_rate 추출', fox.basePassRate === 0.25 && fox.variantPassRate === 0.5);
check('evo improved/noRegress 추출', fox.improved === true && fox.noRegress === true);
check('evo scoring 추출', fox.scoring === foxEvo.scoring);

// 1d) evo.writer 로 폴백 — where 파싱 실패해도 evo.writer 사용
const evoWriterFallback = evolutionEntries([
  { where: '경로없음', what: '자가진화 판정=adopt', why: '', how: '', evo: { writer: 'wolf', verdict: 'adopt' } },
]);
check('where 파싱 실패 시 evo.writer 폴백', evoWriterFallback[0].writer === 'wolf' && evoWriterFallback[0].rich === true);

// 2) extractEvolution — report.agents 에서 elephant 경유
const report = {
  date: '2026-07-03',
  agents: [
    { id: 'lion', records: [{ what: '오케스트레이션', where: '전체 런' }] },
    { id: 'elephant', records: elephantRecords },
  ],
};
const ex = extractEvolution(report);
check('extractEvolution 도 판정 2건', ex.length === 2);

// 3) 추출 개수 == KPI 개수 계약 (summary.evolve.length 정합)
const kpiCount = report.agents.find((a) => a.id === 'elephant').records.filter((r) => /자가진화 판정=/.test(r.what)).length;
check('추출 개수 == KPI 자가진화 개수', ex.length === kpiCount);

// 4) where 파싱 실패 시 writer='' (크래시 없음)
const missing = evolutionEntries([{ where: 'STEP7 → 경로없음', what: '자가진화 판정=adopt', why: '', how: '' }]);
check('where 파싱 실패 → writer 빈 문자열', missing.length === 1 && missing[0].writer === '');

// 5) 빈/과거 행/null 방어
check('elephant 없는 보고 → []', extractEvolution({ agents: [{ id: 'lion', records: [] }] }).length === 0);
check('agents 없는 보고 → []', extractEvolution({}).length === 0);
check('null 방어 → []', extractEvolution(null).length === 0 && evolutionEntries(null).length === 0);
check('elephant 레코드 없음 → []', extractEvolution({ agents: [{ id: 'elephant' }] }).length === 0);

// 6) verdictLabel
check('verdictLabel adopt→채택', verdictLabel('adopt') === '채택');
check('verdictLabel reject→기각', verdictLabel('reject') === '기각');
check('verdictLabel 미지정 verdict 원문 유지', verdictLabel('unknown') === 'unknown');

if (failures === 0) {
  console.log('\n✅ evolution 추출 스모크 전부 PASS');
  process.exit(0);
} else {
  console.error(`\n❌ ${failures}건 FAIL`);
  process.exit(1);
}
