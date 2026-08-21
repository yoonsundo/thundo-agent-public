#!/usr/bin/env node
/**
 * cardnews-factcheck.test.mjs — 인용 실재 검증 유닛테스트 (계획 §3.5 · Step 5)
 *
 * 증명하는 것:
 *   ① 🔴 **1차 판정은 LLM 이 아니라 기계 대조다.** 원문에 없는 구절은 `false` 이고,
 *      그때 claude 는 **호출조차 되지 않는다**(토큰도 안 쓴다)
 *   ② 🔴 강한 정규화가 실재 구절을 놓치지 않는다 — 원문은 줄바꿈으로 감겨 있고 따옴표·
 *      엠대시가 섞여 있다. 단순 grep 은 실재 구절을 놓친다(실측된 false negative)
 *   ③ 원문을 **못 받은 것**과 구절이 **없는 것**은 다른 사유다(네트워크 사고를 날조로
 *      기록하지 않는다) — 전자는 doubtful, 후자는 false
 *   ④ 2차 LLM 프롬프트가 **hedgehog BRIEF 로 시작**하고 원문 문맥을 싣는다
 *   ⑤ 차단권만 — 미지의 verdict·필드 결손은 전부 `doubtful`(통과가 기본값이 아니다)
 *   ⑥ US-010 이식 — note 가 "반드시 수정"을 요구하면 needs_correction 을 끌어올려 보류시킨다
 *   ⑦ 🔴 정정은 **출처 라벨(제목·저자)뿐** — 구절·번역 문제는 정정이 아니라 차단이다
 *   ⑧ hold 사유가 `classifyHeld` 에서 `permanent` 로 분류된다(1-A 면제 `external` 이 아니다)
 *
 * 🔴 실 `claude -p` 미사용 · **네트워크 0** — 원문은 `deps.fetchText` 주입과 캐시 프리시드로만.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-factcheck-'));
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';

const lib = await import('../cardnews/lib.mjs');
const fcm = await import('../cardnews/factcheck.mjs');
const gq = await import('../cardnews/gate-quote.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const CFG = lib.loadConfig();
const GUARD = '인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만';
const URL = 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt';

/**
 * 가짜 원문 — **실제 구텐베르크 파일의 성질을 그대로 흉내 낸다**: 구절이 줄바꿈으로 감겨 있고,
 * 곡선 따옴표·느낌표가 섞여 있다. 단순 `includes` 로는 실재 구절도 못 찾는 바로 그 형태다.
 */
const FULLTEXT = `The Project Gutenberg eBook of Pride and Prejudice, by Jane Austen

Chapter I.

It is a truth universally acknowledged, that a single man in possession
of a good fortune, must be in want of a wife.

${'Filler line for length. '.repeat(60)}

“I declare after all there is
no enjoyment like reading! How much sooner one tires of any thing
than of a book!—When I have a house of my own, I shall be miserable
if I have not an excellent library.”

${'More filler to pass the minimum size guard. '.repeat(60)}

Vanity and pride are different things, though the words are often
used synonymously.
`;

const ITEM = (over = {}) => ({
  id: 'a1b2c3d4e5',
  problem: '혼자 있고 싶은 게 도망 같을 때',
  situation: '약속을 미루고 방에 있는 밤',
  quote_original: 'I declare after all there is no enjoyment like reading',
  quote_ko: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
  source: {
    title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813, fulltext_url: URL,
  },
  form: 'novel',
  interpretation: '그 시간은 도피가 아니라 회복이었다는 것을, 오스틴은 농담처럼 흘려 말한다. 우리가 자기에게 돌려주는 유일한 몫이다.',
  shift: '자책하던 자리에서 한 걸음 옆으로',
  audience: '요즘 지쳐 보이는 사람에게',
  public_domain: true,
  ...over,
});

/** 네트워크 대신 쓰는 주입 스텁 — 호출 횟수를 세서 캐시 동작까지 관측한다. */
const fetcher = (text = FULLTEXT) => {
  const calls = [];
  return { calls, fetchText: (u) => { calls.push(u); return text; } };
};

