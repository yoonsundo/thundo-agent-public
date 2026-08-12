#!/usr/bin/env node
/**
 * cardnews-caption.test.mjs — caption.mjs(§3.12, AC-11) 경계 유닛테스트
 *
 * 순수 함수 테스트 — 크리덴셜/네트워크 불필요. 계획 Step 3a 완료조건의 8종 경계 케이스를
 * 그대로 검증한다:
 *   ①정상 ②본문만 초과 ③본문 전삭 후에도 초과 ④해시태그 47개 ⑤해시태그만으로 2200 초과
 *   ⑥빈 입력 ⑦모든 절삭 경로에서 마커 생존 ⑧trimEnd().endsWith(idemMarker) 전건 성립
 *
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import { buildCaption } from '../cardnews/caption.mjs';
import { idemMarker } from '../cardnews/lib.mjs';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};

const CFG = { caption: { max_chars: 2200, max_hashtags: 30 } };
const POST_ID = 'cn-2026-08-01-a1b2c3d4';
const MARKER = idemMarker(POST_ID); // '#cn20260801a1b2c3d4'

/** 마커·불변식은 모든 케이스에서 공통 검증한다(⑦⑧). */
function assertInvariants(label, result, cta) {
  ok(`${label}: chars<=2200`, result.chars <= 2200, `chars=${result.chars}`);
  ok(`${label}: hashtagCount<=30`, result.hashtagCount <= 30, `count=${result.hashtagCount}`);
  ok(`${label}: caption.length===chars`, result.caption.length === result.chars);
  ok(`${label}: cta 포함`, result.caption.includes(cta), result.caption.slice(-120));
  ok(`${label}: idemMarker===lib.idemMarker(postId)`, result.idemMarker === MARKER, result.idemMarker);
  ok(
    `${label}: 마커가 캡션 최말미(trimEnd().endsWith)`,
    result.caption.trimEnd().endsWith(MARKER),
    result.caption.slice(-80)
  );
}

// ── ① 정상 — 여유 있는 입력, 아무것도 절삭되지 않는다 ────────────────────────
console.log('\n[1] 정상 입력');
{
  const input = {
    hook: '일본 목욕탕에서 문신을 가리는 이유, 생각보다 최근 얘기다',
    body: '온천 문화가 정착된 건 근대 이후다. 초기엔 문신 규제가 없었다. 폭력조직과의 연결이 알려지며 90년대 이후 급격히 금기가 됐다.',
    cta: '저장해두고 여행 전 다시 확인하세요.',
    hashtags: ['#세계문화', '#일본', '#여행상식'],
    postId: POST_ID,
  };
  const r = buildCaption(input, CFG);
  ok('body 미절삭', !r.truncated.body);
  ok('hook 미절삭', !r.truncated.hook);
  ok('hashtags 미절삭', !r.truncated.hashtags);
  ok('hook 원문 포함', r.caption.includes(input.hook));
  ok('body 원문 포함', r.caption.includes(input.body));
  ok('해시태그 3개 + 마커 = 4', r.hashtagCount === 4, `count=${r.hashtagCount}`);
  assertInvariants('정상', r, input.cta);
}

// ── ② body 만 초과 — 문장 경계로 줄면 한도 안에 들어온다 ─────────────────────
console.log('\n[2] body 만 초과');
{
  const sentence = '이 나라에서는 식사 중 젓가락을 밥그릇에 꽂으면 제사를 연상시켜 매우 무례하게 여겨진다. ';
  const input = {
    hook: '젓가락 매너, 나라마다 이렇게 다르다',
    body: sentence.repeat(60), // 문장 다수, 충분히 길어 절삭 필요
    cta: '더 알고 싶다면 프로필 링크 확인.',
    hashtags: ['#식사예절', '#젓가락'],
    postId: POST_ID,
  };
  const full = input.hook + input.body + input.cta + input.hashtags.join('') + MARKER;
  ok('픽스처 전제: 원본은 2200자 초과', full.length > 2200, `full=${full.length}`);
  const r = buildCaption(input, CFG);
  ok('body 절삭됨', r.truncated.body);
  ok('hook 미절삭', !r.truncated.hook);
  ok('hashtags 미절삭', !r.truncated.hashtags);
  ok('hook 원문 그대로 포함', r.caption.includes(input.hook));
  assertInvariants('body만초과', r, input.cta);
}

// ── ③ body 전삭 후에도 초과 — hook 도 잘려야 한다 ───────────────────────────
console.log('\n[3] body 전삭 후에도 초과');
{
  const input = {
    hook: '나라별 인사 예절 총정리 — '.repeat(160), // hook 자체가 매우 김 (>2200자)
    body: '짧은 본문.',
    cta: '저장 필수.',
    hashtags: ['#인사예절'],
    postId: POST_ID,
  };
  ok('픽스처 전제: hook 단독으로도 2200 초과', input.hook.length > 2200, `hook=${input.hook.length}`);
  const r = buildCaption(input, CFG);
  ok('body 전삭됨', r.truncated.body);
  ok('hook 절삭됨', r.truncated.hook);
  ok('원래 body 문장이 사라짐(전삭)', !r.caption.includes('짧은 본문.'));
  assertInvariants('body전삭', r, input.cta);
}

