#!/usr/bin/env node
/**
 * board.test.mjs — 에이전트 회사화(경영회의) 유닛테스트.
 *
 * 이 테스트가 지키는 것은 두 가지다:
 *   ① **형식 미달 회의는 결론을 못 낸다** — 반론을 요구만 하고 검사하지 않으면 회의록은
 *      그럴듯한데 반론이 없는 문서가 된다.
 *   ② **이사회는 안전장치를 우회하는 두 번째 문을 만들 수 없다** — 팀장 자신·감시자·
 *      최종 방어선·보호 설정은 채택돼도 사람 승인으로 빠진다.
 * 순수 함수만 쓴다. claude·네트워크·크리덴셜 불필요. exit 0=통과 / 1=실패.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';

import { readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { validateCeoOutput, normalizeCeoOutput, collectProposals, globalProposalId, buildLeadPrompt, buildCeoPrompt, REBUTTAL_RULES, RISK_KINDS } =
  await import('../board/meeting.mjs');
const { routeDecision, normalizeTarget, isSafePath, feedbackKey, queueEvolveFeedback, BOARD_EVOLVABLE, PROTECTED_AGENTS, CONFIG_WHITELIST, CONFIG_DENY, applyConfigChange, applyDecisions } =
  await import('../board/apply.mjs');
const { distribution, kstDay } = await import('../board/collect.mjs');
const { STATUS_EXPLAIN, explainHold } = await import('../board/apply.mjs');
const { toApprovalRows, approvalKey, enqueueApprovals } = await import('../board/approvals.mjs');
const { publishBoard } = await import('../board/publish-board.mjs');
const { collectPending, windowStart, DEFAULT_WINDOW_DAYS } = await import('../board/backfill-approvals.mjs');
const { planApproved } = await import('../board/apply-approved.mjs');
const { EVOLVABLE_AGENTS } = await import('../evolve/apply-evolve.mjs');
const { renderMinutes } = await import('../board/run-board.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);


/** 형식을 모두 만족하는 CEO 산출물(여기서 한 항목씩 깎아 가며 검증력을 본다). */
const validCeo = (over = {}) => ({
  hidden_assumptions: [1, 2, 3].map(i => ({ assumption: `가정${i}`, evidence: `근거${i}` })),
  risks: RISK_KINDS.map(kind => ({ kind, risk: `${kind} 위험`, impact: '영향' })),
  logical_flaws: [{ flaw: '약한 근거', where: 'blog' }],
  overlooked_scenarios: ['시나리오1', '시나리오2'],
  preventive_measures: [{ for: '위험1', action: '조치1' }],
  decisions: [],
  ...over,
});

console.log('\n[1] CEO 반론 형식 강제');
{
  eq('완전한 산출물은 통과', validateCeoOutput(validCeo()).ok, true);

  // 숨은 가정 3건 미만 → 실패. "요구했으니 지키겠지"가 통하지 않아야 한다.
  const few = validateCeoOutput(validCeo({ hidden_assumptions: [{ assumption: 'a', evidence: 'b' }] }));
  ok('숨은 가정 3건 미만이면 회의 불성립', !few.ok, JSON.stringify(few.errors));
  ok('  └ 사유가 사람이 읽을 수 있게 나온다', few.errors.some(e => e.includes('숨은 가정')));

  // 개수만 채우고 근거가 없는 경우 — 가장 흔한 형식 통과 꼼수.
  const noEv = validateCeoOutput(validCeo({
    hidden_assumptions: [1, 2, 3].map(i => ({ assumption: `가정${i}`, evidence: '' })),
  }));
  ok('근거 없는 가정 나열은 통과 못 한다', !noEv.ok, JSON.stringify(noEv.errors));

  // 리스크를 기술만 3개 — 층위 요구를 회피하는 경우.
  const oneKind = validateCeoOutput(validCeo({
    risks: [1, 2, 3].map(i => ({ kind: 'technical', risk: `r${i}`, impact: 'i' })),
  }));
  ok('리스크가 한 층위에 몰리면 실패', !oneKind.ok);
  ok('  └ 누락 층위를 짚어 준다',
    oneKind.errors.some(e => e.includes('operational') && e.includes('organizational')));

  // 간과 시나리오는 상한도 있다(2~3). 열 개를 쏟아내는 것도 요구 위반이다.
  ok('간과 시나리오 1건이면 실패(하한은 딱딱하다)', !validateCeoOutput(validCeo({ overlooked_scenarios: ['하나'] })).ok);
  ok('간과 시나리오 3건은 통과', validateCeoOutput(validCeo({ overlooked_scenarios: ['1', '2', '3'] })).ok);

  /**
   * 상한은 성격이 다르다. 실가동 첫날 CEO 가 시나리오를 4건 냈다는 이유로 제안 11건과 반론
   * 전체가 폐기됐다 — 더 많이 짚은 것은 부실이 아니다. 그래서 상한 초과는 잘라내고 계속한다.
   */
  {
    const over = validCeo({ overlooked_scenarios: ['1', '2', '3', '4', '5'] });
    const { ceo, trimmed } = normalizeCeoOutput(over);
    eq('상한 초과는 잘라낸다', ceo.overlooked_scenarios.length, 3);
    ok('  └ 무엇을 잘랐는지 남긴다', trimmed.some(t => t.includes('간과된 시나리오')), JSON.stringify(trimmed));
    ok('  └ 자른 뒤에는 통과한다', validateCeoOutput(ceo).ok);
    ok('  └ 하한 항목은 자르지 않는다', normalizeCeoOutput(validCeo()).trimmed.length === 0);
  }

  eq('규칙 5종이 모두 정의돼 있다', Object.keys(REBUTTAL_RULES).length, 5);
}

