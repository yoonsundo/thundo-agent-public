#!/usr/bin/env node
/**
 * curiosity-content-rules.test.mjs — 호기심채널 콘텐츠 룰(US-003) 유닛테스트
 *
 * 검증: ① whatif 일일 상한(3편/일·ratio 0.35 → 1편)이 지켜지고 그래도 하루 3편이 채워지는지
 *      ② 문구만 바뀐 재탕 주제(정규화 유사도)가 차단되고, 서로 다른 주제는 통과하는지(오탐)
 * 순수 함수 + 인메모리 인덱스만 쓴다 — 실 state/크리덴셜/네트워크/claude 불필요.
 * exit 0 = 전체 통과 / 1 = 실패.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';

import { readFileSync } from 'node:fs';

const {
  filterCandidates, takeWithWhatifCap, scoreAll, whatifCap, whatifAllowance,
  todayAngleCounts, isNearDuplicate, normalizeSubject, decideRelaxation, availableInventory,
  contentTokens, topicSimilarity, tokenDocFreq, sharedContentTokens,
} = await import('../shorts-curiosity/pick.mjs');
const { loadConfig } = await import('../shorts-curiosity/lib.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// 테스트용 설정(운영 config 와 같은 값 — 하드코딩 아님을 보이기 위해 키로만 조정).
const cfg = {
  pick: {
    daily_target: 3,
    daily_whatif_cap: null,
    weights: { surprise: 0.34, scrollstop: 0.21, relatability: 0.3, freshness: 0.15 },
    similarity: { enabled: true, bigram_jaccard: 0.45, substring: true, min_chars: 6 },
  },
  backlog: { angles: { whatif_ratio: 0.35 } },
};

const NOW = new Date('2026-07-29T04:00:00Z');   // KST 2026-07-29 13:00
const YESTERDAY = '2026-07-28T04:00:00Z';

// ── 1. 상한값 유도(config 기반, 하드코딩 금지) ───────────────────────────────
console.log('\n[1] whatif 일일 상한 유도');
eq('3편 × 0.35 → 1편', whatifCap(cfg), 1);
eq('명시 cap 우선', whatifCap({ ...cfg, pick: { ...cfg.pick, daily_whatif_cap: 2 } }), 2);
eq('ratio 0 → whatif 금지', whatifCap({ ...cfg, backlog: { angles: { whatif_ratio: 0 } } }), 0);
eq('운영 config 는 실측 저성과 whatif 일시 중지', whatifCap(loadConfig()), 0);

// ── 2. 오늘 whatif 1편이면 추가 whatif 선정 안 됨 ────────────────────────────
console.log('\n[2] whatif 상한 소진 후 추가 선정 차단');
const backlog = [
  { id: 'w1', angle: 'whatif', domain: '과학', subject: '만약 달이 두 개였다면, 밤은 어떻게 달라졌을까?' },
  { id: 'w2', angle: 'whatif', domain: '역사', subject: '만약 로마가 멸망하지 않았다면, 인터넷은 언제 나왔을까?' },
  { id: 'w3', angle: 'whatif', domain: '인체', subject: '만약 사람이 잠을 안 자도 됐다면, 하루는 어떻게 쓰였을까?' },
  { id: 'r1', angle: 'reveal', domain: '동물', subject: '호랑이는 주황색이 아니다' },
  { id: 'r2', angle: 'reveal', domain: '일상', subject: '유리는 액체가 아니다' },
  { id: 'r3', angle: 'reveal', domain: '음식', subject: '와사비의 99%는 와사비가 아니다' },
];
const pausedCfg = { ...cfg, backlog: { angles: { whatif_ratio: 0 } } };
const paused = filterCandidates({ items: backlog.filter(b => b.angle === 'whatif'), index: {}, backlog, cfg: pausedCfg, now: NOW });
eq('ratio 0이면 whatif 는 완화 후보에도 남기지 않음', paused.capBlocked.length, 0);
ok('ratio 0 차단 사유는 일시중지로 구분', paused.blocked.every(b => b.reason === 'whatif_disabled'), JSON.stringify(paused.blocked));
// whatif 가 항상 reveal 보다 고득점 → 상한이 없으면 3편 모두 whatif 가 됐을 상황.
const scores = backlog.map(b => b.angle === 'whatif'
  ? { id: b.id, surprise: 0.95, scrollstop: 0.9, relatability: 0.9 }
  : { id: b.id, surprise: 0.7, scrollstop: 0.6, relatability: 0.6 });

/** 인메모리 pendingBacklog — produced/uploaded 는 제외. */
const pendingOf = (index) => backlog.filter(b => !index[b.id]);

