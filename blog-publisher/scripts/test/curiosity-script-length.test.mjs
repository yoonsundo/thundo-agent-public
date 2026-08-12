#!/usr/bin/env node
/**
 * curiosity-script-length.test.mjs — 호기심 쇼츠 대본 길이 예산 가드 유닛테스트
 *
 * 배경(감사 2026-07-30, 37편 실측): 영상 길이가 1주 40.8초 → 2주 48.8초 → 3주 53.8초로
 * 계속 길어지고 30초 미만은 0편이었다. 게이트가 15~75초를 허용하니 LLM 이 상한에 붙은 것.
 * 완주율이 Shorts 랭킹을 지배하므로 "35~45초에 반전 하나 완결"로 되돌리는 게 목표.
 *
 * 검증: 프롬프트 길이 압박 문구 / 앵글별 차등 / 결정론 예산 검증 / 재생성 / 축약 /
 *       초과 잔존 시 경고 후 통과(발행 공백 방지) / 게이트 하한(15초) 불침범.
 * 순수 함수 + 생성기 주입이라 네트워크·claude 호출 없음. exit 0 = 전체 통과 / 1 = 실패.
 */
import { loadConfig } from '../shorts-curiosity/lib.mjs';
import {
  buildPrompt, lengthBudget, checkLength, trimToBudget, countSyllables,
  totalSyllables, estimateSeconds, lengthPromptBlock, resolveScriptWithBudget,
} from '../shorts-curiosity/script.mjs';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const has = (label, hay, needle) => ok(label, String(hay).includes(needle), `"${needle}" 없음`);
const hasNot = (label, hay, needle) => ok(label, !String(hay).includes(needle), `"${needle}" 가 있음`);

const capture = () => {
  const lines = [];
  const rec = (lvl) => (m, extra) => lines.push(`[${lvl}] ${m}${extra !== undefined ? ' ' + String(extra) : ''}`);
  return { lines, debug: rec('DEBUG'), info: rec('INFO'), warn: rec('WARN'), error: rec('ERROR') };
};

const cfg = loadConfig();
const REVEAL = { id: 'aaa111', subject: '반전 주제', common_belief: '흔한 믿음', reveal: '반전 사실', source_hint: '근거', domain: '역사', angle: 'reveal' };
const WHATIF = { ...REVEAL, id: 'bbb222', angle: 'whatif', subject: '만약 ~였다면?' };

/** 한글 음절 n개짜리 나레이션(문장 여러 개로 — 문장 단위 축약 경로를 태우려면 필요). */
const kor = (n) => {
  const sent = [];
  let left = n;
  while (left > 0) {
    const take = Math.min(left, 12);
    sent.push('가'.repeat(take) + '.');
    left -= take;
  }
  return sent.join(' ');
};
const mkScript = (cardSyls, { hook = 20, cta = 24 } = {}) => ({
  hook: kor(hook), cta: kor(cta), hook_image_prompt: '', hook_footage_keywords: [],
  cards: cardSyls.map((n, i) => ({ caption: `자막${i}`, narration: kor(n), image_prompt: 'bg', footage_keywords: ['a'] })),
});
/**
 * 결정론 축약이 손댈 수 없는 초과 대본 — 카드 수가 이미 min_cards(3)이고 각 카드가
 * 종결부호 없는 단일 문장이라 ①카드 제거·②문장 제거 둘 다 적용 불가.
 * (실제로 LLM 이 마침표 없이 길게 뽑을 때 나오는 형태)
 */
const UNTRIMMABLE = {
  hook: '가'.repeat(40), cta: '나'.repeat(40),
  cards: [0, 1, 2].map(i => ({ caption: `자막${i}`, narration: '다'.repeat(130), image_prompt: 'bg', footage_keywords: ['a'] })),
};

// ── 1) 음절 계산·길이 추정 (실측 캘리브레이션) ──
console.log('\n1) 음절 계산 · 길이 추정');
ok('한글만 센다', countSyllables('가나다 abc 123 !?') === 3, String(countSyllables('가나다 abc 123 !?')));
ok('빈/비문자열 안전', countSyllables(null) === 0 && countSyllables(undefined) === 0 && countSyllables(42) === 0);
ok('대본 총합 = hook+카드+cta', totalSyllables(mkScript([30, 30], { hook: 10, cta: 10 })) === 80,
  String(totalSyllables(mkScript([30, 30], { hook: 10, cta: 10 }))));