console.log('\n[2] 제안 판정 누락 차단');
{
  const proposals = [
    { gid: 'blog:P1', team: 'blog', target_type: 'agent', target: 'beaver', change: 'c' },
    { gid: 'youtube:P1', team: 'youtube', target_type: 'agent', target: 'lynx', change: 'c' },
  ];
  const missed = validateCeoOutput(validCeo({
    decisions: [{ proposal_id: 'blog:P1', verdict: 'adopt', reason: 'r' }],
  }), proposals);
  ok('제안을 조용히 빠뜨리면 실패', !missed.ok);
  ok('  └ 빠진 제안 id 를 지목한다', missed.errors.some(e => e.includes('youtube:P1')));

  const noReason = validateCeoOutput(validCeo({
    decisions: proposals.map(p => ({ proposal_id: p.gid, verdict: 'adopt', reason: '' })),
  }), proposals);
  ok('판정 사유가 비면 실패', !noReason.ok);

  const badVerdict = validateCeoOutput(validCeo({
    decisions: proposals.map(p => ({ proposal_id: p.gid, verdict: '통과', reason: 'r' })),
  }), proposals);
  ok('알 수 없는 판정값은 실패', !badVerdict.ok);

  eq('팀 접두사로 제안 id 가 전역 유일해진다', globalProposalId('blog', 'P1'), 'blog:P1');
  const briefs = [
    { team: 'blog', brief: { proposals: [{ id: 'P1' }] } },
    { team: 'youtube', brief: { proposals: [{ id: 'P1' }] } },
  ];
  eq('같은 P1 두 개가 충돌하지 않는다', new Set(collectProposals(briefs).map(p => p.gid)).size, 2);
}

console.log('\n[3] 이사회 권한 경계 — 우회로가 생기지 않는다');
{
  const adopt = { verdict: 'adopt', reason: 'r' };
  const agent = (target) => ({ target_type: 'agent', target, change: 'c' });

  eq('팀원 문구는 자가발전 큐로', routeDecision(adopt, agent('beaver')).route, 'evolve_queue');

  /**
   * 🔴 큐에 넣을 수 있는 대상은 **적용기가 실제로 받아 주는 것뿐**이어야 한다.
   * 처음엔 다른 팀 창작자(raccoon·nightingale 등)까지 넣었는데, evolve-cycle 은 그들을 순회하지
   * 않고 apply-evolve 는 거부한다 → 큐에 쌓이기만 하고 영원히 처리되지 않는 **죽은 편지**였다.
   * 화면에는 "자가발전 큐"로 찍히니 진행 중인 것처럼 보이는 정지가 된다.
   */
  eq('화이트리스트가 적용기 목록과 정확히 같다',
    [...BOARD_EVOLVABLE].sort().join(','), [...EVOLVABLE_AGENTS].sort().join(','));
  for (const t of ['raccoon', 'nightingale', 'lynx', 'heron', 'deer', 'robin']) {
    eq(`처리기 없는 ${t} 는 큐에 넣지 않는다`, routeDecision(adopt, agent(t)).route, 'human');
  }
  ok('  └ 사유가 "권한 없음"이 아니라 "처리기 없음"이다',
    /채점기가 아직 없다/.test(routeDecision(adopt, agent('raccoon')).reason),
    routeDecision(adopt, agent('raccoon')).reason);

  for (const lead of ['falcon', 'dolphin', 'rhino', 'panther']) {
    eq(`팀장(${lead}) 자기수정은 사람 승인`, routeDecision(adopt, agent(lead)).route, 'human');
  }
  eq('CEO(lion) 도 사람 승인', routeDecision(adopt, agent('lion')).route, 'human');
  for (const guard of ['crane', 'meerkat', 'sheepdog', 'elephant']) {
    eq(`감시자(${guard}) 는 사람 승인`, routeDecision(adopt, agent(guard)).route, 'human');
  }
  for (const last of ['badger', 'hedgehog']) {
    eq(`최종 방어선(${last}) 은 사람 승인`, routeDecision(adopt, agent(last)).route, 'human');
  }
  ok('팀장·CEO·감시자는 화이트리스트에 없다',
    ['falcon', 'dolphin', 'rhino', 'panther', 'lion', 'crane', 'elephant', 'badger', 'hedgehog']
      .every(n => !BOARD_EVOLVABLE.has(n)));
  ok('  └ 그리고 보호 대상으로 명시돼 사유가 구분된다',
    ['falcon', 'lion', 'crane', 'badger', 'hedgehog'].every(n => PROTECTED_AGENTS.has(n)));
  ok('  └ 보호 대상 사유는 "권한 없음"이다',
    /이사회가 바꿀 수 없다/.test(routeDecision(adopt, agent('falcon')).reason));

  eq('채택이 아니면 아무 일도 없다', routeDecision({ verdict: 'reject', reason: 'r' }, agent('beaver')).route, 'skip');
  eq('보류도 마찬가지', routeDecision({ verdict: 'defer', reason: 'r' }, agent('beaver')).route, 'skip');
}

console.log('\n[3b] 대상 문자열 정규화 — 자동 반영이 무력해지지 않게');
{
  /**
   * 실가동 첫날(2026-08-21) 채택 8건 중 7건이 전부 "사람 승인 필요"로 빠졌다.
   * 원인은 권한 경계가 아니라 **문자열 매칭**이었다 — 팀장이 대상을 `lynx (호기심채널 큐레이터)`
   * 처럼 설명을 붙여 써서 화이트리스트 조회가 빗나갔다. 경계가 작동한 것처럼 보였지만
   * 사실은 자동 반영 경로가 통째로 죽어 있었다.
   */
  const adopt = { verdict: 'adopt', reason: 'r' };
  eq('설명이 붙어도 식별자만 뽑는다', normalizeTarget('lynx (호기심채널 큐레이터)'), 'lynx');
  eq('공백은 잘라낸다', normalizeTarget('  raccoon  '), 'raccoon');
  eq('점 경로는 보존한다', normalizeTarget('pick.weights.surprise (선정 가중치)'), 'pick.weights.surprise');
  eq('한글만 있으면 빈 값', normalizeTarget('선정 가중치 조정'), '');
  eq('빈 입력도 안전', normalizeTarget(null), '');

  eq('설명 붙은 팀원은 큐로 간다',
    routeDecision(adopt, { target_type: 'agent', target: 'beaver (how-to 작가)', change: 'c' }).route, 'evolve_queue');
  // ⚠ 정규화가 경계를 무르게 만들면 안 된다 — 팀장은 설명이 붙어도 여전히 막혀야 한다.
  eq('설명 붙은 팀장은 그래도 막힌다',
    routeDecision(adopt, { target_type: 'agent', target: 'falcon (블로그팀장)', change: 'c' }).route, 'human');
  eq('설명 붙은 보호 설정도 그대로 막힌다',
    routeDecision(adopt, { target_type: 'config', target: 'pick.daily_target (일일 편수)', change: 'c' }).route, 'human');
  eq('설명 붙은 허용 설정은 통과',
    routeDecision(adopt, { target_type: 'config', target: 'backlog.angles.whatif_ratio (앵글 비율)', change: 'c' }).route, 'config');
}

