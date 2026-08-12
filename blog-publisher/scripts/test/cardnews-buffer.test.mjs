#!/usr/bin/env node
/**
 * cardnews-buffer.test.mjs — Robin 🐦 대본 + 예비 대본 buffer (계획 §3.6 · Step 5)
 *
 * 증명하는 것:
 *   ① 프롬프트가 **robin BRIEF 로 시작**한다(AC-17) + 가드레일 문구
 *   ② 🔴 **카드 역할**이 이 버티컬의 것이다: 표지=문제 지목 / 2=공감 / 3~4=책의 말(인용+출처)
 *      / 5=해석 / 6=전환 / 7=저장+지목. 그리고 전환이 "힘내세요"로 끝나는 것을 이름 불러 막는다
 *   ③ 🔴 **인용은 손대지 말라**가 프롬프트에 실재하고, 스키마가 `quote` 블록을 강제한다.
 *      출처가 대본에서 조용히 빠지면 우리는 출처 없는 감성글 계정이 된다
 *   ④ 🔴 `translator` 는 **null 고정** — 키 누락(모름)과 null(자체 번역)을 구분해 검증한다
 *   ⑤ 스키마가 7장을 보장하고, 글자수 위반은 힌트를 붙여 재생성하며, 3회를 다 쓰면 throw
 *   ⑥ 🔴 provenance 영속화 — 원문 URL·대조 성공 여부가 인덱스에 남는다(테이크다운 런북)
 *   ⑦ 🔴 buffer 적립 자격(검증 ok + TIER-1 통과분만) · refill-to-target · top-up 면제
 *
 * 🔴 실 `claude -p` 미사용 · 네트워크 0 — 전부 스텁.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-buffer-'));
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';

const lib = await import('../cardnews/lib.mjs');
const sc = await import('../cardnews/script.mjs');
const gg = await import('../cardnews/gate-generalization.mjs');

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

const ITEM = {
  id: 'a1b2c3d4e5',
  problem: '내가 너무 많이 준 것 같을 때',
  situation: '답장을 기다리며 보낸 문장을 다시 읽는 밤',
  quote_original: 'I declare after all there is no enjoyment like reading',
  quote_ko: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
  source: { title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813, fulltext_url: URL },
  form: 'novel',
  interpretation: '그 시간은 도피가 아니라 회복이었다는 것을 오스틴은 농담처럼 말한다. 우리가 자기에게 돌려주는 유일한 몫이다.',
  shift: '자책하던 자리에서 한 걸음 옆으로',
  audience: '요즘 지쳐 보이는 사람에게',
  public_domain: true,
};
const FC = {
  verdict: 'ok', note: '문맥과 뜻이 일치한다', source: URL,
  machine: { verified: true, url: URL, offset: 1234, cached: false },
};

const goodScript = (over = {}) => ({
  cover: { headline: '내가 너무 많이 준 것 같을 때', sub: '주는 쪽이 늘 정해져 있었다면', country: '오만과 편견', flag_emoji: '📖' },
  cards: [1, 2, 3, 4, 5].map(i => ({ index: i, headline: `카드 ${i} 제목`, body: `카드 ${i} 본문입니다. 상황을 구체적으로 적습니다.` })),
  outro: { headline: '저장해두세요', body: '요즘 지쳐 보이는 사람에게 보내 주세요.' },
  quote: {
    text: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
    source: { title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813 },
  },
  caption_sections: { hook: '주는 쪽이 늘 정해져 있었다면', body: '오스틴은 그 시간을 회복이라 불렀다.', cta: '저장해두세요.' },
  hashtags: ['#책속의문장', '#오만과편견'],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
section('① 프롬프트 — BRIEF 선두 주입 + 가드레일');

const brief = lib.loadAgentBrief('robin');
ok('robin BRIEF 가 비어있지 않다', brief.length > 100, `len=${brief.length}`);
const prompt = sc.buildScriptPrompt(ITEM, CFG);
ok('프롬프트가 robin BRIEF 로 시작한다', prompt.startsWith(brief), `head='${prompt.slice(0, 40)}…'`);
ok('프롬프트에 가드레일 문구가 실린다', prompt.includes(GUARD));
ok('7장 구조가 고정으로 명시된다', prompt.includes('= 정확히 7장'));
ok('글자수 상한이 config 에서 온다', prompt.includes(`${CFG.cards.headline_max_chars}자 이내`));
ok('힌트가 있으면 프롬프트에 실린다', sc.buildScriptPrompt(ITEM, CFG, '⚠ 직전 시도 위반').includes('⚠ 직전 시도 위반'));

// 소재가 그대로 전달되는가 — 작가가 인용·해설·전환 재료 없이 쓰면 밋밋한 총론으로 돌아간다.
for (const [label, v] of [['문제', ITEM.problem], ['상황', ITEM.situation], ['인용', ITEM.quote_ko],
  ['해설 재료', ITEM.interpretation], ['전환 재료', ITEM.shift], ['보낼 사람', ITEM.audience]]) {
  ok(`${label} 이 전달된다`, prompt.includes(v));
}
ok('출처가 "제목 · 저자 (연도)"로 전달된다', prompt.includes('오만과 편견 · 제인 오스틴 (1813)'));

// ─────────────────────────────────────────────────────────────────────────────
section('②-a 🔴 인용 불가침 — 대본이 인용을 다듬으면 원문 대조가 무효가 된다');

ok('🔴 인용을 손대지 말라는 지시가 있다', prompt.includes('[🔴 인용은 손대지 마라]'));
ok('그 이유(기계가 글자 단위로 확인했다)가 함께 있다', prompt.includes('글자 단위로 대조해 실재를 확인한'));
ok('🔴 출처 노출 카드가 지정된다(3~4번)', prompt.includes('3~4번 카드에 **반드시 노출**'));
ok('quote.text 상한이 config 에서 온다', prompt.includes(`quote.text: ${CFG.quote.max_chars}자 이내`));
ok('🔴 translator=null 고정이 프롬프트에 있다', prompt.includes('translator 는 **null 고정**'));
ok('cover.country 가 책 제목 자리임을 알린다', prompt.includes('**책 제목**(20자 이내)'));

// ─────────────────────────────────────────────────────────────────────────────
section('②-b 🔴 카드 역할 — 위로 콘텐츠의 실패는 "아무 말도 안 해서"다');

ok('1번=표지 문제 지목', /\*\*1번\(표지\) = 문제 지목\.\*\*/.test(prompt));
ok('2번=공감', /\*\*2번 카드 = 공감\.\*\*/.test(prompt));
ok('3~4번=책의 말(정체성)', /\*\*3~4번 카드\(책의 말\) = 이 채널의 정체성\.\*\*/.test(prompt));
ok('5번=해석(분량상 주)', /\*\*5번 카드\(해석\) = 분량상 주\(主\)\.\*\*/.test(prompt));
ok('6번=전환', /\*\*6번 카드 = 전환\.\*\*/.test(prompt));
ok('7번=저장+지목', /\*\*7번 카드\(마무리\) = 저장 \+ 지목\.\*\*/.test(prompt));