// ── ④ 해시태그 47개 — 29(+마커=30)로 컷 ──────────────────────────────────────
console.log('\n[4] 해시태그 47개');
{
  const hashtags = Array.from({ length: 47 }, (_, i) => `#태그${i}`);
  const input = {
    hook: '나라별 팁 문화',
    body: '팁을 주는 나라도, 주지 않는 나라도 있다.',
    cta: '저장하세요.',
    hashtags,
    postId: POST_ID,
  };
  const r = buildCaption(input, CFG);
  ok('hashtags 절삭됨', r.truncated.hashtags);
  ok('해시태그 정확히 30개(29+마커)', r.hashtagCount === 30, `count=${r.hashtagCount}`);
  ok('앞쪽 태그(#태그0) 보존 — 뒤에서부터 제거', r.caption.includes('#태그0'));
  ok('뒤쪽 태그(#태그46) 탈락 — 뒤에서부터 제거', !r.caption.includes('#태그46'));
  assertInvariants('해시태그47개', r, input.cta);
}

// ── ⑤ 해시태그만으로 2200 초과 — body/hook 비워도 안 되면 해시태그 자체를 깎는다 ─
console.log('\n[5] 해시태그만으로 2200 초과');
{
  // 태그 하나가 60자 안팎 × 29개 컷 이후에도 여전히 2200 초과하도록 구성.
  const longTag = '#' + '가나다라마바사아자차'.repeat(9); // 91자
  const hashtags = Array.from({ length: 47 }, (_, i) => `${longTag}${i}`);
  const input = {
    hook: '금기 몸짓 모음',
    body: '나라마다 무심코 한 손짓이 실례가 될 수 있다.',
    cta: '저장하세요.',
    hashtags,
    postId: POST_ID,
  };
  // 29개로만 컷했을 때 이미 2200을 넘는지 픽스처로 확인.
  const cappedLine = hashtags.slice(0, 29).join(' ') + ' ' + MARKER;
  ok('픽스처 전제: 29개 컷만으로도 2200 초과', cappedLine.length > 2200, `line=${cappedLine.length}`);
  const r = buildCaption(input, CFG);
  ok('hashtags 절삭됨(추가 드롭)', r.truncated.hashtags);
  ok('hashtagCount 가 29+1 보다 작음(더 깎임)', r.hashtagCount < 30, `count=${r.hashtagCount}`);
  ok('cta 는 보존', r.caption.includes(input.cta));
  assertInvariants('해시태그만2200초과', r, input.cta);
}

// ── ⑥ 빈 입력 — 마커만 남아도 불변식은 성립해야 한다 ────────────────────────
console.log('\n[6] 빈 입력');
{
  const input = { hook: '', body: '', cta: '', hashtags: [], postId: POST_ID };
  const r = buildCaption(input, CFG);
  ok('caption === marker', r.caption === MARKER, r.caption);
  ok('hashtagCount === 1(마커만)', r.hashtagCount === 1, `count=${r.hashtagCount}`);
  ok('아무것도 절삭 안 됨(원래 없었으니까)', !r.truncated.body && !r.truncated.hook && !r.truncated.hashtags);
  assertInvariants('빈입력', r, '');
}

// ── ⑦+⑧ 회귀 가드 — 위 6종 전체에서 마커가 항상 물리적 최말미다 ─────────────
console.log('\n[7+8] 전 케이스 마커 생존 회귀 가드');
{
  const cases = [
    { hook: 'A', body: 'B. '.repeat(2000), cta: 'C', hashtags: ['#x'], postId: POST_ID },
    { hook: 'H '.repeat(1500), body: '본문', cta: 'CTA', hashtags: [], postId: POST_ID },
    { hook: '훅', body: '본문', cta: '행동유도', hashtags: Array.from({ length: 60 }, (_, i) => `#h${i}가나다라마바사아자차카타파하`.repeat(3)), postId: POST_ID },
    { hook: '', body: '', cta: '', hashtags: [], postId: POST_ID },
  ];
  for (const [i, input] of cases.entries()) {
    const r = buildCaption(input, CFG);
    ok(`케이스${i}: trimEnd().endsWith(idemMarker(postId))`, r.caption.trimEnd().endsWith(idemMarker(input.postId)));
    ok(`케이스${i}: chars<=2200`, r.chars <= 2200, `chars=${r.chars}`);
  }
}

console.log(`\ncardnews caption(Step 3a): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