/** 하루치 슬롯 시뮬레이션(cron 3회 = 3프로세스, 인덱스로만 상태 공유). */
function simulateDay(index) {
  const picked = [];
  for (let slot = 0; slot < 3; slot++) {
    const { items, allowance } = filterCandidates({ items: pendingOf(index), index, backlog, cfg, now: NOW });
    if (items.length === 0) break;                       // 후보 전멸 → 기존 폴백(재고) 경로
    const sorted = scoreAll({ items, scores, freshOf: () => 1, weights: cfg.pick.weights });
    const chosen = takeWithWhatifCap(sorted, 1, allowance)[0];
    if (!chosen) break;
    const it = chosen.item;
    index[it.id] = { status: 'uploaded', at: NOW.toISOString(), angle: it.angle, subject: it.subject };
    picked.push(it);
  }
  return picked;
}

const day = simulateDay({});
eq('하루 3편 그대로 산출(편수 축소 없음)', day.length, 3);
eq('whatif 은 1편만', day.filter(p => p.angle === 'whatif').length, 1);
eq('나머지 2편은 reveal 로 대체', day.filter(p => p.angle === 'reveal').length, 2);
ok('1번 슬롯은 고득점 whatif 가 정상 선정', day[0].angle === 'whatif', `got=${day[0].angle}`);
ok('2·3번 슬롯에 whatif 없음', day.slice(1).every(p => p.angle === 'reveal'), JSON.stringify(day.map(p => p.angle)));

// 이미 오늘 whatif 1편이 올라간 인덱스에서 시작하면 whatif 는 아예 안 뽑힌다.
const seeded = { w1: { status: 'uploaded', at: NOW.toISOString(), angle: 'whatif', subject: backlog[0].subject } };
const after = simulateDay(seeded);
eq('오늘 whatif 1편 기록 상태 → 추가 whatif 0편', after.filter(p => p.angle === 'whatif').length, 0);
eq('그래도 남은 슬롯은 채워짐', after.length, 3);
eq('오늘 whatif 허용량 소진', whatifAllowance(cfg, seeded, NOW), 0);

// 어제 whatif 는 오늘 상한을 먹지 않는다(KST 일자 기준).
const oldIdx = { w1: { status: 'uploaded', at: YESTERDAY, angle: 'whatif', subject: 'x' } };
eq('어제분은 오늘 카운트 제외', todayAngleCounts(oldIdx, NOW).whatif, 0);
eq('어제분 뒤 오늘 허용량 1', whatifAllowance(cfg, oldIdx, NOW), 1);
// angle 미저장 구항목은 reveal 로 간주(회귀 가드).
eq('angle 미저장은 reveal 취급', todayAngleCounts({ x: { status: 'uploaded', at: NOW.toISOString() } }, NOW).reveal, 1);

// 배치 내부(best_n>=2)에서도 whatif 는 허용량까지만.
const batchSorted = scoreAll({ items: backlog, scores, freshOf: () => 1, weights: cfg.pick.weights });
const batch = takeWithWhatifCap(batchSorted, 3, 1);
eq('best_n=3 배치도 3편 확보', batch.length, 3);
eq('배치 내 whatif 1편 제한', batch.filter(b => b.item.angle === 'whatif').length, 1);

// ── 3. 유사주제 중복 차단(B 사례) ────────────────────────────────────────────
console.log('\n[3] 유사주제 중복 차단');
const PRIOR = '총알 없는 총으로 자기 머리를 쐈던 배우';
const RETRY = '총알 없는 총으로 자기 머리를 쐈던 배우 (공포탄의 진실)';
const priorIndex = { p1: { status: 'uploaded', at: YESTERDAY, angle: 'reveal', subject: PRIOR } };
const dupRun = filterCandidates({
  items: [{ id: 'n1', angle: 'reveal', domain: '역사', subject: RETRY }],
  index: priorIndex, backlog: [], cfg, now: NOW,
});
eq('07-29 재탕(괄호 부제만 추가) 차단', dupRun.items.length, 0);
eq('차단 사유', dupRun.blocked[0]?.reason, 'similar_subject');
ok('차단 대상이 기존 주제로 기록됨', dupRun.blocked[0]?.against === PRIOR, JSON.stringify(dupRun.blocked[0]));

// 역방향(짧은 재탕이 나중) · 조사/구두점만 다른 변형도 차단.
ok('역방향 포함관계도 차단', isNearDuplicate(PRIOR, [RETRY], cfg.pick.similarity).dup);
ok('조사·구두점 변형 차단', isNearDuplicate('총알 없는 총으로 자기 머리에 방아쇠를 당긴 배우',
  [PRIOR], cfg.pick.similarity).dup);
eq('정규화가 괄호·구두점·공백을 흡수',
  normalizeSubject('호랑이는 주황색이 아니다!'), normalizeSubject('  호랑이는 (주황색이) 아니다 '));
eq('정규화가 어절 끝 조사를 절단', normalizeSubject('머리를 쐈던 배우'), '머리쐈던배우');

