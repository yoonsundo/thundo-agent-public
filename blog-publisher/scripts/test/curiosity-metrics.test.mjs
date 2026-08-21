#!/usr/bin/env node
/**
 * curiosity-metrics.test.mjs — 북극성 지표 + 가드레일 3종 유닛테스트
 *
 * 핵심 검증은 두 가지다.
 *  ① **역검증**: 과거에 실제로 사고가 났을 때 이 지표가 울렸을 것인가.
 *     (07-25·26 이틀 결방 / 08월 역사 편중 / 07-29 문구변형 재탕)
 *     울리지 않는 가드레일은 붙일 이유가 없다.
 *  ② **정상일 때 조용한가**: 오탐이 잦으면 아무도 안 본다.
 *
 * 순수 함수 + 인메모리 데이터만 쓴다 — 실 state/네트워크/크리덴셜 불필요. exit 0/1.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  publishingContinuity, topicDiversity, repeatRate, northStar,
  d7Views, computeMetrics, renderMetrics, kstDay, uploadedEntries, loadAnalytics,
} = await import('../shorts-curiosity/metrics.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const CFG = {
  pick: {
    daily_target: 2,
    similarity: { enabled: true, bigram_jaccard: 0.45, topic_jaccard: 0.14, substring: true, min_chars: 6 },
  },
};

/** 인덱스 헬퍼 — KST 날짜와 분야/주제로 업로드 1건. */
let seq = 0;
const up = (day, domain, subject, angle = 'reveal') => ({
  [`v${++seq}`]: {
    status: 'uploaded', youtube_id: `yt${seq}`,
    uploaded_at: `${day}T03:00:00.000Z`,   // KST 12시 → 같은 날
    domain, subject, angle,
  },
});
const merge = (...objs) => Object.assign({}, ...objs);

// ── 0. 날짜 처리(KST) ────────────────────────────────────────────────────────
console.log('\n[0] KST 날짜 처리');
eq('UTC 20시는 KST 다음날', kstDay('2026-08-20T20:00:00.000Z'), '2026-08-21');
eq('UTC 03시는 같은 날', kstDay('2026-08-21T03:00:00.000Z'), '2026-08-21');
eq('빈 값은 빈 문자열', kstDay(null), '');
eq('업로드 완료분만 집계(youtube_id 없으면 제외)',
  uploadedEntries({ a: { status: 'produced', at: '2026-08-20T03:00:00Z' }, ...up('2026-08-20', '역사', 's') }).length, 1);

// ── 1. 발행 연속성 — 07-25·26 결방 역검증 ────────────────────────────────────
console.log('\n[1] 발행 연속성 (7월 결방 역검증)');
// 07-20~07-24 정상 2편/일, 07-25·26 0편, 07-27~28 정상
let idx = {};
for (const d of ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27', '2026-07-28']) {
  idx = merge(idx, up(d, '역사', `s-${d}-1`), up(d, '과학', `s-${d}-2`));
}
const gap = publishingContinuity(idx, { cfg: CFG, today: '2026-07-29', window: 14 });
ok('결방이 있으면 breach', gap.breach, JSON.stringify(gap.note));
eq('결방일 2일 탐지', gap.zeroDays.length, 2);
eq('결방일이 07-25·26', gap.zeroDays.map(z => z.day).join(','), '2026-07-25,2026-07-26');
eq('부족분 총 4편(2일×2편)', gap.missingTotal, 4);

// 정상 구간에서는 조용해야 한다.
let clean = {};
for (let i = 0; i < 11; i++) {           // 08-11 ~ 08-21 매일 2편
  const d = `2026-08-${String(11 + i).padStart(2, '0')}`;
  clean = merge(clean, up(d, '역사', `c-${d}-1`), up(d, '과학', `c-${d}-2`));
}
const okRun = publishingContinuity(clean, { cfg: CFG, today: '2026-08-21', window: 7 });
ok('정상 구간은 breach 아님', !okRun.breach, JSON.stringify(okRun.note));
eq('결방일 0', okRun.zeroDays.length, 0);