ok('🔴 "힘내세요"류로 끝나는 전환을 이름 불러 막는다',
  prompt.includes('"결국 다 지나간다", "당신은 충분해요", "힘내세요"로 끝나면 아무도 저장하지 않는다'));
ok('🔴 뒤집는 방향이 지정된다(노력의 문제가 아니었다)',
  prompt.includes('"더 노력하라"가 아니라 "그건 노력의 문제가 아니었다"'));
ok('🔴 인용은 고전 그대로·해석은 오늘의 말(번역체 낙차 관리)',
  prompt.includes('인용은 고전 그대로지만 해석은 **오늘의 말**'));
ok('🔴 지목의 근거(1:1 DM 전달)가 프롬프트에 있다', prompt.includes('1:1 DM 전달'));
ok('저장 이유 3종이 명시된다', prompt.includes('저장하는 이유는 셋뿐'));
ok('캡션 cta 에도 저장을 요구한다', prompt.includes('캡션 cta 에도 **저장**'));
ok('훈계·진단 금지가 문구 규칙에 있다',
  prompt.includes('**진단하지 마라.**') && prompt.includes('전칭 부사'));

// 문형 대조표 — 축이 국명에서 **성별·연령·유형**으로 갈렸다(문형은 같다).
ok('문형 대조표가 실린다', prompt.includes('| 써도 되는 문형 | 쓰면 안 되는 문형 |'));
for (const bad of ['여자들은 다 먼저 연락받고 싶어 한다.', '착한 사람들은 원래 거절을 못 한다.', 'INFP 는 원래 혼자 있어야 충전된다.']) {
  ok(`금지 문형이 표에 실린다: ${bad.slice(0, 12)}…`, prompt.includes(bad));
}
for (const good of ['먼저 연락하는 쪽이 늘 정해져 있으면 관계는 기운다.', '거절을 미루면 미안함은 이자가 붙는다.']) {
  ok(`허용 문형이 표에 실린다: ${good.slice(0, 12)}…`, prompt.includes(good));
}
ok('🔴 "약하게 쓰라는 뜻이 아니다"가 명시된다(헤징 유도 방지)', prompt.includes('**약하게 쓰라는 뜻이 아니다**'));
for (const h of ['결국 다 지나간다', '사람마다 다르다', '정답은 없다', '힘내세요', '긍정적으로 생각하세요']) {
  ok(`후퇴·훈계 표현 금지: ${h}`, prompt.includes(`"${h}"`));
}