// 오탐 가드 — 서로 다른 주제는 통과해야 한다.
const distinct = filterCandidates({
  items: [
    { id: 'r1', angle: 'reveal', domain: '동물', subject: '호랑이는 주황색이 아니다' },
    { id: 'r3', angle: 'reveal', domain: '음식', subject: '와사비의 99%는 와사비가 아니다' },
  ],
  index: { g1: { status: 'uploaded', at: YESTERDAY, angle: 'reveal', subject: '유리는 액체가 아니다' } },
  backlog: [], cfg, now: NOW,
});
eq('다른 주제 2건 모두 통과(오탐 없음)', distinct.items.length, 2);
eq('오탐 차단 0건', distinct.blocked.length, 0);
ok('호랑이 vs 유리 유사도 임계 미달',
  !isNearDuplicate('호랑이는 주황색이 아니다', ['유리는 액체가 아니다'], cfg.pick.similarity).dup);

// 인덱스에 subject 가 없는 구항목은 백로그에서 보강해 비교한다.
const legacy = filterCandidates({
  items: [{ id: 'n2', angle: 'reveal', domain: '역사', subject: RETRY }],
  index: { p1: { status: 'uploaded', at: YESTERDAY, angle: 'reveal' } },
  backlog: [{ id: 'p1', subject: PRIOR }], cfg, now: NOW,
});
eq('subject 미저장 구항목도 중복 판정', legacy.items.length, 0);

// enabled=false 면 유사도 차단 off(하위호환).
const off = filterCandidates({
  items: [{ id: 'n3', angle: 'reveal', subject: RETRY }],
  index: priorIndex, backlog: [],
  cfg: { ...cfg, pick: { ...cfg.pick, similarity: { enabled: false } } }, now: NOW,
});
eq('similarity.enabled=false 면 통과', off.items.length, 1);

// 도메인만 바꿔 freshness 감점을 우회하는 재탕도 차단해야 한다(중복 판정은 domain 무관).
const sameSubjDiffDomain = filterCandidates({
  items: [{ id: 'n4', angle: 'reveal', domain: '역사', subject: '유리는 액체가 아니다' }],
  index: { g1: { status: 'uploaded', at: YESTERDAY, angle: 'reveal', domain: '일상', subject: '유리는 액체가 아니다' } },
  backlog: [], cfg, now: NOW,
});
eq('domain 만 다른 같은 subject 도 차단(freshness 우회 방지)', sameSubjDiffDomain.items.length, 0);
eq('domain 무관 차단 사유', sameSubjDiffDomain.blocked[0]?.reason, 'similar_subject');

// ── 3-b. 최후수단 완화 — 하루 3편 룰이 앵글 다양성 선호를 이긴다 ─────────────
// 우선순위: ① reveal 후보 → ② 재고(produced) 폴백 → ③ whatif 상한 완화. 0편보다 편중이 낫다.
console.log('\n[3-b] 상한 완화(결방 방지)');

// (d) reveal 후보가 있으면 완화 안 함 — 불필요한 완화 금지.
eq('reveal 후보 있으면 완화 안 함',
  decideRelaxation({ strictCount: 2, relaxableCount: 3, inventory: 0 }).relax, false);
// (2) 재고가 있으면 완화보다 재고 폴백 우선 — 단, 상위가 판단하도록 canRelax 로 구별해 알린다.
const invFirst = decideRelaxation({ strictCount: 0, relaxableCount: 3, inventory: 2 });
eq('재고 있으면 완화 안 함', invFirst.relax, false);
eq('그래도 완화 가능함을 상위에 알림(구별 반환)', invFirst.canRelax, true);
eq('사유가 재고 우선임을 밝힘', invFirst.reason, 'inventory_fallback_first');
// (a) 상한 소진 + 잔여 전부 whatif + 재고 0 → 완화 발동(0편 아님).
const relaxNow = decideRelaxation({ strictCount: 0, relaxableCount: 3, inventory: 0 });
eq('reveal 0 + 재고 0 → 완화 발동', relaxNow.relax, true);
eq('완화 사유 기록', relaxNow.reason, 'slot_would_be_empty');
eq('완화 후보도 없으면 완화 없음', decideRelaxation({ strictCount: 0, relaxableCount: 0, inventory: 0 }).relax, false);

// (a) 실제 후보 흐름: 상한 소진 상태에서 잔여가 전부 whatif → capBlocked 로 남아 완화 가능.
const allWhatifPending = [
  { id: 'w9', angle: 'whatif', domain: '우주', subject: '만약 태양이 30분간 꺼진다면, 지구에서 먼저 일어날 일은?' },
  { id: 'w8', angle: 'whatif', domain: '인체', subject: '만약 사람이 물을 마시지 않고 커피만 마신다면?' },
];
const exhausted = { w1: { status: 'uploaded', at: NOW.toISOString(), angle: 'whatif', subject: 'x' } };
const capRun = filterCandidates({ items: allWhatifPending, index: exhausted, backlog: [], cfg, now: NOW });
eq('상한 소진 → 엄격 후보 0건', capRun.items.length, 0);
eq('상한 보류분이 완화 후보로 보존', capRun.capBlocked.length, 2);
ok('보류 사유가 상한임', capRun.blocked.every(b => b.reason === 'whatif_daily_cap'), JSON.stringify(capRun.blocked));
const relaxed = takeWithWhatifCap([], 1, 0, {
  relaxable: capRun.capBlocked.map(item => ({ item, total: 0.8 })), relaxIfShort: true,
});
eq('완화로 슬롯이 채워짐(0편 아님)', relaxed.length, 1);
// (b) 완화된 항목엔 추적용 플래그가 남는다(사후에 "왜 그날 whatif 2편?" 추적).
eq('완화 플래그 기록', relaxed[0].relaxed, true);