// 오늘은 아직 슬롯이 남아 있으므로 결손 판정에서 빠져야 한다(오탐 방지).
const todayPartial = publishingContinuity(merge(clean, up('2026-08-22', '역사', 'today-1')),
  { cfg: CFG, today: '2026-08-22', window: 7 });
eq('오늘 1편이어도 결방 판정 아님', todayPartial.breach, false);
eq('오늘 편수는 따로 보고', todayPartial.today, 1);

// ⚠ 지름길 차단 — 결방일만 보면 "적게 내서 편당 지표를 올리는" 경로가 열린다.
// 북극성이 편당 조회수라 편수를 줄일수록 중앙값은 오른다. 하루 1편씩(계획의 절반) 꾸준히
// 내면 결방일은 0 이라 예전 로직에서는 경보가 안 떴다(실측 확인 후 이행률 가드 추가).
{
  const mkDays = (perDay) => {
    const idx = {}; let k = 0;
    for (let i = 0; i < 14; i++) {
      const d = `2026-08-${String(8 + i).padStart(2, '0')}`;
      for (let j = 0; j < perDay; j++) {
        idx[`f${k}`] = { status: 'uploaded', youtube_id: `fy${k}`, uploaded_at: `${d}T03:00:00.000Z`,
          domain: ['과학', '역사', '인체', '일상', '심리', '우주', '음식'][k % 7], subject: `fs${k}` };
        k++;
      }
    }
    return idx;
  };
  const full = publishingContinuity(mkDays(2), { cfg: CFG, today: '2026-08-22', window: 14 });
  eq('계획대로 내면 이행률 100%', Math.round(full.fulfillment * 100), 100);
  ok('계획대로면 breach 아님', !full.breach, full.note);

  const half = publishingContinuity(mkDays(1), { cfg: CFG, today: '2026-08-22', window: 14 });
  eq('절반만 내면 이행률 50%', Math.round(half.fulfillment * 100), 50);
  ok('결방이 0 이어도 이행률 미달이면 breach', half.breach, full.note);
  eq('결방일은 실제로 0', half.zeroDays.length, 0);
  ok('note 가 결방이 아니라 이행률 문제임을 밝힌다',
    half.note.includes('이행률') && half.note.includes('계획보다 적게'), half.note);

  // 초과 발행은 위반이 아니다(오탐 가드) — 실데이터가 목표 2편에 3편이라 150% 다.
  const over = publishingContinuity(mkDays(3), { cfg: CFG, today: '2026-08-22', window: 14 });
  ok('초과 발행은 breach 아님', !over.breach, over.note);
  ok('이행률 100% 초과로 보고', over.fulfillment > 1, String(over.fulfillment));

  // 임계는 config 로 조정된다(죽은 손잡이가 아님).
  const strict = publishingContinuity(mkDays(2), {
    cfg: { ...CFG, metrics: { min_fulfillment: 1.5 } }, today: '2026-08-22', window: 14 });
  ok('임계를 올리면 판정이 따라온다', strict.breach, strict.note);
}

// ⚠ 회귀: 창이 **첫 업로드 이전**으로 넘어가면 안 된다. 채널이 없던 날을 결방으로 세면
// 신생 채널이나 창을 늘린 순간 지표가 통째로 빨개진다(이 테스트가 실제로 그 버그를 잡았다).
const young = merge(up('2026-08-20', '역사', 'y1'), up('2026-08-20', '과학', 'y2'),
  up('2026-08-21', '인체', 'y3'), up('2026-08-21', '우주', 'y4'));
const youngR = publishingContinuity(young, { cfg: CFG, today: '2026-08-22', window: 30 });
eq('첫 업로드 이전은 결방으로 세지 않음', youngR.zeroDays.length, 0);
ok('신생 채널도 breach 아님', !youngR.breach, JSON.stringify(youngR.note));