// 표지 패턴 — 전부 상한 이내이고, 사람의 집단을 주어로 삼지 않는다.
const COVERS = [
  '내가 너무 많이 준 것 같을 때',
  '대화가 자꾸 후회로 남을 때',
  '거절 못 하는 게 착한 건 아니다',
  '헤어진 뒤 자책이 오래 가는 이유',
  '떠난 사람에게 아직 못 한 말',
];
ok('표지 패턴 5종이 프롬프트에 있다', COVERS.every(c => prompt.includes(c)));
for (const c of COVERS) {
  ok(`표지 예시가 headline 상한 이내: ${c}`, c.length <= CFG.cards.headline_max_chars,
    `${c.length}자 > ${CFG.cards.headline_max_chars}자`);
  // ⚠ 게이트의 **차단 축**(성별·유형 일반화)은 gate-generalization 소유라 여기서 단언하지 않는다.
  //    여기서 지키는 계약은 "우리가 권한 문구가 게이트에 걸리지 않는다" 한 방향뿐이다.
  const v = gg.runGate({ cover: { headline: c }, cards: [], caption_sections: {} }, { cfg: CFG, appendQueue: false });
  ok(`🔴 표지 예시가 실제 게이트를 통과한다: ${c}`, v.pass, v.reason);
}

// ─────────────────────────────────────────────────────────────────────────────
section('②-c 🔴 카드 자리 계산 — config 장수에 따라 재배치된다');

eq('기본값은 그대로 5(오늘 동작은 변하지 않는다)', sc.bodyCardCount(CFG), 5);
eq('config 가 없으면 폴백 5', sc.bodyCardCount({}), sc.BODY_CARDS);
eq('body_count=3 을 읽는다', sc.bodyCardCount({ cards: { body_count: 3 } }), 3);
eq('범위 아래는 클램프(설정 오타로 발행을 날리지 않는다)', sc.bodyCardCount({ cards: { body_count: 1 } }), sc.BODY_CARDS_MIN);
eq('범위 위도 클램프', sc.bodyCardCount({ cards: { body_count: 99 } }), sc.BODY_CARDS_MAX);
eq('정수가 아니면 폴백', sc.bodyCardCount({ cards: { body_count: 'abc' } }), sc.BODY_CARDS);