ok('비정형 입력 0', totalSyllables(null) === 0 && totalSyllables({}) === 0 && totalSyllables({ cards: 'x' }) === 0);
// 실측 평균(236음절 → 46.0초)에 근사해야 한다
{
  const est = estimateSeconds(236, cfg);
  ok(`236음절 → ${est}초 (실측 평균 46.0초 ±3)`, Math.abs(est - 46.0) <= 3, `est=${est}`);
}
ok('단조 증가', estimateSeconds(300, cfg) > estimateSeconds(200, cfg));
ok('0음절도 음수 아님', estimateSeconds(0, cfg) >= 0);

// ── 2) 예산 — 목표는 35~45초, 게이트 하한 불침범 ──
console.log('\n2) 길이 예산');
const bR = lengthBudget(cfg, 'reveal');
const bW = lengthBudget(cfg, 'whatif');
ok('reveal 목표 35~45초', bR.targetLo === 35 && bR.targetHi === 45, JSON.stringify(bR));
ok('whatif 상한이 더 짧다', bW.targetHi < bR.targetHi, `whatif=${bW.targetHi} reveal=${bR.targetHi}`);
ok('whatif 총음절 예산도 더 작다', bW.maxSyl < bR.maxSyl, `${bW.maxSyl} < ${bR.maxSyl}`);
ok('whatif 카드당 상한도 더 작다', bW.perCardHi < bR.perCardHi, `${bW.perCardHi} < ${bR.perCardHi}`);
ok('목표 하한이 게이트 하한(15초)보다 충분히 위', bR.targetLo >= (cfg.gates?.min_sec ?? 15) + 5, `targetLo=${bR.targetLo}`);
ok('예산 상한이 게이트 상한(75초) 아래', estimateSeconds(bR.maxSyl, cfg) < (cfg.gates?.max_sec ?? 75), String(estimateSeconds(bR.maxSyl, cfg)));
ok('예산 소진(4카드 상한)도 목표 상한 이내',
  estimateSeconds(bR.maxCards * bR.perCardHi + 22 + 26, cfg) <= bR.targetHi + 1,
  String(estimateSeconds(bR.maxCards * bR.perCardHi + 22 + 26, cfg)));
ok('카드당 하한 < 상한', bR.perCardLo < bR.perCardHi, `${bR.perCardLo}/${bR.perCardHi}`);
ok('minSyl < maxSyl', bR.minSyl < bR.maxSyl);
ok('config narration 하한(35) 존중(정보량 보호)', bR.perCardLo === (cfg.script?.narration_syllables_per_card?.[0] ?? 35), String(bR.perCardLo));
// insights 힌트는 내리는 방향만
ok('insights 힌트로 상한 하향 반영', lengthBudget(cfg, 'reveal', { maxSecHint: 38 }).targetHi === 38);
ok('insights 힌트로 상한 상향은 무시(길이 창궐 방지)', lengthBudget(cfg, 'reveal', { maxSecHint: 60 }).targetHi === bR.targetHi);
ok('말도 안 되는 힌트 무시', lengthBudget(cfg, 'reveal', { maxSecHint: 3 }).targetHi === bR.targetHi);
ok('힌트 NaN 안전', lengthBudget(cfg, 'reveal', { maxSecHint: 'x' }).targetHi === bR.targetHi);
// config 부재에도 안전
{
  let threw = null; let b;
  try { b = lengthBudget({}, 'reveal'); } catch (e) { threw = e; }
  ok('config 없이도 예외 없이 기본 예산', threw === null && b?.targetHi > b?.targetLo, `${threw} ${JSON.stringify(b)}`);
}