// 편수 목표가 바뀌면 판정도 따라간다(3편 시절 기준으로 보면 부족분이 생긴다).
const at3 = publishingContinuity(clean, { cfg: { pick: { daily_target: 3 } }, today: '2026-08-21', window: 7 });
ok('목표 3편이면 부족분 발생', at3.missingTotal > 0, `missing=${at3.missingTotal}`);
eq('결방일은 없다', at3.zeroDays.length, 0);
// 목표 3편에 2편씩 = 이행률 67% → 결방은 없어도 구조적 미달이라 위반이 맞다.
ok('결방이 없어도 이행률 미달이면 breach', at3.breach, at3.note);

// ── 2. 소재 다양성 — 8월 역사 편중 역검증 ────────────────────────────────────
console.log('\n[2] 소재 다양성 (8월 역사 편중 역검증)');
// 실측 재현: 7일 21편 중 역사 11편 ≈ 0.52
let conc = {};
const days7 = ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21'];
days7.forEach((d, i) => {
  conc = merge(conc, up(d, '역사', `h-${d}-1`), up(d, i % 2 ? '역사' : '과학', `x-${d}-2`), up(d, '일상', `y-${d}-3`));
});
const div = topicDiversity(conc, { cfg: CFG, today: '2026-08-21', window: 7 });
ok('역사 편중이면 breach', div.breach, JSON.stringify(div.note));
eq('최다 분야는 역사', div.topDomain, '역사');
ok('점유율이 기준 0.40 초과', div.share > 0.40, `share=${div.share}`);
ok('같은 날 같은 분야 중복일 탐지', div.sameDayDupDays.length > 0, JSON.stringify(div.sameDayDupDays));

// 고르게 분산되면 조용하다.
// 세 가드레일이 모두 조용해야 하는 "건강한" 표본. 세 조건을 동시에 만족시켜야 한다:
//  ① 하루 2편(=daily_target) → 이행률 100%   ② 분야 분산 → 편중 없음
//  ③ 주제가 서로 충분히 달라야 함 — ⚠ `sp0`·`sp1` 같은 짧은 문자열을 쓰면 유사도 함수가
//    서로를 재탕으로 잡는다(실제로 겪음). 실제 주제처럼 길고 서로 무관한 문장을 쓴다.
const SPREAD = [
  ['과학', '죽은 연어의 뇌가 사람 사진에 반응했다'], ['인체', '다이어트로 뺀 살은 대부분 숨으로 빠져나간다'],
  ['역사', '나폴레옹은 사실 당대 평균보다 컸다'], ['일상', '감열지 영수증은 물에 닿으면 글씨가 사라진다'],
  ['심리', '사람은 자기 목소리 녹음을 유독 싫어한다'], ['우주', '토성의 고리는 생각보다 훨씬 얇다'],
  ['음식', '와사비의 99퍼센트는 와사비가 아니다'], ['동물', '호랑이 줄무늬는 피부에도 새겨져 있다'],
  ['기술', '최초의 컴퓨터 버그는 진짜 나방이었다'], ['과학', '유리는 액체가 아니라 고체다'],
  ['인체', '혀의 맛 지도는 잘못 번역된 논문에서 나왔다'], ['역사', '만리장성은 우주에서 보이지 않는다'],
  ['일상', '엘리베이터 닫힘 버튼은 대개 작동하지 않는다'], ['심리', '금붕어 기억력 3초설은 근거가 없다'],
];
const spread = SPREAD.reduce((acc, [dom, subj], i) =>
  merge(acc, up(`2026-08-${15 + Math.floor(i / 2)}`, dom, subj)), {});