const L5 = sc.cardLayout(5);
eq('기본 배치: 총 7장', L5.total, 7);
eq('인용 카드는 3~4', `${L5.quoteStart}~${L5.quoteEnd}`, '3~4');
eq('해석은 5', `${L5.interpStart}~${L5.interpEnd}`, '5~5');
eq('전환은 6', L5.twist, 6);
eq('마무리는 7', L5.outro, 7);
// 🔴 gates.expected_count 는 손으로 맞추는 값이다(= body_count + 2). 어긋나면 매 런 fail.
eq('🔴 gates.expected_count 가 body_count+2 와 일치한다', CFG.gates.expected_count, CFG.cards.body_count + 2);
eq('cards.count 표기도 같은 값', CFG.cards.count, CFG.cards.body_count + 2);

const L6 = sc.cardLayout(6);
eq('body 6장이면 총 8장·전환 7·마무리 8', `${L6.total}/${L6.twist}/${L6.outro}`, '8/7/8');
ok('역할표가 장수에 따라 재배치된다', sc.cardRoles(6).includes('7번 카드 = 전환') && sc.cardRoles(6).includes('8번 카드(마무리)'));
ok('최소 장수(3)에서도 역할표가 깨지지 않는다', sc.cardRoles(3).includes('전환') && sc.cardRoles(3).includes('마무리'));

const CFG3 = { ...CFG, cards: { ...CFG.cards, body_count: 3 } };
const s3 = goodScript({ cards: [1, 2, 3].map(i => ({ index: i, headline: `제목 ${i}`, body: `본문 ${i}` })) });
eq('🔴 body_count=3 이면 본문 3장이 통과한다(검증이 config 를 읽는다)', sc.validateScript(s3, CFG3).ok, true);
eq('body_count=3 이면 5장은 실패한다', sc.validateScript(goodScript(), CFG3).ok, false);
ok('프롬프트도 config 장수를 따른다',
  sc.buildScriptPrompt(ITEM, CFG3).includes('본문 3장') && sc.buildScriptPrompt(ITEM, CFG3).includes('= 정확히 5장'));

// ─────────────────────────────────────────────────────────────────────────────
section('③ 스키마 — 7장 보장 + 인용 블록 강제');

eq('cover+cards5+outro = 7', sc.cardCount(goodScript()), 7);
eq('정상 대본은 검증 통과', sc.validateScript(goodScript(), CFG).ok, true);

const four = goodScript({ cards: [1, 2, 3, 4].map(i => ({ index: i, headline: `제목 ${i}`, body: `본문 ${i}` })) });
eq('본문 4장이면 실패', sc.validateScript(four, CFG).ok, false);
ok('사유에 장수가 드러난다', sc.validateScript(four, CFG).violations.some(v => /cards 4장/.test(v)));
eq('cover 없으면 실패', sc.validateScript(goodScript({ cover: null }), CFG).ok, false);
eq('outro 없으면 실패', sc.validateScript(goodScript({ outro: null }), CFG).ok, false);
eq('caption_sections 결손이면 실패', sc.validateScript(goodScript({ caption_sections: { hook: 'a', body: 'b' } }), CFG).ok, false);
eq('hashtags 없으면 실패', sc.validateScript(goodScript({ hashtags: [] }), CFG).ok, false);
eq('객체가 아니면 실패', sc.validateScript('문자열', CFG).ok, false);

// 🔴 인용 블록 — 프롬프트로 요구만 하면 조용히 빠진다. 빠지면 출처 없는 감성글이 나간다.
eq('🔴 quote 블록이 없으면 실패', sc.validateScript(goodScript({ quote: null }), CFG).ok, false);
ok('사유가 인용 블록을 지목한다',
  sc.validateScript(goodScript({ quote: null }), CFG).violations.some(v => v.includes('quote 블록 없음')));