// (c) 유사주제 중복은 완화로도 절대 통과하지 않는다 — 중복 재업로드 금지는 하드 룰.
const dupWhatif = filterCandidates({
  items: [
    { id: 'wd', angle: 'whatif', domain: '역사', subject: RETRY },                       // 중복 + whatif
    { id: 'wk', angle: 'whatif', domain: '우주', subject: '만약 달이 사라지면 조수는 어떻게 될까?' }, // 상한만 걸림
  ],
  index: { ...priorIndex, w1: { status: 'uploaded', at: NOW.toISOString(), angle: 'whatif', subject: 'x' } },
  backlog: [], cfg, now: NOW,
});
eq('중복 whatif 은 완화 후보에서 제외', dupWhatif.capBlocked.filter(i => i.id === 'wd').length, 0);
eq('상한만 걸린 whatif 만 완화 후보', dupWhatif.capBlocked.map(i => i.id).join(','), 'wk');
eq('중복은 similar_subject 로 영구 탈락', dupWhatif.blocked.find(b => b.id === 'wd')?.reason, 'similar_subject');
const relaxedDup = takeWithWhatifCap([], 5, 0, {
  relaxable: dupWhatif.capBlocked.map(item => ({ item, total: 0.8 })), relaxIfShort: true,
});
ok('완화 결과에 중복 주제 없음', !relaxedDup.some(s => s.item.id === 'wd'), JSON.stringify(relaxedDup.map(s => s.item.id)));

// (e) 완화는 부족분만 — 상한이 통째로 사라지지 않는다.
const twoReveal = [
  { item: { id: 'r8', angle: 'reveal', subject: '수돗물보다 비싼 생수의 진짜 원가' }, total: 0.9 },
  { item: { id: 'r9', angle: 'reveal', subject: '엘리베이터 닫기 버튼은 대부분 작동하지 않는다' }, total: 0.88 },
];
const threeWhatif = ['wa', 'wb', 'wc'].map((id, i) => ({ item: { id, angle: 'whatif', subject: `만약 ${id}` }, total: 0.85 - i * 0.01 }));
const minimal = takeWithWhatifCap(twoReveal, 3, 0, { relaxable: threeWhatif, relaxIfShort: true });
eq('3편 슬롯 충족', minimal.length, 3);
eq('완화는 부족분 1편만', minimal.filter(s => s.relaxed).length, 1);
eq('reveal 2편은 그대로 우선', minimal.filter(s => !s.relaxed).length, 2);
const noNeed = takeWithWhatifCap([...twoReveal, { item: { id: 'r7', angle: 'reveal', subject: '세 번째 리빌' }, total: 0.8 }], 3, 0,
  { relaxable: threeWhatif, relaxIfShort: true });
eq('reveal 로 다 채우면 완화 0편', noNeed.filter(s => s.relaxed).length, 0);
eq('완화 없이도 3편', noNeed.length, 3);
// 완화를 켜지 않으면(재고 있음 등) 상한은 그대로 — 회귀 가드.
eq('relaxIfShort=false 면 상한 유지(빈손)', takeWithWhatifCap([], 3, 0, { relaxable: threeWhatif }).length, 0);
eq('실 상태 재고 편수 조회 가능', typeof availableInventory(), 'number');

// ── 4. 백로그 보충 임계(고갈 전 보충) ───────────────────────────────────────
console.log('\n[4] 백로그 보충 임계');
const { refillThreshold, needsRefill, consumableBacklog } = await import('../shorts-curiosity/run-curiosity.mjs');
const rcfg = { pick: { daily_target: 3 }, backlog: { target_size: 50, refill_buffer_days: 4 } };
eq('임계 = daily_target × buffer_days (3×4)', refillThreshold(rcfg), 12);
ok('잔여 5건(구 하드코딩 임계)에서 보충 트리거', needsRefill(5, rcfg));
ok('잔여 11건(버퍼 미달)에서 보충 트리거', needsRefill(11, rcfg));
ok('잔여 12건(버퍼 충족)에서는 보충 안 함', !needsRefill(12, rcfg));
ok('잔여 20건에서도 보충 안 함(매 슬롯 보충 금지)', !needsRefill(20, rcfg));
eq('명시 refill_threshold 우선',
  refillThreshold({ ...rcfg, backlog: { ...rcfg.backlog, refill_threshold: 20 } }), 20);
eq('target_size 로 클램프',
  refillThreshold({ pick: { daily_target: 3 }, backlog: { target_size: 8, refill_buffer_days: 10 } }), 8);