// ─────────────────────────────────────────────────────────────────────────────
section('① 🔴 기계 대조 — 강한 정규화가 줄바꿈에 감긴 실재 구절을 찾는다');

eq('strongNormalize: 구두점·대소문자·줄바꿈을 지운다',
  fcm.strongNormalize('“I declare—after all,\nthere is no enjoyment like READING!”'),
  'i declare after all there is no enjoyment like reading');
ok('🔴 단순 includes 는 실재 구절을 놓친다(이 테스트의 존재 이유)',
  !FULLTEXT.includes('I declare after all there is no enjoyment like reading'));
ok('🔴 강한 정규화 후에는 찾는다',
  fcm.strongNormalize(FULLTEXT).includes(fcm.strongNormalize('I declare after all there is no enjoyment like reading')));

const f1 = fetcher();
const v1 = fcm.verifyQuote(ITEM(), { cfg: CFG, deps: { fetchText: f1.fetchText } });
eq('실재 구절 → found', v1.found, true);
eq('사유', v1.reason, 'quote-found');
ok('원문에서 앞뒤 문맥을 떠 온다(2차 LLM 의 맥락 판정 재료)',
  v1.context.includes('enjoyment like reading') && v1.context.length > 100, `len=${v1.context?.length}`);
ok('문맥이 원문 앞부분도 포함한다(offset 매핑이 맞다)', v1.context.includes('Filler line') || v1.context.includes('sooner one tires'));
eq('원문을 1회 받았다', f1.calls.length, 1);

// 캐시 — 두 번째 호출은 네트워크를 타지 않는다(원문은 불변이라 만료가 없다).
const v1b = fcm.verifyQuote(ITEM(), { cfg: CFG, deps: { fetchText: () => { throw new Error('두 번째 호출은 캐시여야 한다'); } } });
eq('🔴 두 번째 대조는 캐시에서 온다', v1b.found, true);
// 🔴 캐시는 인용 게이트(`gate-quote.mjs:fulltextCachePath`)와 **같은 파일**이다 — 두 곳이 따로
//    받으면 한 편당 수백 KB 를 두 번 내려받고, "게이트는 찾았는데 팩트체크는 못 찾는" 갈림이 생긴다.
ok('캐시 파일이 인용 게이트와 같은 경로에 있다',
  existsSync(fcm.corpusPath(URL)) && fcm.corpusPath(URL) === gq.fulltextCachePath({ fulltext_url: URL }),
  fcm.corpusPath(URL));

// 🔴 가짜 인용 — 명언 사이트에서 재생산되는 형태.
const fake = fcm.verifyQuote(ITEM({ quote_original: 'Do not give up. The beginning is always the hardest' }),
  { cfg: CFG, deps: { fetchText: f1.fetchText } });
eq('🔴 원문에 없는 구절은 not found', fake.found, false);
eq('사유가 quote-not-found', fake.reason, 'quote-not-found');
const fake2 = fcm.verifyQuote(ITEM({ quote_original: 'A lady must have a strong opinion of her own worth' }),
  { cfg: CFG, deps: { fetchText: f1.fetchText } });
eq('그럴듯한 위작도 not found', fake2.found, false);

// 의역·요약도 걸린다 — 이게 이 설계의 핵심이다(모델이 "대충 이런 뜻"으로 넘기지 못한다).
eq('🔴 의역은 통과하지 못한다',
  fcm.verifyQuote(ITEM({ quote_original: 'I say that nothing is as enjoyable as reading books' }),
    { cfg: CFG, deps: { fetchText: f1.fetchText } }).found, false);