const spreadR = topicDiversity(spread, { cfg: CFG, today: '2026-08-21', window: 7 });
ok('고른 분포는 breach 아님', !spreadR.breach, JSON.stringify(spreadR.note));
eq('고유 분야 9개', spreadR.uniqueDomains, 9);
eq('같은 날 중복 없음', spreadR.sameDayDupDays.length, 0);

// ⚠ 핵심 회귀: domain 결손을 한 분야로 세면 안 된다(초기 데이터가 쏠림으로 둔갑).
let missingDom = {};
for (let i = 0; i < 6; i++) missingDom = merge(missingDom, up(`2026-08-${16 + (i % 6)}`, '', `m${i}`));
missingDom = merge(missingDom,
  up('2026-08-19', '역사', 'r1'), up('2026-08-20', '과학', 'r2'),
  up('2026-08-20', '인체', 'r3'), up('2026-08-21', '일상', 'r4'),
  up('2026-08-21', '우주', 'r5'));
const md = topicDiversity(missingDom, { cfg: CFG, today: '2026-08-21', window: 7 });
eq('domain 결손은 분모에서 제외', md.sample, 5);
eq('결손 건수를 따로 보고', md.skipped, 6);
ok('결손이 쏠림으로 둔갑하지 않음', !md.breach, JSON.stringify(md.note));

// 표본이 너무 적으면 판정하지 않는다.
const tiny = topicDiversity(up('2026-08-21', '역사', 't1'), { cfg: CFG, today: '2026-08-21', window: 7 });
eq('표본 부족은 no-data', tiny.status, 'no-data');

// ── 3. 재탕률 — 07-29 문구변형 재탕 역검증 ───────────────────────────────────
console.log('\n[3] 재탕률 (문구변형 재탕 역검증)');
const PRIOR = '총알 없는 총으로 자기 머리를 쐈던 배우';
const RETRY = '총알 없는 총으로 자기 머리를 쐈던 배우 (공포탄의 진실)';
const dupIdx = merge(
  up('2026-08-18', '역사', PRIOR),
  up('2026-08-20', '역사', RETRY),
  up('2026-08-19', '과학', '죽은 연어의 뇌가 사람 사진에 반응했다'),
);
const rep = repeatRate(dupIdx, [], { cfg: CFG, today: '2026-08-21', window: 30 });
ok('문구만 바꾼 재탕을 탐지', rep.breach, JSON.stringify(rep.note));
eq('재탕 1건', rep.count, 1);
eq('나중에 나간 쪽이 재탕으로 기록', rep.pairs[0].subject, RETRY);
eq('대조 대상은 먼저 나간 쪽', rep.pairs[0].against, PRIOR);

// ⚠ 확정(문구변형)과 의심(주제유사)을 한 숫자로 뭉치면 과장 보고가 된다.
// 실측 오탐: 「항공사의 본업은 마일리지」↔「비행기 창문은 왜 둥근가」 — 둘 다 비행기가 나올 뿐
// 다른 이야기인데 topic 으로 잡혔다. 확정만 breach 로 올리고 의심은 눈으로 확인하게 남긴다.
eq('확정 재탕은 wording 1건', rep.confirmed, 1);
eq('의심은 0건(이 표본엔 주제유사 없음)', rep.suspected, 0);

const topicOnly = merge(
  up('2026-08-17', '기술', '항공사의 진짜 본업은 비행기가 아니라 마일리지 찍어내기다'),
  up('2026-08-19', '기술', '왜 비행기 창문은 네모가 아니라 둥근가'),
);
const to2 = repeatRate(topicOnly, [], { cfg: CFG, today: '2026-08-21', window: 30 });
ok('주제유사만 있으면 의심으로 분류', to2.suspected >= 1, JSON.stringify(to2.pairs));
eq('확정 0건', to2.confirmed, 0);
// ⚠ 의심도 위반이다. 확정만 위반으로 두면 실제 3회 발행된 「유언장 출산 레이스」
// (08-06·08-09·08-11 — 전부 topic)가 조용히 통과한다. 실측 topic 10건 중 진짜가 8건이다.
ok('의심만 있어도 breach(놓치는 쪽이 더 비싸다)', to2.breach, JSON.stringify(to2.note));
ok('그래도 목록에는 남는다', to2.pairs.length >= 1);