// 운영 config 의 임계는 daily_target × refill_buffer_days 로 유도된다. 숫자를 고정하면
// 발행 편수를 바꿀 때마다 이 단언이 깨지므로(2026-08-21 3→2 로 12→8), 값이 아니라
// **유도 공식이 실제 운영 config 에 적용되는지**를 본다(명시 refill_threshold 가 끼어들면 실패).
{
  const opCfg = loadConfig();
  eq('운영 config 실제 임계 = daily_target × refill_buffer_days',
    refillThreshold(opCfg),
    Math.ceil((opCfg.pick?.daily_target ?? 2) * (opCfg.backlog?.refill_buffer_days ?? 4)));
}

// ── 4-b. 보충 판정은 "실제로 뽑힐 수 있는" 후보만 센다 ──────────────────────
// 2026-08-21 실측 결함: whatif_ratio=0 이면 pick 이 whatif 를 매 슬롯 채점 전에 버리는데
// 보충 트리거는 그 후보까지 세어 풀이 마른 걸 못 봤다(pending 17 중 6이 영구 제외분).
// whatif 잔여는 빠지지 않으므로 소비가능 풀이 바닥날 때까지 보충이 안 걸린다 → 도메인 쏠림.
const mixed = [
  { angle: 'reveal', subject: 'r1' }, { angle: 'reveal', subject: 'r2' },
  { angle: 'whatif', subject: 'w1' }, { angle: 'whatif', subject: 'w2' },
  { angle: 'whatif', subject: 'w3' },
];
const offCfg = { ...rcfg, backlog: { ...rcfg.backlog, angles: { whatif_ratio: 0 } } };
const onCfg = { ...rcfg, backlog: { ...rcfg.backlog, angles: { whatif_ratio: 0.35 } } };
eq('whatif 중지 시 소비가능 후보만 집계', consumableBacklog(mixed, offCfg).length, 2);
eq('whatif 활성 시 전량 집계(회귀 금지)', consumableBacklog(mixed, onCfg).length, 5);
ok('중지 상태: 전체 5건은 임계(12) 미만이라 어차피 보충이지만, 소비가능 2건이 진짜 수위',
  needsRefill(consumableBacklog(mixed, offCfg).length, offCfg));
// 핵심 회귀: 전체 개수로는 충족처럼 보이지만 소비가능은 미달인 경우를 잡아야 한다.
const padded = [...Array(12)].map((_, i) => ({ angle: 'whatif', subject: `w${i}` }))
  .concat([{ angle: 'reveal', subject: 'r1' }]);
ok('전체 13건(임계 충족)이어도 소비가능 1건이면 보충한다',
  !needsRefill(padded.length, offCfg) && needsRefill(consumableBacklog(padded, offCfg).length, offCfg));
eq('angle 필드가 없는 구형 항목은 소비가능으로 둔다',
  consumableBacklog([{ subject: 'legacy' }], offCfg).length, 1);
ok('구 임계(잔여 5건 미만)보다 여유 있음', refillThreshold(loadConfig()) > 5);

// ── 5. Reddit 주간 top 창 중복 억제 ─────────────────────────────────────────
console.log('\n[5] Reddit 씨앗 창 중복');
const { seedKey, dedupeSeedBatch, orderSeedsBySeen, factSimilarity } =
  await import('../shorts-curiosity/reddit-seed.mjs');
const S1 = { fact: 'A stage actor shot himself with a prop gun loaded with blanks and died', url: 'https://reddit.com/r/todayilearned/comments/aaa/x/?utm_source=share', subreddit: 'todayilearned', rank: 1 };
const S1_CROSS = { fact: 'A stage actor shot himself with a prop gun loaded with blanks and died on set', url: 'https://reddit.com/r/Damnthatsinteresting/comments/bbb/y/', subreddit: 'Damnthatsinteresting', rank: 3 };
const S2 = { fact: 'Wild animals in Kruger National Park fear human voices more than lion growls', url: 'https://reddit.com/r/science/comments/ccc/z/', subreddit: 'science', rank: 2 };

eq('URL 키는 쿼리·꼬리슬래시 정규화', seedKey(S1), 'https://reddit.com/r/todayilearned/comments/aaa/x');
eq('URL 없으면 사실 해시 키', seedKey({ fact: 'no url here at all' }).startsWith('fact:'), true);
ok('교차게시 유사도 높음', factSimilarity(S1.fact, S1_CROSS.fact) >= 0.6, String(factSimilarity(S1.fact, S1_CROSS.fact)));
ok('다른 원문 유사도 낮음', factSimilarity(S1.fact, S2.fact) < 0.6, String(factSimilarity(S1.fact, S2.fact)));
eq('배치 내 교차게시 중복 제거', dedupeSeedBatch([S1, S1_CROSS, S2]).length, 2);
eq('상위 랭크 보존', dedupeSeedBatch([S1, S1_CROSS, S2])[0].subreddit, 'todayilearned');

