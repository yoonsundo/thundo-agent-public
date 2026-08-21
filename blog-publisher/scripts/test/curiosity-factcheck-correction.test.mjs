#!/usr/bin/env node
/**
 * curiosity-factcheck-correction.test.mjs — 팩트체크 정정 게이트(US-010) 유닛테스트
 *
 * 회귀 대상(2026-07-30 실사고): badger 가 note 에 "제목의 '13억 원'은 자릿수 오류…반드시
 * 수정할 것"을 명시했는데 verdict=ok 라서 그대로 유튜브에 발행됐다. 검증:
 *   (a) ok + 정정본 → 대본·업로드 제목에 정정본 반영(틀린 숫자가 최종 제목에 없다)
 *   (b) ok + 정정 요구인데 정정본 없음/적용불가 → 보류(발행 안 함)
 *   (c) 실제 사고 note 전문 → 발행되지 않는다(회귀 테스트)
 *   (d) 구형 ok 응답 + 정정 신호 없는 note → 기존대로 통과(회귀 없음)
 *   (e) 구형 ok 응답 + note 에 "반드시 수정" → 보류
 *   (f) 보류가 생겨도 3편이 채워진다
 * 실제 판정부(resolveFactcheck)·정정부(applyCorrection)·메타부(buildUploadMeta)를 그대로
 * 호출한다 — 로직 복사 없음. claude·네트워크·크리덴셜 불필요. exit 0 = 통과 / 1 = 실패.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';

const { normalizeFactcheck, applyCorrection, noteDemandsCorrection, noteFlagsSubject } =
  await import('../shorts-curiosity/factcheck.mjs');
const { resolveFactcheck, buildUploadMeta, shortenTitleBody, recheckCorrectedSubject } =
  await import('../shorts-curiosity/run-curiosity.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/** 실제 발행된 아이템(2026-07-30 10시 슬롯). */
const SIOUX = {
  id: 'sioux', angle: 'reveal', domain: '역사',
  subject: '13억 원 배상금을 40년째 거부하고 있는 부족',
  common_belief: '거액의 배상금이 나오면 당연히 받는다',
  reveal: '수족은 1980년 대법원 배상 확정액을 40년 넘게 거부했고 신탁계좌는 이자로 계속 불어났다',
  source_hint: 'United States v. Sioux Nation of Indians, 448 U.S. 371 (1980)',
};
/** 실제 badger note 전문(로그 원문). */
const REAL_NOTE = "핵심(1980 대법원 United States v. Sioux Nation of Indians 배상 확정 → 수족이 '수령=블랙힐스 소유권 포기'라며 40년 넘게 거부 → 신탁계좌가 이자로 10억 달러대까지 불어남)은 널리 확립된 사실이나 금액 표기는 교정 필요: 1980년 확정액은 원금 1,710만 달러+1877년부터의 이자로 약 1억 600만 달러(1억 2,200만 달러 아님)이며, 2011년 시점 10억 달러 초과·현재 20억 달러 안팎으로 보도됨. 제목의 '13억 원'은 자릿수 오류(약 1조 원 이상이 맞음)이니 대본에서 반드시 수정할 것.";
const script = { hook: '거액의 배상금을 40년 넘게 거부한 부족이 있습니다.' };

// ── (a) 정정본이 대본·제목까지 반영 ──────────────────────────────────────────
console.log('\n[a] ok + 정정본 → 정정 반영 발행');
const corrected = normalizeFactcheck({
  verdict: 'ok', note: REAL_NOTE, source: '448 U.S. 371 (1980)',
  needs_correction: true,
  corrected_subject: '1조 원대 배상금을 40년째 거부하고 있는 부족',
  corrected_reveal: '수족은 1980년 대법원이 확정한 약 1억 600만 달러 배상을 거부했고, 신탁계좌는 이자로 20억 달러 안팎까지 불어났다',
});
eq('needs_correction 파싱', corrected.needs_correction, true);
const decA = resolveFactcheck(SIOUX, corrected);
eq('발행 진행', decA.action, 'publish');
eq('정정 플래그', decA.corrected, true);
eq('subject 가 정정본으로 대체', decA.item.subject, '1조 원대 배상금을 40년째 거부하고 있는 부족');
eq('reveal 도 정정본으로 대체', decA.item.reveal, corrected.corrected_reveal);
ok('원문 보존(추적용)', decA.item.original_subject === SIOUX.subject, JSON.stringify(decA.item.original_subject));
ok('원본 아이템 불변(부작용 없음)', SIOUX.subject === '13억 원 배상금을 40년째 거부하고 있는 부족');