// 스키마 결손·화이트리스트.
const badVerify = (over) => fcm.verifyQuote(ITEM(over), { cfg: CFG, deps: { fetchText: f1.fetchText } }).reason;
eq('원문 구절이 비면 quote-missing', badVerify({ quote_original: '' }), 'quote-missing');
eq('원문 주소가 없으면 fulltext-url-missing',
  badVerify({ source: { ...ITEM().source, fulltext_url: '' } }), 'fulltext-url-missing');
eq('🔴 화이트리스트 밖 주소는 대조하지 않는다',
  badVerify({ source: { ...ITEM().source, fulltext_url: 'https://quotes.example.com/a.txt' } }), 'fulltext-url-not-allowed');
eq('🔴 너무 짧은 조각은 대조하지 않는다(우연 일치 방지)',
  badVerify({ quote_original: 'no enjoyment' }), 'quote-too-short');

// 원문을 못 받은 것 ≠ 구절이 없는 것.
const dead = fcm.verifyQuote(ITEM({ source: { ...ITEM().source, fulltext_url: `${URL}?v=2` } }),
  { cfg: CFG, deps: { fetchText: () => { throw new Error('ENOTFOUND'); } } });
eq('🔴 원문을 못 받으면 corpus-unavailable', dead.reason, 'corpus-unavailable');
ok('그 사유에 원인이 남는다', String(dead.error).includes('ENOTFOUND'));
eq('🔴 원문이 비어 있어도(짧아도) 날조 판정이 아니다',
  fcm.verifyQuote(ITEM({ source: { ...ITEM().source, fulltext_url: `${URL}?v=3` } }),
    { cfg: CFG, deps: { fetchText: () => 'too short' } }).reason, 'corpus-unavailable');

// ─────────────────────────────────────────────────────────────────────────────
section('② 🔴 factCheck — 기계가 막으면 claude 는 호출되지 않는다');

let claudeCalls = 0;
let seenPrompt = null;
const llmStub = (p) => {
  claudeCalls++;
  seenPrompt = p;
  return JSON.stringify({ verdict: 'ok', note: '문맥과 뜻이 일치한다', source: URL, needs_correction: false });
};

claudeCalls = 0;
const notFound = fcm.factCheck(ITEM({ quote_original: 'Do not give up. The beginning is always the hardest' }),
  { cfg: CFG, deps: { callClaude: llmStub, fetchText: f1.fetchText } });
eq('🔴 원문에 없으면 verdict=false', notFound.verdict, 'false');
eq('🔴 그때 claude 는 호출되지 않는다(토큰 0)', claudeCalls, 0);
eq('기계 사유가 남는다', notFound.machine_reason, 'quote-not-found');
eq('기계 판정이 verified=false', notFound.machine.verified, false);
eq('🔴 그 판정은 hold 로 이어진다', fcm.resolveFactcheck(ITEM(), notFound).action, 'hold');
eq('🔴 hold 사유에 기계 사유가 실린다(날조 vs 네트워크 구분)',
  fcm.resolveFactcheck(ITEM(), notFound).reason, 'factcheck:quote-not-found');

claudeCalls = 0;
const unavailable = fcm.factCheck(ITEM({ source: { ...ITEM().source, fulltext_url: `${URL}?v=9` } }),
  { cfg: CFG, deps: { callClaude: llmStub, fetchText: () => { throw new Error('ECONNRESET'); } } });
eq('🔴 원문을 못 받으면 doubtful(날조가 아니다)', unavailable.verdict, 'doubtful');
eq('그때도 claude 는 호출되지 않는다', claudeCalls, 0);
eq('hold 사유가 corpus-unavailable', fcm.resolveFactcheck(ITEM(), unavailable).reason, 'factcheck:corpus-unavailable');

claudeCalls = 0;
const found = fcm.factCheck(ITEM(), { cfg: CFG, deps: { callClaude: llmStub, fetchText: f1.fetchText } });
eq('🔴 대조에 성공하면 그때만 claude 를 부른다', claudeCalls, 1);
eq('verdict=ok', found.verdict, 'ok');
eq('기계 판정이 verified=true', found.machine.verified, true);
eq('🔴 근거(source)가 원문 주소로 남는다(테이크다운 런북 입력)', found.source, URL);
eq('produce 로 이어진다', fcm.resolveFactcheck(ITEM(), found).action, 'produce');