// 주간 창(7일) 안에 이미 프롬프트로 넘긴 원문은 재수집되면 뒤로 밀린다 — 07-27/07-29 반복의 근원.
// ⚠ 제외가 아니라 후순위다(제외하면 reddit 씨앗이 말라 LLM whatif 만 남아 편중이 악화된다).
const D0 = new Date('2026-07-27T00:00:00Z'), D2 = new Date('2026-07-29T00:00:00Z');
const first = orderSeedsBySeen([S1, S2], {}, { window_days: 8, now: D0 });
eq('첫 수집은 전부 신규', first.deferred, 0);
eq('첫 수집 기록 2건', first.marked, 2);
ok('기록에 최초 관찰시각 저장', typeof first.store[seedKey(S1)] === 'string', JSON.stringify(first.store));

const NEW_SEED = { fact: 'Brand new fact about octopus blood color', url: 'https://reddit.com/r/til/comments/ddd/w/' };
const twoDaysLater = orderSeedsBySeen([S1, S2, NEW_SEED], first.store, { window_days: 8, now: D2 });
eq('2일 뒤 재수집분 2건이 후순위로', twoDaysLater.deferred, 2);
eq('건수는 줄지 않음(소재 고갈 없음)', twoDaysLater.seeds.length, 3);
eq('신규 원문이 프롬프트 앞자리', twoDaysLater.seeds[0].url, NEW_SEED.url);
ok('재수집분은 뒤로', twoDaysLater.seeds.slice(1).every(s => s.url !== NEW_SEED.url));

// mark_limit 밖(프롬프트가 보지 못한 뒷자리)은 기록하지 않는다 → 100건 관찰로 씨앗이 마르지 않음.
const capped = orderSeedsBySeen([NEW_SEED, S1, S2], {}, { window_days: 8, mark_limit: 1, now: D2 });
eq('mark_limit 만큼만 기록', capped.marked, 1);
eq('앞자리 1건만 기록됨', Object.keys(capped.store).length, 1);

const after9days = orderSeedsBySeen([S1], first.store, { window_days: 8, now: new Date('2026-08-05T00:00:00Z') });
eq('창(8일) 지나면 완전 신규 복귀', after9days.deferred, 0);


// ─────────────────────────────────────────────────────────────────────────────
// [6] 같은 소재 재탕 차단 — 내용어 유사도 (2026-08-21 신설)
//
// 이 절이 지키는 사건: 같은 이야기가 다른 문장으로 세 번 재발행됐다.
//   08-14 "…철제 의수로 40년…기사"   ↔ 08-19 "…철제 의수로 40년 더 싸운 기사"  (5일 간격)
//   08-17 "지하철 안내방송…남편을 잃은 여성" ↔ 08-20 "남편 목소리 안내방송…미망인" (3일 간격)
//   08-17 "죽은 연어의 뇌…fMRI 실험"   ↔ 08-21 "죽은 연어의 뇌가 사람 사진에 '반응'했다" (4일 간격)
// 셋 다 문자 bigram 으로는 0.18~0.29 라 임계 0.45 를 못 넘었다. 표현이 아니라 소재를 봐야 잡힌다.
//
// ⚠ 이 판정은 **코퍼스 의존적**이다 — 희소도를 기존 주제 전체에서 추정하기 때문에,
//   비교 대상 1건만 넘기면 약해진다. 그래서 테스트도 실제와 같은 조건(누적 주제 목록)으로 세운다.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] 같은 소재 재탕 차단(내용어 유사도)');

/**
 * 배경 코퍼스 — 실제 발행 이력에서 뽑은 서로 무관한 주제 95건(fixtures/curiosity-subjects.json).
 *
 * ⚠ 왜 90건씩이나 쓰나: 소재 판정은 낱말의 희소도를 **기존 주제 전체**에서 추정한다.
 *   코퍼스가 작으면 무엇이 드문 말인지 알 수 없어 판정이 약해진다. 실제로 지하철 안내방송 쌍은
 *   코퍼스 30건에서 0.137, 90건에서 0.143 으로 임계(0.14)를 그때서야 넘는다. 작은 배열로
 *   테스트하면 운영과 다른 조건을 재는 셈이라 통과·실패가 모두 무의미해진다.
 */
const CORPUS = JSON.parse(
  readFileSync(new URL('./fixtures/curiosity-subjects.json', import.meta.url), 'utf8'),
).subjects;

/** 실제로 발행돼 버린 재탕 3쌍 — [기존 주제, 나중에 올라온 후보]. */
const REPEATS = [
  ['대포알에 오른손을 잃고 철제 의수로 40년을 더 싸운 기사',
   '총알에 팔을 잃고 스프링 손을 만들어 30년 더 싸운 기사'],
  ['지하철 안내방송이 사라지자 남편을 잃은 여성',
   '지하철 안내방송을 들으려고 매일 같은 역에 앉아 있던 할머니'],
  ['죽은 연어의 뇌가 사람의 감정을 읽었다는 fMRI 실험',
   "죽은 연어의 뇌가 사람 사진에 '반응'했다"],
];