// 서로 다른 주제만 있으면 조용하다(오탐 가드).
const distinct = merge(
  up('2026-08-18', '동물', '호랑이는 주황색이 아니다'),
  up('2026-08-19', '일상', '유리는 액체가 아니다'),
  up('2026-08-20', '음식', '와사비의 99%는 와사비가 아니다'),
);
const dr = repeatRate(distinct, [], { cfg: CFG, today: '2026-08-21', window: 30 });
ok('서로 다른 주제는 재탕 아님', !dr.breach, JSON.stringify(dr.pairs));
eq('재탕 0건', dr.count, 0);

// 창 밖의 재탕은 세지 않는다(창이 의미를 갖는지).
const oldDup = merge(up('2026-06-01', '역사', PRIOR), up('2026-06-03', '역사', RETRY));
eq('창 밖이면 표본 없음', repeatRate(oldDup, [], { cfg: CFG, today: '2026-08-21', window: 30 }).status, 'no-data');

// 유사도 게이트가 꺼져 있으면 지표도 끈다(모순 방지).
eq('게이트 off 면 지표도 off',
  repeatRate(dupIdx, [], { cfg: { pick: { similarity: { enabled: false } } }, today: '2026-08-21' }).status, 'off');

// ── 4. 북극성 — 데이터 없음 / 수집중 / 산출 3상태 ────────────────────────────
console.log('\n[4] 북극성 지표 3상태');
const ns0 = northStar({ snapshots: [], cfg: CFG, today: '2026-08-21' });
eq('스냅샷 0건이면 no-data', ns0.status, 'no-data');
ok('무엇을 해야 하는지 알려준다', /YOUTUBE_API_KEY/.test(ns0.action || ''), ns0.action);

// 수집은 시작했지만 아직 7일이 안 지난 경우
const collecting = [
  { ts: '2026-08-19T02:00:00Z', youtube_id: 'a', published_at: '2026-08-18T03:00:00Z', views: 30 },
  { ts: '2026-08-20T02:00:00Z', youtube_id: 'a', published_at: '2026-08-18T03:00:00Z', views: 80 },
];
const ns1 = northStar({ snapshots: collecting, cfg: CFG, today: '2026-08-21' });
eq('D7 전이면 collecting', ns1.status, 'collecting');
ok('남은 일수를 알려준다', ns1.daysRemaining > 0 && ns1.daysRemaining <= 7, `remaining=${ns1.daysRemaining}`);

// D7 스냅샷이 갖춰지면 중앙값 산출
// 실제 운영 조합을 그대로 쓴다: 발행은 KST 10시(=01:00Z), 수집 cron 은 KST 02시(=17:00Z 전날).
// 그래서 게시 7일 뒤 첫 수집은 7일 16시간 지점에 잡힌다 — 허용창(2일) 안이라 정상 산출된다.
// ⚠ 이 시각 조합을 대충 잡으면 1시간 차이로 창을 빗나가 collecting 으로 떨어진다(실제로 겪음).
const mk = (id, pub, rows) => rows.map(([ts, views]) => ({ ts, youtube_id: id, published_at: pub, views }));
const full = [
  ...mk('v1', '2026-08-01T01:00:00Z', [['2026-08-02T17:00:00Z', 10], ['2026-08-08T17:00:00Z', 100]]),
  ...mk('v2', '2026-08-02T01:00:00Z', [['2026-08-03T17:00:00Z', 20], ['2026-08-09T17:00:00Z', 300]]),
  ...mk('v3', '2026-08-03T01:00:00Z', [['2026-08-04T17:00:00Z', 15], ['2026-08-10T17:00:00Z', 200]]),
];
const ns2 = northStar({ snapshots: full, cfg: CFG, today: '2026-08-21', window: 30 });
eq('D7 갖춰지면 ok', ns2.status, 'ok');
eq('표본 3편', ns2.sample, 3);
eq('중앙값은 200 (100/200/300)', ns2.median, 200);