// ─────────────────────────────────────────────────────────────────────────────
section('③ 2차 LLM 프롬프트 — BRIEF 선두 + 문맥 + 비대칭');

const brief = lib.loadAgentBrief('hedgehog');
ok('hedgehog BRIEF 가 비어있지 않다', brief.length > 100, `len=${brief.length}`);
const prompt = fcm.buildPrompt(ITEM(), v1);
ok('프롬프트가 hedgehog BRIEF 로 시작한다', prompt.startsWith(brief), `head='${prompt.slice(0, 40)}…'`);
ok('스텁이 받은 프롬프트도 BRIEF 로 시작한다', seenPrompt.startsWith(brief));
ok('프롬프트에 가드레일 문구가 실린다', prompt.includes(GUARD));
ok('🔴 실재 판정을 다시 하지 말라고 못박는다', prompt.includes('실재 여부는 다시 판정하지 말고'));
ok('🔴 원문 문맥이 실린다(맥락 왜곡 판정 재료)', prompt.includes('enjoyment like reading'));
ok('세 확인 항목(맥락·라벨·번역)이 명시된다',
  prompt.includes('맥락 왜곡') && prompt.includes('출처 라벨') && prompt.includes('번역 충실도'));
ok('🔴 오귀속을 특히 경계하라고 지시한다', prompt.includes('오귀속'));
ok('🔴 비대칭이 명시된다(거르는 비용 << 왜곡 비용)',
  prompt.includes('확신이 없으면 doubtful') && prompt.includes('삭제 API 가 없다'));
ok('정정 규칙이 구조화 필드를 요구한다', prompt.includes('corrected_title') && prompt.includes('corrected_author'));
ok('🔴 구절·번역은 정정 대상이 아님을 명시한다', prompt.includes('구절과 번역은 정정 대상이 아니다'));
ok('문맥이 없으면 보수적으로 판정하라고 알린다',
  fcm.buildPrompt(ITEM(), {}).includes('문맥을 뜨지 못했다'));

// ─────────────────────────────────────────────────────────────────────────────
section('④ 차단권만 — 통과가 기본값이 아니다');

eq('미지의 verdict → doubtful', fcm.normalizeFactcheck({ verdict: 'probably' }).verdict, 'doubtful');
eq('verdict 결손 → doubtful', fcm.normalizeFactcheck({}).verdict, 'doubtful');
eq('null 입력 → doubtful', fcm.normalizeFactcheck(null).verdict, 'doubtful');
eq('true 는 ok 가 아니다', fcm.normalizeFactcheck({ verdict: true }).verdict, 'doubtful');
eq('명시적 ok 만 ok', fcm.normalizeFactcheck({ verdict: 'ok' }).verdict, 'ok');
eq('false 는 그대로 false', fcm.normalizeFactcheck({ verdict: 'false' }).verdict, 'false');

for (const v of ['doubtful', 'false']) {
  const res = fcm.resolveFactcheck(ITEM(), fcm.normalizeFactcheck({ verdict: v }));
  eq(`verdict=${v} → hold`, res.action, 'hold');
  eq(`verdict=${v} 사유 접두`, res.reason, `factcheck:${v}`);
}

// fail-closed — 검증을 끄는 것이 무검증 통과가 되면 안 된다.
claudeCalls = 0;
const disabled = fcm.factCheck(ITEM(), {
  cfg: { ...CFG, factcheck: { enabled: false } }, deps: { callClaude: llmStub, fetchText: f1.fetchText },
});
eq('🔴 factcheck.enabled=false 는 무검증 통과가 아니라 doubtful', disabled.verdict, 'doubtful');
eq('그 판정은 hold 로 이어진다', fcm.resolveFactcheck(ITEM(), disabled).action, 'hold');
eq('그때도 claude 는 호출되지 않는다', claudeCalls, 0);