// ── 3) 프롬프트에 길이 압박이 실제로 들어간다 ──
console.log('\n3) 프롬프트 길이 압박 문구');
{
  const p = buildPrompt(REVEAL, cfg);
  has('목표 구간 명시', p, `목표 ${bR.targetLo}~${bR.targetHi}초`);
  has('짧을수록 좋다', p, '짧을수록 좋다');
  has('하단~중앙 지향(상한에 붙지 말 것)', p, `${bR.targetLo}~${Math.round((bR.targetLo + bR.targetHi) / 2)}초를 노려라`);
  has('총 음절 하드 상한', p, `총 나레이션(hook + 카드 전체 + cta) ${bR.maxSyl}음절 이내`);
  has('카드 수 상한 압박', p, `${bR.minCards}장으로 완결되면 ${bR.maxCards}장을 만들지 마라`);
  has('카드당 음절 상한', p, `카드당 나레이션 ${bR.perCardLo}~${bR.perCardHi}음절`);
  has('hook 음절 상한', p, 'hook 12~22음절');
  has('cta 음절 상한', p, 'cta 18~26음절');
  has('하한도 명시(정보량 보호)', p, `총 ${bR.floorSyl}음절 이상`);
  // 프롬프트 내부 모순 방지: min_cards 장으로도 도달 가능한 하한이어야 한다
  ok('하한이 min_cards 조합으로 달성 가능', bR.floorSyl <= bR.minCards * bR.perCardHi + 12 + 18, `floor=${bR.floorSyl}`);
  ok('whatif 도 하한 달성 가능', bW.floorSyl <= bW.minCards * bW.perCardHi + 12 + 18, `floor=${bW.floorSyl}`);
  // 프롬프트가 허용한 하한을 지킨 대본에 경고가 뜨면 자기모순 → 두 앵글 모두 순서 고정
  for (const [name, b] of [['reveal', bR], ['whatif', bW]]) {
    ok(`${name}: 임계 순서 underSyl<floorSyl<=minSyl<maxSyl`,
      b.underSyl < b.floorSyl && b.floorSyl <= b.minSyl && b.minSyl < b.maxSyl,
      `${b.underSyl}/${b.floorSyl}/${b.minSyl}/${b.maxSyl}`);
    ok(`${name}: 하한 준수 대본엔 경고 없음`,
      checkLength(mkScript(Array(b.minCards).fill(b.perCardHi), { hook: 12, cta: 18 }), b, cfg).under === false);
  }
  has('군더더기 제거 지시', p, '[군더더기 제거');
  has('재진술 금지', p, '같은 내용을 다른 말로 다시 말하지 마라');
  has('도입부 워밍업 금지', p, '워밍업 문장 금지');
  has('완주율 근거 명시', p, '완주율');
  // [형식] 섹션도 같은 수를 본다(프롬프트 내부 모순 방지)
  has('형식 섹션 카드당 음절 일치', p, `구어체(카드당 ${bR.perCardLo}~${bR.perCardHi}음절)`);
  has('형식 섹션 cta 음절 일치', p, `마지막 성우 한 줄(18~26음절)`);
  // 기존 규칙 회귀 없음
  has('기존: TTS 친화 유지', p, '[TTS 친화');
  has('기존: 훅 형태 다양성 유지', p, '[훅 형태');
  has('기존: 출력 스키마 유지', p, '"hook_image_prompt"');
  hasNot('기존 느슨한 cta 범위(20~35) 제거됨', p, '20~35음절');
  hasNot('기존 느슨한 hook 범위(12~28) 제거됨', p, '12~28음절');
}

// ── 4) whatif 는 더 강한 압박 ──
console.log('\n4) 앵글별 차등 (whatif 강화)');
{
  const pw = buildPrompt(WHATIF, cfg);
  const pr = buildPrompt(REVEAL, cfg);
  has('whatif 전용 경고', pw, '전제 설정에 말을 더 쓰다가 매번 길어진다');
  has('whatif 전제 한 문장 지시', pw, '전제는 한 문장으로 끝내고');
  has('whatif 더 짧은 상한 명시', pw, `이 앵글은 상한이 ${bW.targetHi}초로 더 짧다`);
  has('whatif reveal 대비 압축 지시', pw, 'reveal 보다 더 압축');
  hasNot('reveal 에는 whatif 문구 없음', pr, '전제는 한 문장으로 끝내고');
  ok('whatif 프롬프트 음절 상한이 더 작다', pw.includes(`${bW.maxSyl}음절 이내`) && pr.includes(`${bR.maxSyl}음절 이내`));
  // 기존 whatif 분기(사실규칙·흐름) 회귀 없음
  has('whatif 기존 추론 톤 규칙 유지', pw, '근거에 기반한 추론');
}