// ⚠ 중앙값을 쓰는 이유의 회귀: 한 편이 터져도 지표가 끌려가면 안 된다.
const viral = [
  ...mk('v1', '2026-08-01T01:00:00Z', [['2026-08-08T17:00:00Z', 100]]),
  ...mk('v2', '2026-08-02T01:00:00Z', [['2026-08-09T17:00:00Z', 200]]),
  ...mk('v3', '2026-08-03T01:00:00Z', [['2026-08-10T17:00:00Z', 999999]]),
];
const nsV = northStar({ snapshots: viral, cfg: CFG, today: '2026-08-21', window: 30 });
eq('바이럴 1편에 중앙값이 흔들리지 않음', nsV.median, 200);
ok('평균이었다면 크게 흔들렸을 것', (100 + 200 + 999999) / 3 > 300000);

// D7 추출은 게시+7일 이후 **가장 이른** 스냅샷을 쓴다(늦게 잡으면 과대평가).
const many = mk('v1', '2026-08-01T00:00:00Z', [
  ['2026-08-08T00:00:00Z', 100], ['2026-08-09T00:00:00Z', 500], ['2026-08-20T00:00:00Z', 5000],
]);
eq('D7 은 가장 이른 스냅샷', d7Views(many)[0].views, 100);
eq('허용창(2일) 밖만 있으면 산출 안 함',
  d7Views(mk('v9', '2026-08-01T00:00:00Z', [['2026-08-20T00:00:00Z', 5000]])).length, 0);

// ⚠⚠ 계약 테스트 — **수집기가 실제로 쓰는 레코드**로 전 경로를 통과시킨다.
// 이게 없어서 치명 버그를 놓쳤다: d7Views 가 `video_id` 를 읽는데 수집기는 `youtube_id` 를
// 쓴다(analytics-collect.mjs:410). 픽스처가 구현의 가정을 그대로 복사한 탓에 단언은 전부
// green 인데 지표는 구조적으로 죽어 있었다 — API 키를 넣어도 영원히 값이 안 나오고,
// 리포트에는 "수집 N일차 · 0일 뒤부터"라는 영구히 거짓인 문구가 찍혔다.
// 그래서 픽스처를 손으로 짓지 말고 **수집기 출력 스키마를 그대로** 쓴다.
console.log('\n[4-b] 수집기 레코드 계약');
// ⚠ 필드명을 손으로 베끼면 계약이 아니다 — 수집기가 이름을 바꿔도 테스트는 계속 green 이다.
// 그래서 **수집기 소스에서 키를 정적으로 추출**해 그 이름으로만 레코드를 만든다.
// (D-1 이 정확히 이 경로로 생겼다: `{ ts, ...r }` 만 보고 video_id 로 추정 → 지표가 영원히 죽음)
const collectorSrc = readFileSync(new URL('../shorts-curiosity/analytics-collect.mjs', import.meta.url), 'utf8');
const pushMatch = collectorSrc.match(/records\.push\(\{([\s\S]*?)\}\);/);
ok('수집기에서 records.push({...}) 를 찾았다', !!pushMatch);
const COLLECTOR_KEYS = pushMatch ? [...pushMatch[1].matchAll(/(\w+)\s*:/g)].map(x => x[1]) : [];
ok('수집기가 쓰는 키를 추출했다', COLLECTOR_KEYS.length >= 5, JSON.stringify(COLLECTOR_KEYS));
// 지표가 의존하는 세 키가 실제로 수집기에 있는가 — 이름이 바뀌면 여기서 즉시 깨진다.
for (const k of ['youtube_id', 'published_at', 'views']) {
  ok(`수집기가 '${k}' 를 쓴다 (metrics.mjs 가 의존)`, COLLECTOR_KEYS.includes(k), JSON.stringify(COLLECTOR_KEYS));
}
/** 수집기 키만으로 레코드를 만든다. 지표가 다른 이름을 읽고 있으면 여기서 걸린다. */
const collectorRecord = (youtube_id, published_at, ts, views) => {
  const vals = { youtube_id, subject: '주제', title: '제목', published_at, views, likes: 3, comments: 1 };
  const rec = { ts };                                   // appendSnapshots 의 { ts, ...r }
  for (const k of COLLECTOR_KEYS) rec[k] = vals[k];     // ← 손으로 고른 이름이 아니라 소스에서 온 이름
  return rec;
};
const realShape = [
  collectorRecord('yt1', '2026-08-01T01:00:00Z', '2026-08-02T17:00:00Z', 10),
  collectorRecord('yt1', '2026-08-01T01:00:00Z', '2026-08-08T17:00:00Z', 120),
  collectorRecord('yt2', '2026-08-02T01:00:00Z', '2026-08-09T17:00:00Z', 80),
];
const contract = d7Views(realShape);
eq('수집기 레코드에서 D7 이 추출된다', contract.length, 2);
const nsReal = northStar({ snapshots: realShape, cfg: CFG, today: '2026-08-21', window: 30 });
eq('수집기 레코드로 북극성이 산출된다', nsReal.status, 'ok');
eq('중앙값 100 (80·120)', nsReal.median, 100);
ok('필드명 후보에 youtube_id 가 들어있다',
  d7Views([collectorRecord('only-yt', '2026-08-01T01:00:00Z', '2026-08-08T17:00:00Z', 5)]).length === 1);