console.log('\n[4] 설정 변경 경계');
{
  const adopt = { verdict: 'adopt', reason: 'r' };
  const cfg = (target) => ({ target_type: 'config', target, change: 'c' });

  eq('허용 키는 적용 경로로', routeDecision(adopt, cfg('backlog.angles.whatif_ratio')).route, 'config');

  // 보호 설정 — 회의가 스스로 열 수 없어야 하는 것들.
  const denied = ['pick.daily_target', 'upload.daily_cap', 'pick.similarity.topic_jaccard',
    'publish.enabled', 'budget.daily_hard_cap'];
  for (const k of denied) eq(`보호 설정(${k}) 은 사람 승인`, routeDecision(adopt, cfg(k)).route, 'human');
  ok('보호 사유가 사람이 읽을 수 있게 나온다',
    /사용자 결정|안전값|마스터 스위치|예산/.test(routeDecision(adopt, cfg('pick.daily_target')).reason));

  eq('목록에 없는 키는 사람 승인', routeDecision(adopt, cfg('아무거나')).route, 'human');

  // change 문장으로 우회하는 시도 — 키는 멀쩡한데 내용이 상한 완화인 경우.
  const sneaky = routeDecision(adopt, { target_type: 'config', target: 'backlog.angles.whatif_ratio', change: 'daily_cap 을 5로 올린다' });
  eq('설명문으로 보호 설정을 건드리려 해도 막힌다', sneaky.route, 'human');
}

console.log('\n[5] 설정 적용 — 범위와 형식');
{
  const p = { target_type: 'config', target: 'backlog.angles.whatif_ratio' };
  eq('숫자 없으면 적용 안 함',
    applyConfigChange(p, { reason: 'r' }).ok, false);
  eq('  └ 사유가 명확하다',
    /숫자/.test(applyConfigChange(p, { reason: 'r' }).reason), true);
  eq('범위 밖이면 거부', applyConfigChange(p, { value: 1.5 }).ok, false);
  eq('음수도 거부', applyConfigChange(p, { value: -0.1 }).ok, false);
  ok('허용 목록 밖 키는 파일을 읽지도 않는다',
    applyConfigChange({ target_type: 'config', target: 'nope' }, { value: 0.5 }).ok === false);
  ok('가중치 키도 이제 허용 목록 밖이다',
    applyConfigChange({ target_type: 'config', target: 'pick.weights.surprise' }, { value: 0.3 }).ok === false);

  // 실제 쓰기는 스텁으로 — 테스트가 운영 설정을 건드리면 안 된다.
  let written = null;
  const r = applyConfigChange(p, { value: 0.4 }, {
    readFile: () => JSON.stringify({ backlog: { angles: { whatif_ratio: 0.1 } } }),
    writeFile: (_f, s) => { written = s; }, copyFile: () => {}, fileExists: () => true,
  });
  ok('허용 범위 값은 적용된다', r.ok && r.changed, JSON.stringify(r));
  eq('  └ 이전값을 기록한다', r.before, 0.1);
  ok('  └ 실제로 새 값이 쓰인다', written && JSON.parse(written).backlog.angles.whatif_ratio === 0.4);
}

console.log('\n[6] 수집기 — 없는 것을 지어내지 않는다');
{
  eq('KST 날짜키', kstDay(new Date('2026-08-20T15:30:00Z')), '2026-08-21');
  eq('잘못된 날짜는 빈 문자열', kstDay(new Date('nope')), '');
  const d = distribution([{ a: 'x' }, { a: 'x' }, { a: 'y' }], i => i.a);
  eq('분포 상위가 먼저', d[0].key, 'x');
  eq('  └ 비율 계산', d[0].pct, 67);
  eq('빈 표본은 빈 배열', distribution([], i => i).length, 0);
  eq('키가 없으면 미상', distribution([{}], i => i.a)[0].key, '미상');
}

console.log('\n[7] 회의록 — 미확정 회의가 확정처럼 보이지 않는다');
{
  const teams = [{ team: 'blog', lead: 'falcon', titles: ['CPO'], gaps: ['GSC 계측 없음'] }];
  const briefs = [{ team: 'blog', lead: 'falcon', brief: { headline: 'h', facts: ['f'], proposals: [] } }];
  const heldMd = renderMinutes({ date: '2026-08-21', teams, leadBriefs: briefs, ceo: null, results: [], held: '반론 형식 미달' });
  ok('미확정이면 회의록 맨 위에 경고', /결론 미확정/.test(heldMd));
  ok('  └ 아무것도 안 바뀌었다고 명시', /아무것도 변경하지 않았다/.test(heldMd));
  ok('계측 공백이 회의록에 실린다', /GSC 계측 없음/.test(heldMd));

  const okMd = renderMinutes({
    date: '2026-08-21', teams, leadBriefs: briefs, ceo: validCeo(),
    results: [{ proposal_id: 'blog:P1', verdict: 'adopt', target: 'beaver', status: 'queued', reason: 'r' }],
    held: null,
  });
  ok('확정 회의엔 경고가 없다', !/결론 미확정/.test(okMd));
  ok('queued 가 즉시 반영이 아님을 밝힌다', /즉시 적용 아님|즉시 반영 아님/.test(okMd));
  ok('반론 5종이 모두 회의록에 들어간다',
    ['숨은 가정', '잠재적 위험', '논리적 결함', '간과된 시나리오', '예방 조치'].every(h => okMd.includes(h)));
}

console.log('\n[8] 팀장 정의 파일 계약');
{
  const LEADS = { falcon: 'blog', dolphin: 'youtube', rhino: 'dev', panther: 'instagram' };
  for (const [name] of Object.entries(LEADS)) {
    const md = readFileSync(`.claude/agents/${name}.md`, 'utf8');
    const seed = (md.match(/<!--\s*SEED:locked\s*-->([\s\S]*?)<!--\s*\/SEED:locked\s*-->/) || [])[1] || '';
    ok(`${name}: 자기 진화 금지가 SEED 에 박혀 있다`,
      /자기 자신.*진화 대상으로 제안할 수 없다/.test(seed));
    ok(`${name}: C레벨 직책 명시`, /C[A-Z]O/.test(md));
    ok(`${name}: BRIEF 페르소나 존재`,
      /<!--\s*BRIEF:start\s*-->[\s\S]{50,}<!--\s*BRIEF:end\s*-->/.test(md));
  }
  // apply-evolve 원본 화이트리스트가 팀장을 포함하지 않는지 — 두 번째 문 방지.
  const ae = readFileSync('scripts/evolve/apply-evolve.mjs', 'utf8');
  ok('apply-evolve 화이트리스트에 팀장이 없다',
    !['falcon', 'dolphin', 'rhino', 'panther'].some(n => new RegExp(`'${n}'`).test(ae)));
}