// ── 5) 예산 검증 — 초과 탐지 / 통과 ──
console.log('\n5) 결정론 예산 검증');
{
  const within = mkScript([44, 44, 44], { hook: 20, cta: 24 });     // 196음절
  const c1 = checkLength(within, bR, cfg);
  ok('예산 내 대본 통과', c1.over === false, JSON.stringify(c1));
  ok('예산 내 대본은 하한 미달도 아님', c1.under === false, JSON.stringify(c1));

  // 하한 경고는 유예선(underSyl) 아래에서만 — 목표선에 붙은 대본까지 경고하면 로그만 시끄럽다.
  ok('유예선이 목표 하한보다 낮다', bR.underSyl < bR.minSyl, `${bR.underSyl} < ${bR.minSyl}`);
  ok('목표선 근처(34.5초)는 하한 경고 없음', checkLength(mkScript([44, 44, 44], { hook: 20, cta: 24 }), bR, cfg).under === false);
  ok('확실히 짧으면(25초급) 하한 경고', checkLength(mkScript([30, 30, 30], { hook: 12, cta: 18 }), bR, cfg).under === true);
  ok('하한 경고는 차단이 아님(over 는 false)', checkLength(mkScript([30, 30, 30], { hook: 12, cta: 18 }), bR, cfg).over === false);

  const over = mkScript([75, 75, 75, 75], { hook: 28, cta: 35 });   // 363음절
  const c2 = checkLength(over, bR, cfg);
  ok('초과 대본 탐지', c2.over === true, JSON.stringify(c2));
  ok('초과량 계산', c2.over_by === 363 - bR.maxSyl, `over_by=${c2.over_by}`);
  ok('초과 대본 예상 길이가 목표 상한 초과', c2.est_sec > bR.targetHi, String(c2.est_sec));

  // 실측 최장 사례(349음절 → 71.2초)가 잡혀야 한다
  const worst = checkLength(mkScript([57, 71, 86, 82], { hook: 25, cta: 28 }), bR, cfg);
  ok('실측 최장 사례(71초급) 탐지', worst.over === true, JSON.stringify(worst));

  // 경계값
  ok('정확히 상한이면 통과', checkLength(mkScript([bR.maxSyl - 40], { hook: 20, cta: 20 }), bR, cfg).over === false);
  ok('상한+1 이면 초과', checkLength(mkScript([bR.maxSyl - 39], { hook: 20, cta: 20 }), bR, cfg).over === true);
  // whatif 는 reveal 이면 통과할 대본을 잡아낸다
  const mid = mkScript([50, 50, 50, 45], { hook: 20, cta: 24 });    // 239음절
  ok('reveal/whatif 경계 차등 동작', checkLength(mid, bR, cfg).over === true || checkLength(mid, bW, cfg).over === true);
  ok('같은 대본이 whatif 에서 더 엄격', (checkLength(mid, bW, cfg).over_by) >= (checkLength(mid, bR, cfg).over_by));
}