for (const [prior, candidate] of REPEATS) {
  const done = [...CORPUS, prior];
  const d = isNearDuplicate(candidate, done, cfg.pick.similarity);
  ok(`재탕 차단: ${candidate.slice(0, 18)}…`, d.dup,
    `bigram=${d.jaccard} topic=${d.topic} — 표현이 달라도 소재가 같으면 막아야 한다`);
  ok(`  └ bigram 만으로는 못 잡던 건이다`, d.jaccard < (cfg.pick.similarity.bigram_jaccard ?? 0.45),
    `bigram=${d.jaccard}`);
}

/**
 * 오차단 방어 — 배경 코퍼스 95건을 서로 대조해 **과차단이 번지지 않는지** 고정한다.
 *
 * 0 을 요구하지 않는다. 실제 중복 최저값(0.145)과 최근접 오차단(0.181)이 겹쳐 있어 완전분리가
 * 불가능하고, 놓치지 않는 쪽을 택한 대가로 아래 2쌍은 알면서 감수하는 비용이다:
 *   · 비행기 창문 ↔ 마일리지 — 진짜 오차단(둘은 다른 이야기다)
 *   · '만약 인류가 끝내 …못했다면' 2건 — 문형까지 같아 시청자에겐 실제로 비슷하게 보인다
 * 목록으로 못 박아 두면 임계·불용어를 건드렸을 때 **새로운** 과차단이 생기는 즉시 드러난다.
 */
{
  const pairs = new Set();
  for (let i = 0; i < CORPUS.length; i++) {
    const rest = CORPUS.filter((_, j) => j !== i);
    const d = isNearDuplicate(CORPUS[i], rest, cfg.pick.similarity);
    if (d.dup) pairs.add([CORPUS[i], d.against].sort().join(' ↔ '));
  }
  eq('서로 다른 주제끼리의 과차단은 알려진 2쌍뿐', pairs.size, 2);
  ok('과차단 1: 비행기 창문 ↔ 마일리지',
    [...pairs].some(p => p.includes('비행기 창문') && p.includes('마일리지')), [...pairs].join(' / '));
  ok('과차단 2: 만약 인류가… 2건(문형 동일)',
    [...pairs].some(p => p.includes('바퀴') && p.includes('불을 다루는')), [...pairs].join(' / '));
}

ok('어느 관문이 잡았는지 알려준다(topic)',
  isNearDuplicate(REPEATS[2][1], [...CORPUS, REPEATS[2][0]], cfg.pick.similarity).by === 'topic');
ok('표현 재탕은 wording 으로 잡힌다',
  isNearDuplicate('총알 없는 총으로 자기 머리를 쐈던 배우 (공포탄의 진실)',
    ['총알 없는 총으로 자기 머리를 쐈던 배우'], cfg.pick.similarity).by === 'wording');

// 하위호환: 새 관문을 끄면 기존(표현) 판정만 남는다.
ok('topic:false 면 소재 관문이 꺼진다',
  !isNearDuplicate(REPEATS[2][1], [...CORPUS, REPEATS[2][0]],
    { ...cfg.pick.similarity, topic: false }).dup);

// 내용어 추출: 조사·상투어가 빠지고 알맹이만 남아야 한다.
{
  const t = contentTokens('죽은 연어의 뇌가 사람 사진에 반응했다');
  ok('조사가 떨어진다(연어의→연어)', t.includes('연어'), JSON.stringify(t));
  ok('상투어 사람 은 내용어에서 빠진다', !t.includes('사람'), JSON.stringify(t));
}

// 코퍼스가 모자라면 소재 관문은 **꺼진다**. 희소도를 못 재는 구간에서 근거 없이 차단하면
// "호랑이는 주황색이 아니다" ↔ "유리는 액체가 아니다" 처럼 '아니다' 하나로 오차단이 난다(실측 0.155).
{
  const few = ['유리는 액체가 아니다', '혀의 맛 지도는 틀렸다'];
  ok('코퍼스 부족 구간에선 소재 관문 미적용',
    !isNearDuplicate('호랑이는 주황색이 아니다', few, cfg.pick.similarity).dup);
  ok('그래도 표현 재탕은 코퍼스와 무관하게 잡힌다',
    isNearDuplicate('총알 없는 총으로 자기 머리를 쐈던 배우 (공포탄의 진실)',
      ['총알 없는 총으로 자기 머리를 쐈던 배우'], cfg.pick.similarity).dup);
  // 가중치 계산 자체는 하한(MIN_CORPUS_FOR_IDF) 덕에 작은 코퍼스에서도 뒤집히지 않는다.
  const t = topicSimilarity(REPEATS[2][1], REPEATS[2][0], tokenDocFreq([REPEATS[2][0]]));
  ok('가중치 역전 없음(작은 코퍼스에서도 같은 소재는 양수)', t > 0.1, `topic=${t.toFixed(3)}`);
}