let threw = null;
try {
  fcm.factCheck(ITEM(), { cfg: CFG, deps: { callClaude: () => { throw new Error('claude 실행 실패(network)'); }, fetchText: f1.fetchText } });
} catch (e) { threw = e; }
ok('🔴 2차 호출 실패는 throw 한다(안 돌았는데 통과시키지 않는다)', threw !== null, threw?.message);

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ US-010 — note 가 정정을 요구하면 끌어올린다');

const sneaky = fcm.normalizeFactcheck({
  verdict: 'ok', needs_correction: false,
  note: '저자가 다르다. 반드시 수정할 것.',
});
eq('verdict 는 ok 그대로', sneaky.verdict, 'ok');
eq('🔴 모델이 needs_correction=false 로 둬도 note 가 그것을 덮어쓴다', sneaky.needs_correction, true);
eq('구조화 필드가 있었으므로 correction_inferred 는 false', sneaky.correction_inferred, false);
eq('정정 문장이 없으므로 resolve 는 hold', fcm.resolveFactcheck(ITEM(), sneaky).action, 'hold');
eq('사유는 correction-unapplicable', fcm.resolveFactcheck(ITEM(), sneaky).reason, 'factcheck:correction-unapplicable');

const legacy = fcm.normalizeFactcheck({ verdict: 'ok', note: '제목이 틀렸으니 반드시 수정할 것.' });
eq('구조화 필드가 없던 응답도 끌어올려진다', legacy.needs_correction, true);
eq('그 경우 추론이었음을 표시한다', legacy.correction_inferred, true);
eq('구형 응답도 hold 로 떨어진다', fcm.resolveFactcheck(ITEM(), legacy).action, 'hold');

ok('신호어 탐지 — "반드시 수정"', fcm.noteDemandsCorrection('반드시 수정 바람'));
ok('신호어 탐지 — 오귀속', fcm.noteDemandsCorrection('널리 알려진 오귀속이다'));
ok('신호어 탐지 — 저자 불일치', fcm.noteDemandsCorrection('저자가 아니다'));
ok('무해한 note 는 신호 아님', fcm.noteDemandsCorrection('문맥과 뜻이 일치하며 번역도 충실하다') === false);

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ 🔴 정정은 출처 라벨뿐 — 구절·번역 문제는 정정이 아니라 차단이다');

const noNeed = fcm.applyCorrection(ITEM(), { needs_correction: false });
ok('정정 불필요 → 적용됨·무변경', noNeed.applied && !noNeed.changed);

const good = fcm.applyCorrection(ITEM(), {
  needs_correction: true, note: '작품 라벨이 어긋난다',
  corrected_title: '이성과 감성', corrected_author: '제인 오스틴 (Jane Austen)',
});
ok('정상 라벨 정정 → 적용됨·변경됨', good.applied && good.changed);
eq('정정본이 source.title 을 대체한다', good.item.source.title, '이성과 감성');
eq('정정본이 source.author 를 대체한다', good.item.source.author, '제인 오스틴 (Jane Austen)');
eq('원문 출처가 보존된다', good.item.original_source.title, '오만과 편견');
eq('정정 표시가 붙는다', good.item.factcheck_corrected, true);
eq('🔴 인용 자체는 손대지 않는다', good.item.quote_ko, ITEM().quote_ko);

const missing = fcm.applyCorrection(ITEM(), { needs_correction: true, corrected_title: '', corrected_author: '' });
ok('정정 값이 없으면 적용 불가', !missing.applied);
eq('사유 correction_missing', missing.reason, 'correction_missing');
ok('지시문이 값 자리에 오면 적용 불가',
  !fcm.applyCorrection(ITEM(), { needs_correction: true, corrected_title: '수정 필요', corrected_author: '수정 필요' }).applied);