// 파일 읽기 경로까지 덮는다 — loadAnalytics 는 손상 라인 스킵과 mock 필터를 담당하는데
// 여기까지 안 오면 그 두 동작에 테스트가 없다. ⚠ mock 라인을 안 거르면 사람이 mock 수집을
// 한 번 돌린 순간부터 "YOUTUBE_API_KEY 를 넣어라"는 유일한 조치 안내가 사라진다.
{
  const tmp = join(tmpdir(), `curio-metrics-${process.pid}.jsonl`);
  const real = collectorRecord('ytR', '2026-08-01T01:00:00Z', '2026-08-08T17:00:00Z', 42);
  writeFileSync(tmp, [
    JSON.stringify(real),
    '{ 깨진 json',                                    // 손상 라인
    '',                                               // 빈 줄
    JSON.stringify({ ...real, youtube_id: 'ytM', mock: true }),  // mock 합성
  ].join('\n'), 'utf8');
  const loaded = loadAnalytics(tmp);
  eq('손상 라인·빈 줄을 건너뛴다', loaded.length, 1);
  ok('mock 합성 라인을 거른다', loaded.every(r => !r.mock), JSON.stringify(loaded));
  eq('실 레코드는 살아남는다', loaded[0].youtube_id, 'ytR');
  eq('파일이 없으면 빈 배열', loadAnalytics(join(tmpdir(), 'no-such-file.jsonl')).length, 0);
  rmSync(tmp, { force: true });
}

// 유효 수치가 하나도 없으면 ok 를 내지 않는다(값을 지어내지 않는다).
const junk = [{ ts: '2026-08-10T00:00:00Z', youtube_id: 'z', published_at: '2026-08-01T00:00:00Z', views: 'NaN' }];
const nsJunk = northStar({ snapshots: junk, cfg: CFG, today: '2026-08-21', window: 30 });
ok('유효 조회수 0건이면 ok 아님', nsJunk.status !== 'ok', JSON.stringify(nsJunk));
ok('렌더에 null 회 같은 지어낸 값이 안 나온다',
  !renderMetrics({ north_star: nsJunk, guardrails: {} }).includes('null회'));