// ── 6) 결정론 축약 ──
console.log('\n6) 결정론 축약 (카드 제거 → 문장 제거)');
{
  const over = mkScript([60, 60, 60, 60], { hook: 22, cta: 26 });   // 288음절
  const t = trimToBudget(over, bR, cfg);
  ok('축약으로 예산 충족', t.still_over === false, `after=${totalSyllables(t.script)} max=${bR.maxSyl}`);
  ok('축약 기록 남음', t.actions.length > 0, JSON.stringify(t.actions));
  ok('min_cards 침범 안 함', t.script.cards.length >= bR.minCards, String(t.script.cards.length));
  ok('하한 아래로 깎지 않음', totalSyllables(t.script) >= bR.minSyl, String(totalSyllables(t.script)));
  ok('원본 불변(부작용 없음)', totalSyllables(over) === 288, String(totalSyllables(over)));
  ok('hook·cta 는 보존', t.script.hook === over.hook && t.script.cta === over.cta);
  ok('caption·image_prompt 등 필드 보존', t.script.cards.every(c => c.caption && c.image_prompt));
  ok('축약 후 게이트 하한(15초) 여유', estimateSeconds(totalSyllables(t.script), cfg) > (cfg.gates?.min_sec ?? 15));

  // 예산 내 대본은 손대지 않는다(회귀 없음)
  const fine = mkScript([40, 40, 40], { hook: 18, cta: 22 });
  const t2 = trimToBudget(fine, bR, cfg);
  ok('예산 내 대본은 무변경', totalSyllables(t2.script) === totalSyllables(fine) && t2.actions.length === 0);
  ok('예산 내 대본 카드 수 유지', t2.script.cards.length === 3);

  // 축약 불가 → still_over=true, 그래도 throw 안 함.
  // 진짜 축약 불가 조건: 카드 수가 이미 min_cards + 각 카드가 종결부호 없는 한 문장
  // (문장 경계가 없어 잘라낼 단위가 없다 = LLM 이 마침표 없이 길게 뽑은 경우).
  const t3 = trimToBudget(UNTRIMMABLE, bR, cfg);
  ok('축약 한계 시 still_over 보고', t3.still_over === true, String(totalSyllables(t3.script)));
  ok('축약 한계에도 예외 없음·대본 보존', t3.script.cards.length === 3);
  ok('축약 불가 시 나레이션 무손상', t3.script.cards.every((c, i) => c.narration === UNTRIMMABLE.cards[i].narration));

  // 비정형 입력 안전
  let threw = null;
  try { trimToBudget({}, bR, cfg); trimToBudget({ cards: null }, bR, cfg); } catch (e) { threw = e; }
  ok('비정형 대본 축약도 예외 없음', threw === null, String(threw));
}

// ── 7) 재생성 경로 — 초과 시 힌트를 붙여 다시 생성 ──
console.log('\n7) 재생성 경로');
{
  const overS = mkScript([70, 70, 70, 70], { hook: 25, cta: 30 });
  const goodS = mkScript([44, 44, 44], { hook: 20, cta: 24 });
  const hints = [];
  const cap = capture();
  const r = resolveScriptWithBudget({
    generate: (hint) => { hints.push(hint); return hints.length === 1 ? overS : goodS; },
    budget: bR, cfg, attempts: 3, logger: cap,
  });
  ok('2번째 시도 결과 채택', totalSyllables(r.script) === totalSyllables(goodS), String(totalSyllables(r.script)));
  ok('시도 2회 사용', r.attempts_used === 2, String(r.attempts_used));
  ok('축약 없이 해결', r.trimmed.length === 0 && r.still_over === false);
  ok('1번째 시도엔 힌트 없음', hints[0] === '');
  ok('2번째 시도에 초과 힌트 전달', /예산을 \d+음절 초과했다/.test(hints[1] || ''), hints[1]);
  has('힌트에 목표 음절 명시', hints[1], `총 ${bR.maxSyl}음절`);
  has('초과 경고 로그', cap.lines.join('\n'), '길이 예산 초과(시도 1/3)');
  has('통과 로그', cap.lines.join('\n'), '길이 검증 통과');

  // 힌트가 프롬프트 선두에 실제로 들어간다
  const withHint = buildPrompt(REVEAL, cfg, null, { lengthHint: hints[1] });
  has('힌트가 프롬프트에 주입', withHint, '이번엔 **반드시 총');
  ok('힌트는 프롬프트 앞쪽에 위치', withHint.indexOf('이번엔 **반드시 총') < withHint.length / 2);
  ok('힌트 없으면 프롬프트 불변', buildPrompt(REVEAL, cfg, null, {}) === buildPrompt(REVEAL, cfg));
  ok('빈 힌트도 프롬프트 불변', buildPrompt(REVEAL, cfg, null, { lengthHint: '   ' }) === buildPrompt(REVEAL, cfg));
}