const identical = fcm.applyCorrection(ITEM(), {
  needs_correction: true, corrected_title: '오만과 편견', corrected_author: '제인 오스틴',
});
ok('원문과 동일한 "정정"은 적용 불가', !identical.applied);
eq('사유 correction_identical', identical.reason, 'correction_identical');

// 🔴 여기가 이 버티컬의 핵심 규칙이다 — 왜곡된 인용을 라벨만 바꿔 내보내지 않는다.
for (const note of ['구절이 반어로 쓰였다', '번역이 원문보다 넓다', '맥락이 반대다', '인용이 원문과 다르다']) {
  const r = fcm.applyCorrection(ITEM(), {
    needs_correction: true, note, corrected_title: '다른 제목', corrected_author: '다른 저자',
  });
  ok(`🔴 "${note}" → 라벨 정정으로 덮지 않는다`, !r.applied && r.reason === 'quote_not_correctable', r.reason);
}
ok('noteFlagsQuote 는 라벨 지적에는 걸리지 않는다', !fcm.noteFlagsQuote('저자 표기가 다르다'));

// ─────────────────────────────────────────────────────────────────────────────
section('⑦ resolveFactcheck 3갈래');

const okClean = fcm.resolveFactcheck(ITEM(), fcm.normalizeFactcheck({ verdict: 'ok', note: '문맥 일치', source: URL }));
eq('① ok + 정정 불필요 → produce', okClean.action, 'produce');
eq('무변경', okClean.corrected, false);

const okCorrected = fcm.resolveFactcheck(ITEM(), fcm.normalizeFactcheck({
  verdict: 'ok', needs_correction: true, note: '작품 라벨이 어긋난다',
  corrected_title: '이성과 감성', corrected_author: '제인 오스틴',
}));
eq('② ok + 라벨 정정본 → produce', okCorrected.action, 'produce');
eq('정정 반영 표시', okCorrected.corrected, true);
eq('정정본이 하류로 흘러간다', okCorrected.item.source.title, '이성과 감성');

const okUnapplicable = fcm.resolveFactcheck(ITEM(), fcm.normalizeFactcheck({
  verdict: 'ok', needs_correction: true, note: '저자가 다르니 반드시 수정',
}));
eq('③ ok + 정정 불가 → hold', okUnapplicable.action, 'hold');
ok('사유에 진단이 실린다', okUnapplicable.note.includes('correction_missing'), okUnapplicable.note);

// ─────────────────────────────────────────────────────────────────────────────
section('⑧ hold 사유 분류 — permanent 이지 external 이 아니다');

for (const reason of ['factcheck:doubtful', 'factcheck:false', 'factcheck:quote-not-found',
  'factcheck:corpus-unavailable', 'factcheck:correction-unapplicable']) {
  eq(`classifyHeld('${reason}') = permanent`, lib.classifyHeld(reason), 'permanent');
  ok(`'${reason}' 은 1-A 면제(external)가 아니다`, lib.classifyHeld(reason) !== 'external');
}

// ─────────────────────────────────────────────────────────────────────────────
section('⑨ 캐시 프리시드 — 통합 테스트가 네트워크 없이 도는 경로');
//
// `run-cardnews.mjs` 는 factCheck 에 fetchText 를 주입하지 않는다(그게 맞다 — 운영에서는 실제로
// 받아야 한다). 그래서 통합 드라이런은 **캐시 파일을 미리 깔아** 네트워크 0 을 지킨다.
const PRESEED_URL = 'https://www.gutenberg.org/cache/epub/1260/pg1260.txt';
mkdirSync(dirname(fcm.corpusPath(PRESEED_URL)), { recursive: true });
writeFileSync(fcm.corpusPath(PRESEED_URL), FULLTEXT, 'utf8');
const preseeded = fcm.verifyQuote(ITEM({ source: { ...ITEM().source, fulltext_url: PRESEED_URL } }), { cfg: CFG });
eq('🔴 캐시가 깔려 있으면 fetch 없이 대조된다', preseeded.found, true);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