// ── 5. 통합 — 어떤 항목이 죽어도 나머지는 낸다 ───────────────────────────────
console.log('\n[5] 통합 산출 · 렌더');
const all = computeMetrics({ index: conc, backlog: [], cfg: CFG, today: '2026-08-21', snapshots: [] });
ok('북극성·가드레일 3종이 모두 존재', !!all.north_star && Object.keys(all.guardrails).length === 3);
const md2 = renderMetrics(all);
ok('렌더에 북극성 섹션', md2.includes('북극성 지표'));
ok('렌더에 가드레일 섹션', md2.includes('가드레일'));
ok('위반은 빨간 표시', md2.includes('🔴'), md2.slice(0, 200));
ok('데이터 없으면 조치 안내가 보인다', md2.includes('YOUTUBE_API_KEY'));
// 파일명(UTC)과 지표(KST)가 하루 다를 수 있으므로 기준일을 명시해야 한다.
ok('렌더에 KST 기준일이 명시된다', md2.includes('지표 기준일') && md2.includes('2026-08-21'), md2.slice(0, 160));

// 손상된 입력에도 던지지 않는다(리포트를 죽이면 안 된다).
const broken = computeMetrics({ index: { x: null, y: { youtube_id: 'z' } }, backlog: null, cfg: CFG, today: '2026-08-21', snapshots: [] });
ok('손상 입력에도 예외 없이 결과 반환', !!broken.guardrails);
ok('렌더도 던지지 않음', typeof renderMetrics(broken) === 'string');

// ── 6. 브리핑 배선 — 위반은 알림 본문 맨 위로, 정상이면 한 줄도 안 늘린다 ──────────
// 리포트 파일에만 적으면 아무도 안 본다(조회수 수집 실패가 매일 경보를 냈는데도 한 달 방치됐다).
console.log('\n[6] 브리핑 배선');
const { breachLines, buildBriefing } = await import('../shorts-curiosity/analytics-report.mjs');

const breached = computeMetrics({ index: conc, backlog: [], cfg: CFG, today: '2026-08-21', snapshots: [] });
const bl = breachLines(breached.guardrails);
ok('위반이 있으면 경고 줄이 나온다', bl.length >= 1, JSON.stringify(bl));
ok('경고 줄은 Telegram Markdown 을 깨지 않는다', bl.every(l => !/[*_[]/.test(l)), JSON.stringify(bl));

const healthy = computeMetrics({ index: spread, backlog: [], cfg: CFG, today: '2026-08-21', snapshots: [] });
eq('정상이면 경고 0줄', breachLines(healthy.guardrails).length, 0);
eq('가드레일이 없으면(산출 실패) 경고 0줄', breachLines(null).length, 0);
eq('산출 불가 상태는 경고로 올리지 않음',
  breachLines({ diversity: { status: 'no-data', breach: true, note: 'x' } }).length, 0);

const chan = { available: false, goal: 500 };
const body = buildBriefing({ rows: [], channel: chan, daily: { delta: null }, today: '2026-08-21', guardrails: breached.guardrails });
ok('브리핑 본문에 경고가 포함된다', body.includes('경고 —'), body.slice(0, 200));
const head = body.split('\n');
ok('경고는 제목 바로 다음 줄부터', head[1].startsWith('경고 —'), JSON.stringify(head.slice(0, 3)));
const quiet = buildBriefing({ rows: [], channel: chan, daily: { delta: null }, today: '2026-08-21', guardrails: healthy.guardrails });
ok('정상이면 브리핑이 늘어나지 않는다', !quiet.includes('경고 —'));
ok('guardrails 미전달도 기존과 동일하게 동작(회귀)',
  !buildBriefing({ rows: [], channel: chan, daily: { delta: null }, today: '2026-08-21' }).includes('경고 —'));

console.log(`\n호기심 지표(북극성+가드레일): ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