const q = () => JSON.parse(JSON.stringify(goodScript().quote));
eq('quote.text 가 비면 실패', sc.validateScript(goodScript({ quote: { ...q(), text: '' } }), CFG).ok, false);
eq('quote.text 가 상한을 넘으면 실패',
  sc.validateScript(goodScript({ quote: { ...q(), text: '가'.repeat(CFG.quote.max_chars + 1) } }), CFG).ok, false);
eq('🔴 출처 제목이 없으면 실패', sc.validateScript(goodScript({ quote: { ...q(), source: { author: 'a', translator: null } } }), CFG).ok, false);
eq('🔴 출처 저자가 없으면 실패', sc.validateScript(goodScript({ quote: { ...q(), source: { title: 't', translator: null } } }), CFG).ok, false);
// 🔴 키 누락(모름)과 null(자체 번역)은 다르게 판정돼야 한다.
eq('🔴 translator 키가 아예 없으면 실패',
  sc.validateScript(goodScript({ quote: { ...q(), source: { title: 't', author: 'a' } } }), CFG).ok, false);
eq('🔴 translator 에 이름이 들어가면 실패(기존 번역서 사용 금지)',
  sc.validateScript(goodScript({ quote: { ...q(), source: { title: 't', author: 'a', translator: '김번역' } } }), CFG).ok, false);
eq('translator: null 은 통과', sc.validateScript(goodScript(), CFG).ok, true);

// cover.country = 책 제목 pill(렌더러 슬롯).
eq('🔴 cover.country(책 제목 pill)가 없으면 실패',
  sc.validateScript(goodScript({ cover: { ...goodScript().cover, country: '' } }), CFG).ok, false);
eq('pill 이 너무 길면 실패(렌더 넘침)',
  sc.validateScript(goodScript({ cover: { ...goodScript().cover, country: '가'.repeat(21) } }), CFG).ok, false);

const longH = goodScript();
longH.cards[2].headline = '가'.repeat(CFG.cards.headline_max_chars + 1);
eq('헤드라인 상한 초과 실패', sc.validateScript(longH, CFG).ok, false);
const longB = goodScript();
longB.cards[0].body = '나'.repeat(CFG.cards.body_max_chars + 1);
eq('본문 상한 초과 실패', sc.validateScript(longB, CFG).ok, false);

// ─────────────────────────────────────────────────────────────────────────────
section('④ 재생성 — 위반을 힌트로 붙인다 · 3회 소진 시 throw');

const hints = [];
let n = 0;
const r = sc.resolveScript({
  cfg: CFG, attempts: 3,
  generate: (hint) => { hints.push(hint); return ++n < 3 ? longH : goodScript(); },
});
eq('3번째 시도에서 통과', r.attempts_used, 3);
eq('첫 시도는 힌트 없음', hints[0], '');
ok('두 번째 시도에 위반 목록이 힌트로 붙는다', hints[1].includes('직전 시도는 다음을 어겼다') && hints[1].includes('headline'));
eq('힌트가 매번 갱신된다', hints.length, 3);

let threw = null;
try { sc.resolveScript({ cfg: CFG, attempts: 3, generate: () => longH }); } catch (e) { threw = e; }
ok('3회 모두 실패하면 throw', threw !== null && /3회 시도/.test(threw.message), threw?.message);
ok('위반 목록이 err 에 실린다', Array.isArray(threw?.violations) && threw.violations.length > 0);

let budgetThrew = null;
try {
  sc.resolveScript({ cfg: CFG, attempts: 3, generate: () => { const e = new Error('budget'); e.budget = { calls: 10, cap: 9 }; throw e; } });
} catch (e) { budgetThrew = e; }
ok('예산 초과는 재시도하지 않고 즉시 전파', Boolean(budgetThrew?.budget));