console.log('\n[9] 리뷰 지적 보강 — 조용히 잘못 적용되는 경로 차단');
{
  const p = { target_type: 'config', target: 'backlog.angles.whatif_ratio' };

  /**
   * `Number(null)` 은 **0 이고 유한하다.** 예전 코드는 `Number(decision.value ?? proposal.value)`
   * 였는데 둘 다 null 이면 가중치가 조용히 0 으로 적용됐다 — 거부도 오류도 없이.
   */
  for (const bad of [null, undefined, '', '0.4', true, false, [], {}, NaN]) {
    const r = applyConfigChange(p, { value: bad });
    ok(`value=${JSON.stringify(bad)} 는 적용하지 않는다`, !r.ok, JSON.stringify(r));
  }
  ok('  └ 무엇을 받았는지 사유에 남긴다', /받은 값/.test(applyConfigChange(p, { value: null }).reason));
  // 0 은 "값 없음"이 아니라 유효한 값이다. 가중치는 변화폭 제한이 걸리므로, 폭 제한이 없는
  // 앵글 비율로 검증한다(0.05 → 0 은 "앵글을 끈다"는 정상적인 결정이다).
  ok('숫자 0 자체는 유효한 값이라 통과한다', applyConfigChange(
    { target_type: 'config', target: 'backlog.angles.whatif_ratio' }, { value: 0 },
    { readFile: () => JSON.stringify({ backlog: { angles: { whatif_ratio: 0.05 } } }),
      writeFile: () => {}, copyFile: () => {}, fileExists: () => true },
  ).ok);

  // 프로토타입 오염 — 화이트리스트가 1차 방어지만 경로 검사도 따로 둔다(이중 방어).
  eq('__proto__ 경로 거부', isSafePath('a.__proto__.b'), false);
  eq('constructor 경로 거부', isSafePath('a.constructor.b'), false);
  eq('prototype 경로 거부', isSafePath('prototype'), false);
  eq('빈 세그먼트 거부', isSafePath('a..b'), false);
  eq('정상 경로 통과', isSafePath('pick.weights.surprise'), true);

  // 테스트가 실제 설정 파일을 백업하면 안 된다 — copyFile 을 주입 가능하게 만든 이유.
  {
    let copied = null, wrote = null;
    applyConfigChange(p, { value: 0.4 }, {
      readFile: () => JSON.stringify({ backlog: { angles: { whatif_ratio: 0.1 } } }),
      writeFile: (_f, s2) => { wrote = s2; },
      copyFile: (from, to) => { copied = [from, to]; },
      fileExists: () => true,
    });
    ok('백업도 주입된 함수로 나간다(실제 파일 안 건드림)', copied?.[1]?.endsWith('.bak'), JSON.stringify(copied));
    ok('  └ 값은 정상 반영', JSON.parse(wrote).backlog.angles.whatif_ratio === 0.4);
  }
}

console.log('\n[10] 큐 멱등성 — 같은 날 재실행이 학습 신호를 오염시키지 않는다');
{
  /**
   * flock 은 **동시** 실행만 막는다. 하루에 두 번 순차 실행하면 같은 제안이 두 줄 쌓이고,
   * evolve-cycle 은 최근 10건을 빈도로 집계하므로 반복된 제안이 학습 신호를 지배한다.
   */
  const proposal = { gid: 'blog:P1', target: 'beaver', change: 'c' };
  eq('멱등키는 날짜+제안id', feedbackKey('2026-08-21', proposal), '2026-08-21:blog:P1');
  eq('  └ 날짜가 다르면 다른 키', feedbackKey('2026-08-22', proposal), '2026-08-22:blog:P1');

  const tmp = `/tmp/board-queue-test-${process.pid}.jsonl`;
  const first = queueEvolveFeedback(proposal, { reason: 'r' }, { path: tmp, dateKey: '2026-08-21' });
  const second = queueEvolveFeedback(proposal, { reason: 'r' }, { path: tmp, dateKey: '2026-08-21' });
  ok('첫 적재는 기록된다', first.ok && !first.duplicate);
  ok('같은 날 재실행은 중복으로 걸러진다', second.ok && second.duplicate);
  const lines = readFileSync(tmp, 'utf8').trim().split('\n');
  eq('  └ 파일에 한 줄만 남는다', lines.length, 1);
  const rec = JSON.parse(lines[0]);
  eq('  └ 원 제안 id 를 남겨 추적 가능하다', rec.proposal_id, 'blog:P1');
  eq('  └ 출처가 board 로 표시된다', rec.source, 'board');
  // 다음 날은 다시 들어간다(영구 차단이 아니라 하루 멱등).
  const nextDay = queueEvolveFeedback(proposal, { reason: 'r' }, { path: tmp, dateKey: '2026-08-22' });
  ok('다음 날은 다시 적재된다', nextDay.ok && !nextDay.duplicate);
  unlinkSync(tmp);
}

console.log('\n[11] 수집 — 없는 것을 0 으로 만들지 않는다');
{
  /**
   * `readJsonl` 이 "파일 없음"과 "빈 파일"을 모두 [] 로 돌려주면, 계측을 시작도 안 한 상태가
   * "0건 실측"으로 보고된다. 팀장은 그 0 을 근거로 전략을 세운다.
   */
  const { collectYoutube, collectInstagram } = await import('../board/collect.mjs');
  const cwd = process.cwd();
  const tmpDir = `/tmp/board-empty-${process.pid}`;
  mkdirSync(tmpDir, { recursive: true });
  process.chdir(tmpDir);
  try {
    const y = collectYoutube('2026-08-21');
    eq('상태파일 없으면 업로드 총계는 null', y.uploaded_total, null);
    eq('  └ 오늘 편수도 null', y.uploaded_today, null);
    ok('  └ 무엇을 모르는지 gaps 에 적는다', y.gaps.some(g => /알 수 없다/.test(g)), JSON.stringify(y.gaps));

    const i = collectInstagram('2026-08-21');
    eq('실행 이력 없으면 발행 편수 null', i.published_today, null);
    ok('  └ 설정도 못 읽으면 스위치 상태를 단정하지 않는다',
      i.gaps.some(g => /불명|알 수 없다/.test(g)), JSON.stringify(i.gaps));
  } finally { process.chdir(cwd); }
}