// 파이프라인 통합: 소재 중복은 similar_subject 로 영구 탈락한다.
{
  const prior = REPEATS[0][0];
  const idxWithPrior = {};
  CORPUS.concat([prior]).forEach((s, i) => { idxWithPrior['c' + i] = { status: 'uploaded', subject: s, angle: 'reveal', at: '2026-08-01T00:00:00Z' }; });
  const r = filterCandidates({
    items: [{ id: 'new', subject: REPEATS[0][1], angle: 'reveal', domain: '역사' }],
    index: idxWithPrior, backlog: [], cfg, now: NOW,
  });
  eq('소재 재탕은 후보에서 제외', r.items.length, 0);
  eq('사유는 similar_subject', r.blocked[0]?.reason, 'similar_subject');
}


// ─────────────────────────────────────────────────────────────────────────────
// [7] 리뷰 지적 보강 (2026-08-21 코덱스 적대적 검증 반영)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] 재탕 차단 보강');

// (a) 낱말 하나만 겹치는 건 소재 일치가 아니다 — 코퍼스 크기와 무관하게 성립해야 한다.
{
  // ⚠ '뇌' 는 1글자라 내용어에서 빠지고, '뇌가' 는 2글자라 stripJosa 가 손대지 않는다.
  //    그래서 겹치는 건 {죽은, 연어} 2개다 — 형태소 분석 없이 어절을 자르는 방식의 한계이자
  //    실제 동작이므로, 이상적인 값이 아니라 이 값을 고정한다.
  eq('공유 내용어 개수 계산', sharedContentTokens('죽은 연어의 뇌가 반응했다', '죽은 연어의 뇌 실험'), 2);
  // 용언('아니다') 하나만 겹치는 경우. 코퍼스에 '아니다' 로 끝나는 주제가 여럿 있어도
  // 낱말 1개 공유로는 차단되면 안 된다.
  ok('용언 하나만 겹치면 차단하지 않는다(코퍼스 작아도)',
    !isNearDuplicate('고래는 물고기가 아니다', ['유리는 액체가 아니다'], cfg.pick.similarity).dup);
  ok('용언 하나만 겹치면 차단하지 않는다(코퍼스 커도)',
    !isNearDuplicate('고래는 물고기가 아니다', [...CORPUS, '유리는 액체가 아니다'], cfg.pick.similarity).dup);
  // 반대로 같은 소재가 코퍼스에 실재하면 잡혀야 한다(대조군이 무력한 테스트가 아님을 보인다).
  ok('코퍼스에 같은 소재가 있으면 잡는다',
    isNearDuplicate('호랑이는 주황색이 아니다', CORPUS, cfg.pick.similarity).dup);
  // 예전엔 코퍼스 30건 미만이면 관문을 통째로 껐다 — 그 사각지대가 없어졌는지 본다.
  ok('작은 코퍼스에서도 진짜 재탕은 잡힌다',
    isNearDuplicate("죽은 연어의 뇌가 사람 사진에 '반응'했다",
      ['죽은 연어의 뇌가 사람의 감정을 읽었다는 fMRI 실험'], cfg.pick.similarity).dup);
}

// (b) 같은 배치 안에서 서로 재탕인 두 후보가 함께 뽑히면 안 된다(best_n>=2 경로).
{
  const mk = (id, subject) => ({ item: { id, subject, angle: 'reveal', domain: '과학' }, total: 0.9 });
  const sorted = [
    mk('a', '죽은 연어의 뇌가 사람의 감정을 읽었다는 fMRI 실험'),
    mk('b', "죽은 연어의 뇌가 사람 사진에 '반응'했다"),
    mk('c', '트로이 목마는 일리아스에 없다'),
  ];
  const taken = takeWithWhatifCap(sorted, 2, 0, { similarity: cfg.pick.similarity });
  eq('2편을 뽑는다', taken.length, 2);
  const ids = taken.map(t => t.item.id);
  ok('같은 소재 두 건이 같은 배치에 함께 담기지 않는다', !(ids.includes('a') && ids.includes('b')), ids.join(','));
  ok('대신 다른 소재가 채운다', ids.includes('c'), ids.join(','));
  // similarity 를 안 주면 기존 동작(배치 내 중복 미검사) 그대로 — 하위호환.
  eq('similarity 미지정이면 기존 동작', takeWithWhatifCap(sorted, 2, 0).map(t => t.item.id).join(','), 'a,b');
}

// (c) 운영 config 가 보정값에서 벗어나면 알아채야 한다(코드 기본값만 검증하면 드리프트를 놓친다).
{
  const shipped = loadConfig().pick?.similarity ?? {};
  eq('배포 config 의 topic_jaccard 가 보정값 0.14', shipped.topic_jaccard, 0.14);
  eq('배포 config 의 bigram_jaccard 가 0.45', shipped.bigram_jaccard, 0.45);
  ok('배포 config 로도 실제 재탕이 차단된다',
    isNearDuplicate(REPEATS[0][1], [...CORPUS, REPEATS[0][0]], shipped).dup);
}

console.log(`\n호기심 콘텐츠 룰(US-003): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