const POST_ID = lib.postIdFor(ITEM.id, new Date('2026-08-01T02:00:00Z'));
const gen = sc.generateScript(ITEM, { cfg: CFG, postId: POST_ID, deps: { callClaude: () => JSON.stringify(goodScript()) } });
eq('대본에 post_id 가 박힌다', gen.script.post_id, POST_ID);
ok('script.json 이 work/{post_id} 에 저장된다', existsSync(join(lib.workDir(POST_ID), 'script.json')));
eq('총 7장', sc.cardCount(gen.script), 7);

// 🔴 인용 게이트 입력은 **모델의 재타이핑이 아니라 검증된 소재**여야 한다.
eq('🔴 검증된 인용 필드가 script.item 으로 붙는다(결정론)', gen.script.item.quote_original, ITEM.quote_original);
eq('원문 주소도 함께 간다(게이트가 대조에 쓴다)', gen.script.item.source.fulltext_url, URL);
eq('form 도 함께 간다', gen.script.item.form, 'novel');
eq('public_domain 도 함께 간다', gen.script.item.public_domain, true);
ok('quoteFieldsOf 는 소재가 비어도 죽지 않는다', sc.quoteFieldsOf({}).quote_ko === null);

// 🔴 인용 불가침 — 작가가 한 글자라도 다듬으면 원문 대조 보증이 무효가 된다. 기계가 막는다.
const tampered = goodScript({ quote: { ...goodScript().quote, text: '결국 독서만 한 즐거움은 없다고 나는 말한다.' } });
eq('소재 없이 보면 형식은 통과', sc.validateScript(tampered, CFG).ok, true);
eq('🔴 소재와 대조하면 인용 변조가 잡힌다', sc.validateScript(tampered, CFG, { item: ITEM }).ok, false);
ok('사유가 인용 변조를 지목한다',
  sc.validateScript(tampered, CFG, { item: ITEM }).violations.some(v => v.includes('한 글자도 바꾸지 않는다')));
eq('🔴 출처 저자를 바꾸는 것도 잡힌다',
  sc.validateScript(goodScript({ quote: { ...goodScript().quote, source: { title: '오만과 편견', author: '샬럿 브론테', translator: null } } }),
    CFG, { item: ITEM }).ok, false);
eq('원본 그대로면 통과', sc.validateScript(goodScript(), CFG, { item: ITEM }).ok, true);

let tamperThrew = null;
try {
  sc.generateScript(ITEM, { cfg: CFG, deps: { callClaude: () => JSON.stringify(tampered) } });
} catch (e) { tamperThrew = e; }
ok('🔴 인용을 고친 대본은 3회 재시도 후 폐기된다(발행 경로에 닿지 않는다)', tamperThrew !== null, tamperThrew?.message);

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ 🔴 provenance 영속화 — "왜 믿었는가"는 원문 URL + 대조 성공이다');