console.log('\n[12] 프롬프트 계약 — 대상 표기 규칙이 실제로 전달되는가');
{
  /**
   * 죽은 편지 사고의 절반은 프롬프트 탓이었다. 팀장이 대상을 `lynx (호기심채널 큐레이터)` 처럼
   * 쓰면 매칭이 빗나간다. normalizeTarget 으로 방어했지만, 애초에 규칙을 알려주는 쪽이 먼저다.
   * 규칙이 프롬프트에서 조용히 빠지면 아무도 모른다 → 문구를 계약으로 고정한다.
   */
  const brief = { team: 'blog', lead: 'falcon', titles: ['CPO'], gaps: ['GSC 계측 없음'], published_today: 3 };
  const lp = buildLeadPrompt(brief);
  ok('실측 데이터를 프롬프트에 싣는다', lp.includes('"published_today": 3'));
  ok('gaps 를 지어내지 말라고 명시한다', /만들어내지 마라|없는 것을 있는 것처럼/.test(lp));
  ok('에이전트 대상은 이름만 쓰라고 알려준다', /에이전트 이름만/.test(lp));
  ok('  └ 잘못된 예까지 보여준다', lp.includes('(X)'));
  ok('설정 대상은 점 경로 + value 를 요구한다', /설정 키 경로만/.test(lp) && /value 에 넣어라/.test(lp));
  ok('코드 수정은 asks_human 으로 보내라고 한다', /asks_human 에 넣어라/.test(lp));

  const cp = buildCeoPrompt([{ team: 'blog', lead: 'falcon', brief: { headline: 'h' } }],
    [{ gid: 'blog:P1', target_type: 'agent', target: 'beaver', change: 'c' }]);
  ok('CEO 에게 악마의 대변인 역할을 명시한다', /악마의 대변인/.test(cp));
  ok('  └ 반대를 위한 반대도 금지한다', /반대를 위한 반대/.test(cp));
  ok('반론 최소 개수를 프롬프트에 못 박는다', /3개 이상/.test(cp) && /2~3개/.test(cp));
  ok('리스크 3층위를 요구한다', /technical/.test(cp) && /organizational/.test(cp));
  ok('모든 제안을 판정하라고 요구한다', /모든 id 에 대해 하나씩/.test(cp));
  ok('상정된 제안 목록이 실제로 들어간다', cp.includes('blog:P1'));
}

console.log('\n[13] 팀별 수집기 — 전 팀이 같은 계약을 지킨다');
{
  const { collectBlog, collectDev } = await import('../board/collect.mjs');
  for (const [name, fn] of [['blog', collectBlog], ['dev', collectDev]]) {
    const r = fn('2026-08-21');
    ok(`${name}: 팀·팀장·직책을 보고한다`, Boolean(r.team && r.lead && r.titles?.length));
    ok(`${name}: gaps 배열을 항상 준다`, Array.isArray(r.gaps));
  }
  // dev 는 "로그 없음"을 성공으로 보고하면 안 된다 — 조용한 실패의 단골 자리다.
  const cwd = process.cwd();
  const tmpDir = `/tmp/board-dev-${process.pid}`;
  mkdirSync(tmpDir, { recursive: true });
  process.chdir(tmpDir);
  try {
    const d = collectDev('2026-08-21');
    eq('cron 로그 없으면 실패 목록은 null(0건 아님)', d.cron_failures, null);
    ok('  └ "성공"이 아니라 "알 수 없음"으로 말한다',
      d.gaps.some(g => /알 수 없음|성공 아님/.test(g)), JSON.stringify(d.gaps));
  } finally { process.chdir(cwd); }
}


console.log('\n[14] mock 회의는 홈페이지를 덮지 않는다');
{
  /**
   * 이 박스는 크리덴셜이 없으면 자주 mock 으로 내려가고, 검증용으로 mock 런을 자주 돌린다.
   * 그때 합성 브리핑("[mock] …")이 그날 실제 회의 결과를 DB 에서 밀어냈다(2026-08-21 실측).
   * 화면에 [mock] 이 그대로 나가는 것보다, 실제 결과가 사라지는 쪽이 더 나쁘다.
   */
  const { runBoard } = await import('../board/run-board.mjs');
  const prev = process.env.RUN_MODE;
  process.env.RUN_MODE = 'mock';
  const cwd = process.cwd();
  const tmpDir = `/tmp/board-mock-${process.pid}`;
  mkdirSync(tmpDir, { recursive: true });
  process.chdir(tmpDir);
  try {
    const r = await runBoard({ date: '2026-08-21' });
    ok('mock 런도 정상 종료한다', r.ok);
    ok('  └ 결론은 확정하지 않는다', Boolean(r.held), String(r.held));
    ok('  └ held 사유에 mock 임이 드러난다', /mock/.test(String(r.held)));
    ok('  └ 회의록은 남긴다(검증 목적)', existsSync(`${tmpDir}/docs/board/2026-08-21.md`));
  } finally { process.chdir(cwd); if (prev === undefined) delete process.env.RUN_MODE; else process.env.RUN_MODE = prev; }
}