// ── 8) 재생성 소진 → 축약 → 그래도 초과면 경고 후 통과(발행 공백 방지) ──
console.log('\n8) 재생성 소진 후 축약·경고 통과');
{
  // 항상 초과 대본만 오는 경우 → 축약으로 해결
  const overS = mkScript([64, 64, 64, 64], { hook: 22, cta: 26 });
  const cap = capture();
  const r = resolveScriptWithBudget({ generate: () => overS, budget: bR, cfg, attempts: 3, logger: cap });
  ok('3회 모두 초과 → 축약 후 반환', r.attempts_used === 3 && r.trimmed.length > 0, JSON.stringify(r.trimmed));
  ok('축약으로 예산 충족', r.still_over === false && r.check.over === false, JSON.stringify(r.check));
  has('축약 로그', cap.lines.join('\n'), '길이 축약');
  ok('발행 계속(대본 반환)', Array.isArray(r.script.cards) && r.script.cards.length >= bR.minCards);

  // 축약해도 못 맞추는 경우 → 경고 로그 + 통과(예외 없음)
  const cap2 = capture();
  let threw = null, r2;
  try { r2 = resolveScriptWithBudget({ generate: () => UNTRIMMABLE, budget: bR, cfg, attempts: 2, logger: cap2 }); }
  catch (e) { threw = e; }
  ok('축약 한계에도 예외 없이 통과', threw === null && !!r2, String(threw));
  ok('still_over 로 보고', r2?.still_over === true);
  has('초과 잔존 경고 로그', cap2.lines.join('\n'), '길이 예산 초과 잔존');
  has('발행 공백 방지 근거 로그', cap2.lines.join('\n'), '발행 공백 방지');
  ok('대본은 그대로 발행 가능', Array.isArray(r2?.script?.cards) && r2.script.cards.length === 3);
}

// ── 9) 회귀 — 예산 내 대본은 1회 시도로 그대로 통과 ──
console.log('\n9) 회귀 (예산 내 대본 무개입)');
{
  const goodS = mkScript([45, 45, 44], { hook: 20, cta: 24 });
  const cap = capture();
  let calls = 0;
  const r = resolveScriptWithBudget({ generate: () => { calls++; return goodS; }, budget: bR, cfg, attempts: 3, logger: cap });
  ok('1회 호출로 끝', calls === 1 && r.attempts_used === 1);
  ok('대본 그대로(동일 객체)', r.script === goodS);
  ok('축약 없음', r.trimmed.length === 0);
  hasNot('초과 경고 없음', cap.lines.join('\n'), '길이 예산 초과');
}

// ── 10) 생성 실패 처리 — 기존 계약 유지 ──
console.log('\n10) 생성 실패 처리');
{
  const cap = capture();
  let threw = null;
  try { resolveScriptWithBudget({ generate: () => { throw new Error('대본 JSON 파싱 실패'); }, budget: bR, cfg, attempts: 3, logger: cap }); }
  catch (e) { threw = e; }
  ok('전부 실패면 throw(기존 동작)', threw !== null && /파싱 실패/.test(threw.message), String(threw));
  ok('시도별 실패 로그 3회', cap.lines.filter(l => l.includes('대본 생성 시도')).length === 3, cap.lines.join(' | '));

  // 파싱 실패 후 성공하면 채택
  const goodS = mkScript([44, 44, 44]);
  let n = 0;
  const r = resolveScriptWithBudget({
    generate: () => { if (++n === 1) throw new Error('일시 실패'); return goodS; },
    budget: bR, cfg, attempts: 3, logger: capture(),
  });
  ok('일시 실패 후 복구', r.script === goodS && r.attempts_used === 2);

  // 초과 후보만 있고 마지막 시도가 throw → 후보를 축약해 발행(공백 방지)
  const overS = mkScript([70, 70, 70, 70], { hook: 25, cta: 30 });
  let m = 0;
  const cap3 = capture();
  const r3 = resolveScriptWithBudget({
    generate: () => { if (++m === 1) return overS; throw new Error('이후 전부 실패'); },
    budget: bR, cfg, attempts: 3, logger: cap3,
  });
  ok('초과 후보라도 살려서 발행', Array.isArray(r3.script.cards) && r3.script.cards.length >= bR.minCards);
  ok('축약 적용됨', r3.trimmed.length > 0, JSON.stringify(r3.trimmed));
}

// ── 11) lengthPromptBlock 단독 ──
console.log('\n11) lengthPromptBlock');
{
  const blk = lengthPromptBlock(bR);
  has('블록 헤더', blk, '[길이 — 최우선 제약');
  ok('reveal 블록엔 whatif 문구 없음', !blk.includes('전제는 한 문장으로'));
  has('whatif 블록엔 추가 압박', lengthPromptBlock(bW), '전제는 한 문장으로');
}

console.log(`\n호기심 대본 길이 예산: ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