lib.transition(POST_ID, 'planned', { backlog_id: ITEM.id });
const post = sc.persistScripted(POST_ID, { item: ITEM, script: gen.script, factcheck: FC });
eq('상태가 scripted', post.status, 'scripted');
ok('provenance 객체가 생겼다', post.provenance && typeof post.provenance === 'object');
eq('🔴 원문 주소 영속화', post.provenance.fulltext_url, URL);
eq('🔴 원문 구절 영속화', post.provenance.quote_original, ITEM.quote_original);
eq('🔴 기계 대조 성공이 남는다', post.provenance.quote_verified, true);
eq('출처 제목 영속화', post.provenance.source_title, '오만과 편견');
eq('출처 저자 영속화', post.provenance.source_author, '제인 오스틴');
eq('🔴 번역자 null 이 그대로 남는다(자체 번역)', post.provenance.source_translator, null);
eq('factcheck_source 영속화', post.provenance.factcheck_source, URL);
eq('factcheck_note 영속화', post.provenance.factcheck_note, FC.note);
eq('factcheck_verdict 영속화', post.provenance.factcheck_verdict, 'ok');
eq('정정 여부 영속화', post.provenance.factcheck_corrected, false);
eq('소재 메타도 함께(subject=problem)', post.subject, ITEM.problem);
eq('책·저자가 인덱스에 남는다', `${post.book}/${post.author}`, '오만과 편견/제인 오스틴');
eq('backlog_id 가 남아 pick 이 재선정하지 않는다', post.backlog_id, ITEM.id);
// 🔴 회전축. freshnessMap 이 인덱스에서 이 값을 읽는다 — 없으면 백로그 역참조로만 복원되고,
//    백로그가 정리되는 날 회전이 조용히 멈춘다.
eq('🔴 problem 영속화(회전축이 인덱스에 남는다)', post.problem, ITEM.problem);
eq('디스크 재로드 후에도 회전축 유지', lib.getPost(POST_ID).problem, ITEM.problem);
eq('디스크 재로드 후에도 원문 주소 유지', lib.getPost(POST_ID).provenance.fulltext_url, URL);
ok('history 에 전이가 기록된다', lib.getPost(POST_ID).history.some(h => h.to === 'scripted'));

const POST2 = lib.postIdFor('bbbbbbbbbb', new Date('2026-08-02T02:00:00Z'));
lib.transition(POST2, 'planned', { backlog_id: 'bbbbbbbbbb' });
const corrected = sc.persistScripted(POST2, {
  item: { ...ITEM, id: 'bbbbbbbbbb', factcheck_corrected: true },
  script: gen.script, factcheck: { ...FC, needs_correction: true },
});
eq('정정 반영본은 factcheck_corrected=true', corrected.provenance.factcheck_corrected, true);
// 대조 실패분(held)도 같은 질문을 받는다 — verified=false 가 그대로 남아야 한다.
const POST3 = lib.postIdFor('cccccccccc', new Date('2026-08-03T02:00:00Z'));
lib.transition(POST3, 'planned', { backlog_id: 'cccccccccc' });
eq('🔴 대조 실패분은 quote_verified=false 로 남는다',
  sc.persistScripted(POST3, { item: { ...ITEM, id: 'cccccccccc' }, script: gen.script,
    factcheck: { verdict: 'false', machine: { verified: false } } }).provenance.quote_verified, false);

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ 🔴 buffer 적립 자격 — 인용검증 ok + TIER-1 통과분만');

const bank = (over = {}) => sc.bankToBuffer({
  backlogId: 'aaaaaaaaaa', script: goodScript(), provenance: { fulltext_url: URL },
  factcheckVerdict: 'ok', gatePass: true, ...over,
});

eq('자격 충족 → 적립', bank().banked, true);
eq('버퍼 1건', sc.bufferCount(), 1);

for (const v of ['doubtful', 'false', undefined]) {
  const r2 = bank({ backlogId: 'zzz', factcheckVerdict: v });
  eq(`🔴 인용검증=${v} → 적립 거부`, r2.banked, false);
  ok('사유가 factcheck', r2.reason.startsWith('factcheck:'), r2.reason);
}
const gateFail = bank({ backlogId: 'zzz', gatePass: false });
eq('🔴 TIER-1 게이트 미통과 → 적립 거부', gateFail.banked, false);
eq('사유가 gate:generalization', gateFail.reason, 'gate:generalization');
eq('gatePass 미지정(undefined)도 거부', bank({ backlogId: 'zzz', gatePass: undefined }).banked, false);
eq('입력 결손도 거부', bank({ backlogId: null }).banked, false);
eq('거부된 건은 버퍼에 남지 않는다', sc.bufferCount(), 1);