console.log('\n[15] 가중치는 이사회 권한이 아니다');
{
  /**
   * 🔴 이 절이 지키는 사고: 이사회에 단일 가중치 적용 경로를 열어 뒀더니 첫 회의가
   * freshness 를 0.15 → 0.35 로 올렸고 **핵심 4축 합이 1.0 → 1.2 로 깨졌다.**
   * 처음엔 "변화폭 제한"을 덧댔는데 그것도 틀린 처방이었다 — 폭이 문제가 아니라
   * **단독 변경 자체가 불변식 위반**이다(나머지 축을 함께 재정규화해야 한다).
   * 진짜 원인은 이미 가드가 있는 곳(evolve.mjs)에 **두 번째 적용 경로를 만든 것**이었다.
   */
  const adopt = { verdict: 'adopt', reason: 'r' };
  const cfg = (target) => ({ target_type: 'config', target, change: 'c' });

  for (const k of ['pick.weights.surprise', 'pick.weights.freshness', 'pick.weights.relatability']) {
    eq(`${k} 는 사람 승인으로 뺀다`, routeDecision(adopt, cfg(k)).route, 'human');
  }
  ok('  └ 사유가 불변식을 짚는다',
    /합 1\.0 불변식/.test(routeDecision(adopt, cfg('pick.weights.surprise')).reason),
    routeDecision(adopt, cfg('pick.weights.surprise')).reason);
  ok('설명문에 "가중치"만 있어도 막힌다',
    routeDecision(adopt, { target_type: 'config', target: 'backlog.angles.whatif_ratio', change: '가중치를 조정한다' }).route === 'human');

  eq('허용 설정 키에 가중치가 없다',
    Object.values(CONFIG_WHITELIST).flatMap((o) => Object.keys(o)).filter((k) => k.includes('weights')).length, 0);

  // 실제 config 의 불변식이 지금 성립하는지도 함께 본다 — 회의가 깬 적이 있다.
  {
    const live = JSON.parse(readFileSync('config/shorts-curiosity.json', 'utf8'));
    const CORE = ['surprise', 'scrollstop', 'relatability', 'freshness'];
    const sum = CORE.reduce((a, k) => a + Number(live.pick?.weights?.[k] ?? 0), 0);
    ok('운영 config 의 핵심 4축 합이 1.0 이다', Math.abs(sum - 1) < 1e-9, `합=${sum}`);
  }

  // 이사회가 여전히 바꿀 수 있는 것(권한을 통째로 닫은 게 아님을 확인).
  eq('앵글 비율은 그대로 허용', routeDecision(adopt, cfg('backlog.angles.whatif_ratio')).route, 'config');
}


console.log('\n[16] 사람이 읽을 수 있는 사유');
{
  /**
   * 사용자 지적(2026-08-21): "사유가 사람이 봐도 뭔말인지 모르겠다".
   * 원인 둘 — ①제안 내용 자체가 화면에 안 왔다 ②내부 용어가 그대로 나갔다.
   */
  eq('상태 설명이 7종 모두 있다', Object.keys(STATUS_EXPLAIN).length, 7);
  for (const [k, v] of Object.entries(STATUS_EXPLAIN)) {
    ok(`${k}: 무슨 뜻인지와 다음 할 일을 모두 말한다`, Boolean(v.label && v.what && v.next));
  }

  const cases = [
    ['채점기 없음', 'lynx: 이 에이전트를 처리할 자가발전 채점기가 아직 없다 — 사람 승인 필요', { target: 'lynx' }],
    ['권한 없음', 'falcon: 팀장·CEO·감시자·최종 방어선은 이사회가 바꿀 수 없다 — 사람 승인 필요', { target: 'falcon' }],
    ['키 오타', '허용 목록에 없는 설정 키(pick.whatif_ratio) — 사람 승인 필요', { target: 'pick.whatif_ratio' }],
    ['보호 설정', '보호 대상(무인 발행 마스터 스위치) — 사람 승인 필요', { target: 'publish.enabled' }],
  ];
  for (const [label, reason, proposal] of cases) {
    const e = explainHold(reason, proposal);
    ok(`${label}: 왜·승인하면 어떻게 되는지 둘 다 답한다`, Boolean(e.why && e.need), JSON.stringify(e));
    // 내부 용어가 그대로 새어 나가면 안 된다.
    ok(`${label}: 내부 용어를 그대로 쓰지 않는다`,
      !/화이트리스트|EVOLVABLE|SEED:locked|exit \d/.test(e.why), e.why);
  }
}

console.log('\n[17] 승인 대기 원장');
{
  eq('멱등키는 날짜+제안id', approvalKey('2026-08-21', 'blog:P1'), '2026-08-21:blog:P1');

  const results = [
    { proposal_id: 'blog:P1', status: 'human', target: 'lynx', target_type: 'agent',
      change: '선정 기준을 바꾼다', rationale: '쏠림 때문', expected_effect: '다양성 증가',
      explain: { why: '왜 자동이 아닌지', need: '승인하면 어떻게 되는지' } },
    { proposal_id: 'blog:P2', status: 'queued', target: 'beaver', target_type: 'agent' },
    { proposal_id: 'blog:P3', status: 'skip', target: 'fox', target_type: 'agent' },
  ];
  const rows = toApprovalRows('2026-08-21', results);
  eq('human 항목만 승인 대기로 간다', rows.length, 1);

  /**
   * 내용 없는 항목은 쌓지 않는다. 실측(2026-08-21): 제안 원문을 싣기 전에 만들어진 행이
   * 승인함에 "(제안 내용이 기록되지 않았습니다)" 라는 제목으로 떴다. 판단 근거가 없는 걸
   * 승인하라고 두는 것은 승인 절차가 없는 것보다 나쁘다.
   */
  eq('제안 내용이 없으면 승인함에 올리지 않는다',
    toApprovalRows('2026-08-21', [{ proposal_id: 'x:P1', status: 'human', target: 'lynx', change: null }]).length, 0);
  eq('공백만 있어도 올리지 않는다',
    toApprovalRows('2026-08-21', [{ proposal_id: 'x:P1', status: 'human', target: 'lynx', change: '   ' }]).length, 0);
  eq('  └ 자동 처리분은 올라오지 않는다', rows[0].proposal_id, 'blog:P1');

  // 사람이 읽고 판단할 수 있으려면 제안 원문이 함께 와야 한다 — 이게 없어서 표가 안 읽혔다.
  ok('제안 내용이 실린다', rows[0].change === '선정 기준을 바꾼다');
  ok('근거와 기대효과도 실린다', rows[0].rationale === '쏠림 때문' && rows[0].expected_effect === '다양성 증가');
  ok('왜 자동이 아닌지도 실린다', Boolean(rows[0].hold_why && rows[0].hold_need));
  eq('팀을 제안 id 에서 뽑는다', rows[0].team, 'blog');
  eq('처음 상태는 대기', rows[0].status, 'pending');
}