// 이 item 이 그대로 generateScript·buildUploadMeta 로 넘어간다 → 최종 제목 검증.
const metaA = buildUploadMeta(decA.item, script);
ok("최종 제목에 틀린 '13억' 없음", !metaA.title.includes('13억'), metaA.title);
ok("최종 제목에 정정값 '1조' 포함", metaA.title.includes('1조'), metaA.title);
ok('제목 40자 컷과 함께 동작', metaA.title.replace(/\s*#shorts$/, '').length <= 40, metaA.title);
ok('설명에도 정정된 reveal 반영', metaA.description.includes('1억 600만 달러'), metaA.description.slice(0, 120));
ok("설명에 틀린 표기 없음", !metaA.description.includes('13억 원'), metaA.description.slice(0, 200));
console.log(`        → ${metaA.title}`);
eq('정정 후 제목 정규화 결과', shortenTitleBody(decA.item.subject), '1조 원대 배상금을 40년째 거부하고 있는 부족');

// ── (b) 정정 요구인데 정정본이 없거나 못 쓰는 경우 → 보류 ────────────────────
console.log('\n[b] ok + 정정 불가 → 보류');
const noSentence = normalizeFactcheck({ verdict: 'ok', note: '금액 표기 교정 필요', needs_correction: true });
const decB1 = resolveFactcheck(SIOUX, noSentence);
eq('정정본 없음 → 보류', decB1.action, 'hold');
eq('보류 사유', decB1.reason, 'factcheck:correction-unapplicable');
ok('사유가 factcheck: 접두(재선정 제외 로직과 호환)', decB1.reason.startsWith('factcheck:'), decB1.reason);
ok('보류 note 에 원본 판정 보존', decB1.note.includes('금액 표기 교정 필요'), decB1.note);

const instructionOnly = normalizeFactcheck({
  verdict: 'ok', note: '수치 정정 필요', needs_correction: true,
  corrected_subject: '수정할 것', corrected_reveal: '교정 필요',
});
eq('지시문이 정정문장 자리에 오면 보류', resolveFactcheck(SIOUX, instructionOnly).action, 'hold');

const identical = normalizeFactcheck({
  verdict: 'ok', note: '수치 정정 필요', needs_correction: true,
  corrected_subject: SIOUX.subject, corrected_reveal: SIOUX.reveal,
});
eq('정정본이 원문과 동일 → 보류', resolveFactcheck(SIOUX, identical).action, 'hold');
eq('동일 사유 기록', applyCorrection(SIOUX, identical).reason, 'correction_identical');

// note 가 제목 오류를 지목했는데 reveal 만 고친 경우 → 정작 틀린 곳이 안 고쳐졌으니 보류.
const revealOnly = normalizeFactcheck({
  verdict: 'ok', note: REAL_NOTE, needs_correction: true,
  corrected_subject: SIOUX.subject,
  corrected_reveal: '수족은 약 1억 600만 달러 배상을 거부했다',
});
eq('제목 오류 지목인데 주제 미정정 → 보류', resolveFactcheck(SIOUX, revealOnly).action, 'hold');
eq('사유가 subject 미정정', applyCorrection(SIOUX, revealOnly).reason, 'subject_not_corrected');
ok('note 가 제목을 지목했음을 판별', noteFlagsSubject(REAL_NOTE));

// ── (c) 실제 사고 재현 — 구조화 필드 없는 그날의 응답 그대로 ─────────────────
console.log('\n[c] 실사고 회귀 — 그날의 응답 그대로 넣으면 발행되지 않는다');
const asItHappened = normalizeFactcheck({
  verdict: 'ok', note: REAL_NOTE,
  source: 'United States v. Sioux Nation of Indians, 448 U.S. 371 (1980); BIA 신탁계좌 잔액 관련 NPR·PBS 보도(2011년 10억 달러 돌파)',
});
eq('구형 응답에서 정정 요구 감지', asItHappened.needs_correction, true);
eq('감지 경로 표기(구형 추론)', asItHappened.correction_inferred, true);
const decC = resolveFactcheck(SIOUX, asItHappened);
eq('그날의 판정으로는 발행 불가(보류)', decC.action, 'hold');
eq('보류 사유', decC.reason, 'factcheck:correction-unapplicable');
ok("'13억 원' 이 유튜브로 나가지 않음", decC.action !== 'publish');

// ── (d) 정상 ok — 회귀 없음 ─────────────────────────────────────────────────
console.log('\n[d] 정상 ok 는 그대로 통과(회귀 없음)');
const clean = normalizeFactcheck({
  verdict: 'ok', note: '남아공 크루거 국립공원 음향 실험으로 확립된 사실', source: 'Current Biology (2023)',
});
eq('정정 필요 없음', clean.needs_correction, false);
const decD = resolveFactcheck(SIOUX, clean);
eq('발행 진행', decD.action, 'publish');
eq('정정 없음', decD.corrected, false);
ok('아이템 그대로 전달', decD.item === SIOUX);
eq('구형 응답 3필드만 있어도 안전', normalizeFactcheck({ verdict: 'ok', note: '', source: '' }).needs_correction, false);
eq('빈 객체도 안전(doubtful 기본)', normalizeFactcheck({}).verdict, 'doubtful');
eq('needs_correction=false 명시도 존중', normalizeFactcheck({ verdict: 'ok', note: '확립된 사실', needs_correction: false }).needs_correction, false);
// 오탐 가드 — 정정 요구가 아닌 표현은 신호로 잡지 않는다.
for (const benign of ['널리 확립된 사실', '도시전설이 아니라 실제 기록으로 확인된다', '출처가 명확하다', '2023년 연구로 재확인됨']) {
  ok(`오탐 없음: "${benign}"`, !noteDemandsCorrection(benign));
}
// 정탐 — 정정 요구 신호는 확실히 잡는다.
for (const bad of ['반드시 수정할 것', '자릿수 오류', '금액 표기는 교정 필요', '사실과 다르다', '1억 2,200만 달러 아님']) {
  ok(`정정 신호 감지: "${bad}"`, noteDemandsCorrection(bad));
}

// ── (e) 구형 ok + "반드시 수정" → 보류 ──────────────────────────────────────
console.log('\n[e] 구형 ok + 정정 신호 → 보류');
const legacyDemand = normalizeFactcheck({ verdict: 'ok', note: '핵심은 맞으나 연도를 반드시 수정할 것' });
eq('보류', resolveFactcheck(SIOUX, legacyDemand).action, 'hold');
// 모델이 필드는 false 로 두고 note 에만 정정을 요구하는 실제 패턴도 막는다.
const contradictory = normalizeFactcheck({ verdict: 'ok', note: '자릿수 오류가 있다', needs_correction: false });
eq('필드 false + note 정정요구 → 정정 필요로 승격', contradictory.needs_correction, true);
eq('그리고 보류', resolveFactcheck(SIOUX, contradictory).action, 'hold');
// verdict 자체가 나쁜 경우는 기존 사유 유지(회귀 없음).
eq('doubtful 은 기존 사유 유지', resolveFactcheck(SIOUX, normalizeFactcheck({ verdict: 'doubtful', note: 'x' })).reason, 'factcheck:doubtful');
eq('false 도 기존 사유 유지', resolveFactcheck(SIOUX, normalizeFactcheck({ verdict: 'false', note: 'x' })).reason, 'factcheck:false');

// ── (f) 보류가 생겨도 하루 3편은 채워진다 ───────────────────────────────────
console.log('\n[f] 보류 발생에도 3편 충족');
// runDaily 의 후보 루프(최대 3회 재선정)와 같은 구조로, 실제 판정부를 그대로 써서 시뮬레이션.
const candidates = [
  { item: { ...SIOUX, id: 'c1' }, fc: asItHappened },                                     // 정정 불가 → 보류
  { item: { ...SIOUX, id: 'c2' }, fc: legacyDemand },                                     // 구형 정정요구 → 보류
  { item: { id: 'c3', angle: 'reveal', domain: '동물', subject: '호랑이는 주황색이 아니다', reveal: '사슴 눈에는 녹색으로 보인다' }, fc: clean },
  { item: { ...SIOUX, id: 'c4' }, fc: corrected },                                        // 정정 반영 발행
  { item: { id: 'c5', angle: 'reveal', domain: '음식', subject: '와사비의 99%는 와사비가 아니다', reveal: '대부분 서양고추냉이+색소다' }, fc: clean },
];
/** 슬롯 1개: 후보를 순서대로 최대 3회 팩트체크 → 첫 publish 를 발행. */
function runSlot(queue, held) {
  for (let attempt = 0; attempt < 3 && queue.length; attempt++) {
    const c = queue.shift();
    const dec = resolveFactcheck(c.item, c.fc);
    if (dec.action === 'publish') return { published: dec.item, corrected: dec.corrected };
    held.push({ id: c.item.id, reason: dec.reason });
  }
  return { published: null };
}
const queue = [...candidates];
const held = [];
const slots = [runSlot(queue, held), runSlot(queue, held), runSlot(queue, held)];
eq('보류 2건 발생', held.length, 2);
ok('보류 사유 전부 factcheck: 접두', held.every(h => h.reason.startsWith('factcheck:')), JSON.stringify(held));
eq('그래도 3슬롯 모두 발행', slots.filter(s => s.published).length, 3);
ok('발행분에 정정 불가 아이템 없음', !slots.some(s => s.published?.id === 'c1' || s.published?.id === 'c2'),
  JSON.stringify(slots.map(s => s.published?.id)));
ok('정정된 아이템은 정정본으로 발행', slots.some(s => s.corrected && s.published.subject.includes('1조')),
  JSON.stringify(slots.map(s => s.published?.subject)));
ok('발행 제목 전부 40자 이내', slots.every(s => buildUploadMeta(s.published, script).title.replace(/\s*#shorts$/, '').length <= 40));
// 후보가 전부 보류면 발행 0 → 상위(재고 폴백·상한 완화)가 슬롯을 채우는 기존 경로로 넘어간다.
const allHeld = runSlot([{ item: SIOUX, fc: asItHappened }], []);
eq('후보 전멸 시엔 publish 없음(상위 폴백으로)', allHeld.published, null);


// ─────────────────────────────────────────────────────────────────────────────
// (g) 정정 **뒤에** 다시 중복 검사한다 (2026-08-21 신설)
//
// 실사고: 유사도 게이트는 pick 단계에서 **정정 전** 문구로 판정하는데, 팩트체크가 그 뒤에
// subject 를 고쳐 쓴다. 정정은 사실을 바로잡는 일이라 서로 다르게 적혀 있던 두 후보를 같은
// 사실로 수렴시킬 수 있다. 실제로 그렇게 5일 간격 재발행이 나갔다:
//   백로그 "총알에 팔…스프링 손…30년"  → 정정 → 발행 "포탄에 오른팔…철제 의수…40년"
//   (이미 발행돼 있던 "대포알에 오른손…철제 의수…40년" 과 사실상 동일)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n(g) 정정 후 중복 재검사');
{
  const SIM = { enabled: true, bigram_jaccard: 0.45, topic_jaccard: 0.14, substring: true, min_chars: 6 };
  const cfgSim = { pick: { similarity: SIM } };
  const priorSubject = '대포알에 오른손을 잃고 철제 의수로 40년을 더 싸운 기사';
  const index = { old1: { status: 'uploaded', subject: priorSubject } };

  const corrected = { id: 'new', subject: '포탄에 오른팔을 잃고 철제 의수로 40년 더 싸운 기사' };
  const hit = recheckCorrectedSubject(corrected, { cfg: cfgSim, corrected: true, index, backlog: [] });
  ok('정정본이 기존 발행과 같은 소재면 잡아낸다', hit.dup, JSON.stringify(hit));
  eq('무엇과 겹쳤는지 알려준다', hit.against, priorSubject);

  // 정정이 없었으면 이미 pick 단계에서 같은 문구로 검사됐다 → 중복 재검사 안 함.
  const skipped = recheckCorrectedSubject(corrected, { cfg: cfgSim, corrected: false, index, backlog: [] });
  ok('정정이 없으면 재검사하지 않는다', !skipped.dup);

  // 정정본이 새로운 소재면 통과해야 한다(정정 자체를 벌하면 안 된다).
  const fresh = recheckCorrectedSubject({ id: 'n2', subject: '트로이 목마는 일리아스에 없다' },
    { cfg: cfgSim, corrected: true, index, backlog: [] });
  ok('정정본이 새 소재면 통과', !fresh.dup);

  // 유사도 자체를 끈 설정이면 재검사도 하지 않는다(설정 존중).
  const off = recheckCorrectedSubject(corrected,
    { cfg: { pick: { similarity: { enabled: false } } }, corrected: true, index, backlog: [] });
  ok('similarity.enabled=false 면 재검사 안 함', !off.dup);

  // 인덱스가 망가져 있어도 크래시하지 않고, 근거 없이 막지도 않는다(비차단 계약).
  // ⚠ index: null 을 넘기면 `??` 폴백으로 **실제 state 를 읽는다** — 그건 검증이 아니라 사고다.
  //    비교 대상이 없다는 상황을 만들려면 '값이 망가진 인덱스'를 명시적으로 넘겨야 한다.
  const broken = recheckCorrectedSubject(corrected,
    { cfg: cfgSim, corrected: true, index: { a: null, b: { status: 'uploaded' } }, backlog: [] });
  eq('망가진 인덱스에서는 차단하지 않는다', broken.dup, false);
}

console.log(`\n팩트체크 정정 게이트(US-010): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
