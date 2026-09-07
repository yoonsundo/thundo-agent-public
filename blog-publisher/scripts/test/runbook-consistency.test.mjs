#!/usr/bin/env node
/**
 * runbook-consistency.test.mjs — **런북과 에이전트 정의가 서로 반대를 말하지 않는다.**
 *
 * 🔴 실제로 그런 일이 있었다(2026-09-07). 조작된 1인칭 서술을 막는 게이트17 을 만들면서
 *    에이전트 정의 셋은 "1인칭 실측 수치도 금지"로 고쳤는데, **정작 프로덕션 프롬프트인
 *    `daily-runbook.md` 에는 "1인칭 실측 수치는 자유"가 그대로 남아 있었다.** 게다가 같은
 *    커밋이 "근거·구체수치·1인칭 실측을 채우는 데 써라"는 새 줄을 **추가**했다.
 *
 *    그대로 뒀다면 다음 발행일에 이렇게 됐다:
 *      작가가 런북 지시대로 1인칭을 쓴다 → 게이트17 fail → 같은 지시로 3회 재시도 →
 *      **3회 실패 = 그날 발행 0편.** 조용히, 며칠 동안.
 *
 * 런북은 `claude -p "$(cat scripts/daily-runbook.md)"` 로 통째로 들어가는 **실제 프롬프트**다.
 * 여기 적힌 것이 곧 지시이므로, 게이트가 막는 것을 런북이 시키면 파이프라인이 자기를 문다.
 *
 * ⚠ 소스 문자열로 검사한다. 동작 테스트로는 "프롬프트가 뭐라고 말하는지"를 잡을 수 없다.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';
import { readFileSync, existsSync } from 'node:fs';

let passN = 0, failN = 0;
const ok = (n, c) => { if (c) { passN++; console.log(`  [PASS] ${n}`); } else { failN++; console.log(`  [FAIL] ${n}`); } };

const RUNBOOK = 'scripts/daily-runbook.md';
const WRITERS = ['beaver', 'fox', 'wolf'].map(w => `.claude/agents/${w}.md`);

if (!existsSync(RUNBOOK)) {
  console.log('  ⏭ 런북 없음 — 건너뜀');
} else {
  const rb = readFileSync(RUNBOOK, 'utf8');

  // ① 게이트17 이 막는 것을 런북이 허용하면 안 된다.
  ok('런북이 "1인칭 실측 수치는 자유"라고 말하지 않는다', !/1인칭 실측 수치는 자유/.test(rb));
  ok('  └ "1인칭 실측을 채우는 데 써라"고 시키지 않는다', !/1인칭 실측을 채우/.test(rb));
  ok('  └ 작가 제약에 "1인칭 경험+구체수치"를 요구하지 않는다', !/1인칭 경험\+구체수치/.test(rb));

  // ② 에이전트 정의와 방향이 같아야 한다.
  for (const f of WRITERS) {
    if (!existsSync(f)) { console.log(`  ⏭ ${f} 없음`); continue; }
    const src = readFileSync(f, 'utf8');
    ok(`${f.split('/').pop()} 가 1인칭 실측을 금지한다`, /1인칭 실측 수치도 금지/.test(src));
  }

  // ③ 관문 개수가 실제 게이트 수와 맞아야 한다 — 작가가 "게이트16" 만 통과하면 된다고 읽으면 안 된다.
  const gateCount = existsSync('scripts/gates')
    ? readFileSync('scripts/gates/run-all-gates.mjs', 'utf8').match(/check-[a-z-]+\.mjs/g)?.length ?? 0
    : 0;
  if (gateCount) {
    const m = rb.match(/발행 관문 = 결정론 게이트(\d+)/);
    ok(`런북의 관문 개수(${m?.[1] ?? '?'})가 실제 게이트 수(${gateCount})와 같다`,
      m && Number(m[1]) === gateCount);
  }
}

console.log(`\n런북 일관성: ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