console.log('\n[18] 승인 후 실행 — 버튼이 헛돌지 않는다');
{
  /**
   * 승인 버튼이 아무 일도 안 하면 "승인 필요" 라벨만 있던 예전 상태와 같아진다.
   * 유형별로 무슨 일이 일어나는지 분명해야 한다.
   */
  eq('허용 설정 + 숫자 → 즉시 반영',
    planApproved({ target_type: 'config', target: 'backlog.angles.whatif_ratio', value: 0.3 }).kind, 'config');
  eq('숫자 0 도 유효한 값이다',
    planApproved({ target_type: 'config', target: 'backlog.angles.whatif_ratio', value: 0 }).kind, 'config');

  // ⚠ `Number(null)` 은 0 이고 유한하다 — applyConfigChange 에서 고쳤던 함정을 여기서 반복했다.
  for (const bad of [null, undefined, '0.3', true, {}]) {
    eq(`value=${JSON.stringify(bad)} 는 자동 반영하지 않는다`,
      planApproved({ target_type: 'config', target: 'backlog.angles.whatif_ratio', value: bad }).kind, 'instruction');
  }

  eq('에이전트 지침은 지시 확정(자동 실행기 없음)',
    planApproved({ target_type: 'agent', target: 'lynx', change: 'c' }).kind, 'instruction');

  // 🔴 승인은 "이사회 권한 밖"을 여는 것이지 "안전장치"를 여는 것이 아니다.
  for (const t of ['pick.daily_target', 'publish.enabled', 'budget.daily_hard_cap']) {
    eq(`승인해도 보호 대상(${t})은 반영하지 않는다`,
      planApproved({ target_type: 'config', target: t, value: 5 }).kind, 'blocked');
  }
  ok('  └ 왜 막혔는지 사람 말로 알려준다',
    /안전장치는 승인으로 열리지 않는다/.test(planApproved({ target_type: 'config', target: 'publish.enabled', value: 1 }).reason));
  /**
   * ⚠ 한계를 사실대로 고정한다: 차단은 **설정 키 식별자** 기준이지 한국어 설명문 기준이 아니다.
   * 설명문까지 키워드로 막으면 "발행 편수는 그대로 두고 앵글만" 같은 정당한 제안도 막힌다 —
   * 과차단으로 기능이 통째로 죽는 경험을 이미 했다(2026-08-21 죽은 편지 사고).
   *
   * 그래서 설명문과 대상이 어긋나는 경우는 **막는 것이 아니라 보이게** 처리한다. 승인 화면이
   * 대상과 제안 내용을 나란히 보여주므로 사람이 불일치를 읽고 판단한다.
   * 실제 반영은 어차피 지정된 키에만 일어나므로, 설명문이 엉뚱해도 다른 값이 바뀌지는 않는다.
   */
  eq('설명문이 엉뚱해도 반영은 지정된 키에만 일어난다',
    planApproved({ target_type: 'config', target: 'backlog.angles.whatif_ratio', value: 0.3, change: '발행 편수를 늘린다' }).kind, 'config');
  eq('  └ 식별자로 지정하면 그건 막힌다',
    planApproved({ target_type: 'config', target: 'pick.daily_target', value: 5 }).kind, 'blocked');
}