const banked = sc.loadBuffer()[0];
ok('backlog_id 저장', banked.backlog_id === 'aaaaaaaaaa');
ok('script 저장', sc.cardCount(banked.script) === 7);
ok('provenance 저장(원문 주소)', banked.provenance?.fulltext_url === URL);
ok('tier2_warnings 저장(빈 배열)', Array.isArray(banked.tier2_warnings));
ok('banked_at 타임스탬프', typeof banked.banked_at === 'string' && banked.banked_at.includes('T'));

sc.bankToBuffer({ backlogId: 'cccccccccc', script: goodScript(), factcheckVerdict: 'ok', gatePass: true, now: new Date(Date.now() + 60_000) });
eq('버퍼 2건', sc.bufferCount(), 2);
eq('가장 오래된 것부터 소비(FIFO)', sc.takeFromBuffer().backlog_id, 'aaaaaaaaaa');
eq('소비 후 1건', sc.bufferCount(), 1);
sc.takeFromBuffer();
eq('빈 버퍼에서 꺼내면 null', sc.takeFromBuffer(), null);

// ─────────────────────────────────────────────────────────────────────────────
section('⑦ refill-to-target · top-up 면제');

eq('버퍼 비어있음', sc.bufferCount(), 0);
let made = 0;
const producer = () => ({
  backlogId: `gen${++made}`, script: goodScript(), provenance: { fulltext_url: URL },
  tier2Warnings: [], factcheckVerdict: 'ok', gatePass: true,
});

const t1 = sc.topUpBuffer({ cfg: CFG, produce: producer });
eq('🔴 런당 상한 2건만 채운다(목표 5 인데도)', t1.after, 2);
eq('target 기록', t1.target, CFG.buffer.target);

sc.topUpBuffer({ cfg: CFG, produce: producer });
const t3 = sc.topUpBuffer({ cfg: CFG, produce: producer });
eq('세 번째 런에서 목표 5 도달', t3.after, 5);
eq('마지막 런은 부족분 1건만 채운다', t3.banked.length, 1);
eq('🔴 목표를 채우면 더 만들지 않는다', sc.topUpBuffer({ cfg: CFG, produce: producer }).banked.length, 0);

while (sc.takeFromBuffer());
const t5 = sc.topUpBuffer({ cfg: CFG, produce: () => ({ ...producer(), factcheckVerdict: 'doubtful' }) });
eq('자격 미달은 적립 0', t5.banked.length, 0);
eq('자격 미달 사유가 집계된다', t5.skipped.length, 2);

while (sc.takeFromBuffer());
const t6 = sc.topUpBuffer({ cfg: CFG, produce: () => { throw new Error('claude 실행 실패(network)'); } });
ok('생성이 죽어도 topUpBuffer 는 throw 하지 않는다(발행은 이미 끝났다)', t6.after === 0);

lib.resetClaudeCalls();
const fakeOk = () => JSON.stringify({ subtype: 'success', is_error: false, result: '{}' });
for (let i = 0; i < 3; i++) lib.callClaude('x', { exec: fakeOk, budgetMax: 3 });
let overThrew = null;
try { lib.callClaude('x', { exec: fakeOk, budgetMax: 3 }); } catch (e) { overThrew = e; }
ok('상한 초과 호출은 throw', Boolean(overThrew?.budget));
eq('throw 해도 계상은 됐다', lib.claudeCallCount(), 4);

lib.resetClaudeCalls();
for (let i = 0; i < 3; i++) lib.callClaude('x', { exec: fakeOk, budgetMax: 3 });
let exemptThrew = null;
try { lib.callClaude('x', { exec: fakeOk, budgetMax: 3, exempt: true }); } catch (e) { exemptThrew = e; }
ok('🔴 exempt(top-up) 는 상한을 넘겨도 throw 하지 않는다', exemptThrew === null, exemptThrew?.message);
eq('🔴 그래도 계상은 한다(공유 원장 과소보고 방지)', lib.claudeCallCount(), 4);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