/**
 * 승인함 스키마 대조 — 코드가 보내는 컬럼이 DB 에 실제로 있는가.
 *
 * 🔴 이 검사가 없어서 2026-08-22~25 나흘간 승인함이 비어 있었다. `plan` 필드가 코드에만
 *    추가되고(1b45c06) 테이블에는 없어서 적재가 매일 HTTP 400(PGRST204)으로 떨어졌는데,
 *    호출부가 실패를 `ok: true` 로 삼켜 회의는 계속 초록이었다. 회의는 매일 열리고 결론도
 *    났지만 **사람이 볼 곳에는 한 건도 닿지 않았다.**
 *
 * 네트워크 없이 잡는 방법은 하나뿐이다 — 코드가 만드는 키 집합과 스키마 파일의 컬럼 집합을
 * 직접 맞춰 보는 것. 컬럼을 새로 보내면서 마이그레이션을 빠뜨리면 여기서 먼저 죽는다.
 *
 * ⚠ 스키마 파일은 사이트 레포에 있다. 없으면 **통과가 아니라 skip 으로 표시**한다 —
 *    "검사할 게 없어서 통과" 는 이 사고를 다시 놓치는 정확한 방식이다.
 */
{
  // scripts/test/ → scripts/ → blog-publisher/ → th-team/ 이므로 세 단계 위가 사이블링 루트다.
  const SQL_PATHS = [
    '../../../repo/thundorun/web/supabase/board_approvals.sql',
    '../../repo/thundorun/web/supabase/board_approvals.sql',
  ];
  const sqlPath = SQL_PATHS.map(p => fileURLToPath(new URL(p, import.meta.url))).find(p => existsSync(p));

  if (!sqlPath) {
    console.log('  ⏭ 승인함 스키마 대조 — 스키마 파일을 못 찾아 건너뜀(사이트 레포 없음)');
  } else {
    /**
     * ⚠ 줄 주석을 먼저 걷어낸다. 주석 처리된 `-- add column … ghost` 가 '있는 컬럼'으로
     *    세어지면 **되살리지 않은 마이그레이션이 적용된 것으로 읽힌다** — 거짓 통과이고,
     *    이 검사가 막으려던 바로 그 방향의 오류다(리뷰에서 실제 재현됨).
     */
    const sql = readFileSync(sqlPath, 'utf8').replace(/--[^\n]*/g, '');
    // create table 본문 + 나중에 덧붙인 alter table add column 을 모두 컬럼으로 인정한다.
    const body = sql.match(/create table[^(]*\(([\s\S]*?)\n\);/i)?.[1] ?? '';
    const declared = new Set([
      ...body.split('\n').map(l => l.trim().match(/^([a-z_][a-z0-9_]*)\s+[a-z]/i)?.[1]).filter(Boolean),
      ...[...sql.matchAll(/add column if not exists\s+([a-z_][a-z0-9_]*)/gi)].map(m => m[1]),
    ]);

    ok('스키마 파일에서 컬럼을 읽어냈다', declared.size > 5);

    const sent = Object.keys(toApprovalRows('2026-01-01', [{
      status: 'human', proposal_id: 'youtube:P1', target: 't', target_type: 'agent',
      change: 'c', plan: 'p', rationale: 'r', expected_effect: 'e', value: null,
      explain: { why: 'w', need: 'n' },
    }])[0]);

    const missing = sent.filter(k => !declared.has(k));
    ok(`코드가 보내는 컬럼이 전부 스키마에 있다${missing.length ? ` — 없는 것: ${missing.join(', ')}` : ''}`,
      missing.length === 0);
    ok('  └ plan 이 스키마에 있다(이 사고의 원인 컬럼)', declared.has('plan'));
  }
}

/**
 * 전달 실패는 **실패로 보고돼야 한다**.
 *
 * 🔴 이 계약이 없어서 나흘을 잃었다. 두 전달 경로(승인함 적재·홈페이지 반영)가 HTTP 오류에도
 *    `ok:true` 를 돌려줬고, 호출부는 성공과 구분할 수 없었다. 회의는 매일 초록이었고 알림은
 *    "사람 승인 필요 N건"이라고 말했는데, 사람이 볼 곳에는 아무것도 없었다.
 *
 * 비차단(회의를 죽이지 않는다)과 정직(실패를 실패라고 부른다)은 서로 다른 요구다.
 * 여기서 고정하는 것은 후자다 — 전자는 호출부가 `ok` 를 보고도 계속 진행하는 것으로 지킨다.
 *
 * ⚠ **크리덴셜 없음은 실패가 아니다** — '해당 없음'이라 `ok:true` 로 남겨야 한다(실패로 바꾸면
 *    크리덴셜 없는 박스에서 매 회의가 빨간 알림을 보낸다). 그 분기는 여기서 동작으로 검사하지
 *    못한다 — `creds()` 가 `.env` 파일까지 직접 읽어서 주입점이 없다. 대신 소스를 읽어 고정한다.
 */
{
  const fail = (status, body) => async () => ({ ok: false, status, text: async () => body, json: async () => ({}) });
  const okRead = async () => ({ ok: true, status: 200, json: async () => [], text: async () => '[]' });

  const q = await enqueueApprovals([{ key: 'k', date: '2026-01-01', change: 'c' }],
    { fetchImpl: fail(400, '{"code":"PGRST204","message":"Could not find the \'plan\' column"}') });
  ok('승인함 적재 실패는 ok:false 로 보고한다', q.ok === false);
  ok('  └ 응답 본문을 남긴다(무엇이 틀렸는지 알아야 고친다)', /PGRST204/.test(q.detail ?? ''));
  eq('  └ 몇 건이 못 갔는지 센다', q.failed, 1);

  const writeFails = async (u, init) => (init?.method === 'POST' ? fail(500, 'boom')() : okRead());
  const pw = await publishBoard({ date: '2026-01-01' }, { fetchImpl: writeFails });
  ok('홈페이지 반영 쓰기 실패는 ok:false 로 보고한다', pw.ok === false);
  ok('  └ 이유를 남긴다', /write_500/.test(pw.reason ?? ''));

  const pr = await publishBoard({ date: '2026-01-01' }, { fetchImpl: fail(503, 'down') });
  ok('읽기 실패도 ok:false — 반영은 안 된 것이다', pr.ok === false);
  ok('  └ 읽기 단계에서 멈춰 기존 요약을 덮지 않는다', /read_503/.test(pr.reason ?? ''));

  const thrown = await publishBoard({ date: '2026-01-01' }, { fetchImpl: async () => { throw new Error('net'); } });
  ok('예외도 ok:false — 삼키지 않는다', thrown.ok === false);

  // 크리덴셜 없음 분기는 주입할 수 없으므로 소스에서 고정한다(위 ⚠ 참고).
  for (const f of ['../board/approvals.mjs', '../board/publish-board.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
    const line = src.split('\n').find(l => l.includes("skipped: 'no_credentials'"));
    ok(`${f.split('/').pop()}: 크리덴셜 없음은 ok:true 로 남아 있다`, Boolean(line) && line.includes('ok: true'));
  }
}

/**
 * 밀린 건 복구 — 조회창과 멱등성.
 *
 * 회의는 하루 1회이고 적재는 그날 한 번만 시도한다. 실패한 날의 건을 다음 회의가 챙겨 주지
 * 않으면 원장에만 남는다(8-22~25 나흘, 8건). 그래서 회의 시작 때 최근 것을 다시 올린다.
 *
 * ⚠ **무제한으로 긁지 않는다.** 관리자가 화면에서 지운 오래된 건을 `pending` 으로 되살리고,
 *    한 해치를 한 요청에 실으면 행 하나 때문에 배치 전체가 떨어진다.
 */
{
  const rec = (date, id, extra = {}) => JSON.stringify({
    date, mock: false, results: [{ status: 'human', proposal_id: id, change: 'c', target: 't' }], ...extra,
  });
  const ledger = [
    rec('2026-08-01', 'youtube:P1'),          // 창 밖
    rec('2026-08-20', 'youtube:P2'),          // 창 안
    rec('2026-08-21', 'dev:P1'),              // 창 안
    rec('2026-08-21', 'mock:P1', { mock: true }),
    JSON.stringify({ date: '2026-08-22', mock: false, results: [{ status: 'human', proposal_id: 'x:P1', change: '  ' }] }),
    JSON.stringify({ date: '2026-08-22', mock: false, results: [{ status: 'skip', proposal_id: 'y:P1', change: 'c' }] }),
    'not json',
  ].join('\n');

  eq('조회창 기본값은 14일', DEFAULT_WINDOW_DAYS, 14);
  eq('  └ 창 시작일을 날짜로 계산한다(월 경계 넘김)', windowStart('2026-08-25', 14), '2026-08-11');
  eq('  └ 시계는 주입받는다(오늘에 의존하지 않는다)', windowStart('2026-01-05', 14), '2025-12-22');

  const win = collectPending(ledger, { since: '2026-08-11' });
  eq('창 안의 건만 올린다', win.length, 2);
  ok('  └ 창 밖(8-01)은 빠진다', !win.some(r => r.date === '2026-08-01'));
  ok('  └ mock 회의는 사람에게 올리지 않는다', !win.some(r => r.proposal_id === 'mock:P1'));
  ok('  └ 내용 없는 건(공백 change)은 올리지 않는다', !win.some(r => r.proposal_id === 'x:P1'));
  ok('  └ human 아닌 건은 올리지 않는다', !win.some(r => r.proposal_id === 'y:P1'));
  ok('  └ 깨진 줄이 있어도 나머지를 처리한다', win.length === 2);

  eq('창을 안 주면 전체를 본다(--all 경로)', collectPending(ledger).length, 3);
  eq('같은 키가 여러 날 나와도 한 번만 올린다',
    collectPending([rec('2026-08-20', 'a:P1'), rec('2026-08-20', 'a:P1')].join('\n')).length, 1);
}

console.log(`\n경영회의(board): ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
