#!/usr/bin/env node
/**
 * cardnews-gate-quote.test.mjs — 인용 안전 + 정신건강 경계 게이트 (버티컬: 책 인용 위로)
 *
 * 증명하는 것:
 *   ① 🔴 코퍼스 **전건** — comfort-negative 전건 차단 · comfort-negative-tier2 전건
 *      exit 0+경고 · comfort-positive 전건 exit 0+무경고. **실제 CLI 를 spawn 해서** 종료
 *      코드를 읽는다 — 게이트의 계약은 반환값이 아니라 종료코드이고, 순수 함수만 호출하면
 *      `process.exit` 배선이 틀려도 초록으로 보인다.
 *      ⚠ 안전 레이어는 게이트 2개(generalization·quote)로 나뉘어 있으므로 "한 문장은 둘 중
 *      하나가 막으면 된다"로 판정한다. 한 문장이 둘 다에 걸릴 이유가 없다.
 *   ② 위반 유형별 개별 케이스 — 시(form=poem) · 길이 · 출처 3종 · translator 누락/명시적 null
 *      · public_domain · 해설 비율 · 원문 실재 대조 · 임상 조언 · 위기 표현 · 무출처 인용
 *   ③ 🔴 원문 실재 대조가 **줄바꿈으로 감긴 원문**에서도 실재를 찾아낸다(단순 grep 이
 *      false negative 를 내던 지점) — 영어·일본어 두 계열 모두. **네트워크 없이** 픽스처로
 *   ④ 확인 불가(`unavailable`)와 가짜 인용(`not_found`)이 **구분돼 기록**된다 — 뭉개면
 *      네트워크 한 번 흔들렸다고 멀쩡한 소재가 영구 폐기되거나 가짜가 재시도로 되살아난다
 *   ⑤ 경고는 차단하지 않고 `review-queue.jsonl` 에 `gate:"quote"` 로 남는다
 *   ⑥ **LLM 호출 0회** — 이 게이트는 claude 를 import 하지도 spawn 하지도 않는다
 *   ⑦ exit 계약 0/1/2 (판정 실패를 통과로도 차단으로도 보고하지 않는다)
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-quote-'));
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';
process.env.CARDNEWS_NO_NETWORK = '1';        // 🔴 테스트는 네트워크를 타지 않는다

const lib = await import('../cardnews/lib.mjs');
const gq = await import('../cardnews/gate-quote.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const CFG = lib.loadConfig();
const QUOTE_GATE = new URL('../cardnews/gate-quote.mjs', import.meta.url).pathname;
const GEN_GATE = new URL('../cardnews/gate-generalization.mjs', import.meta.url).pathname;
const CORPUS = new URL('../../benchmark/cardnews/', import.meta.url).pathname;

const corpus = (f) => readFileSync(join(CORPUS, f), 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));

/** 실제 CLI spawn → {code, out}. 계약은 종료코드다. */
function runCli(gate, args) {
  const r = spawnSync(process.execPath, [gate, ...args], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR_OVERRIDE: TMP, RUN_MODE: 'mock', CARDNEWS_NO_NETWORK: '1' },
  });
  let out = null;
  try { out = JSON.parse(String(r.stdout).trim().split('\n').filter(Boolean).pop()); } catch { /* 아래서 드러난다 */ }
  return { code: r.status, out, stdout: r.stdout };
}

/** 안전 레이어 전체(두 게이트)를 한 문장에 돌린다. */
function runLayer(line) {
  const q = runCli(QUOTE_GATE, ['--line', line]);
  const g = runCli(GEN_GATE, ['--line', line]);
  const hits = [...(q.out?.evidence?.tier1_hits ?? []), ...(g.out?.evidence?.tier1_hits ?? [])];
  const warns = [...(q.out?.evidence?.tier2_warnings ?? []), ...(g.out?.evidence?.tier2_warnings ?? [])];
  return { blocked: q.code === 1 || g.code === 1, codes: [q.code, g.code], hits, warns };
}

// ─────────────────────────────────────────────────────────────────────────────
section('① 코퍼스 전건 — 실제 CLI 종료코드');

const NEG = corpus('comfort-negative.txt');
const NEG2 = corpus('comfort-negative-tier2.txt');
const POS = corpus('comfort-positive.txt');

eq('comfort-negative.txt 15줄', NEG.length, 15);
eq('comfort-negative-tier2.txt 6줄', NEG2.length, 6);
eq('comfort-positive.txt 15줄', POS.length, 15);

let negOk = 0;
for (const line of NEG) {
  const r = runLayer(line);
  if (r.blocked && r.hits.length > 0) negOk++;
  else ok(`negative 미차단: ${line.slice(0, 34)}…`, false, `codes=${r.codes} hits=${JSON.stringify(r.hits)}`);
}
eq(`🔴 comfort-negative.txt ${NEG.length}/${NEG.length} 차단`, negOk, NEG.length);

let neg2Ok = 0;
for (const line of NEG2) {
  const r = runLayer(line);
  if (!r.blocked && r.codes.every(c => c === 0) && r.hits.length === 0 && r.warns.length > 0) neg2Ok++;
  else ok(`tier2 오판: ${line.slice(0, 34)}…`, false, `codes=${r.codes} hits=${JSON.stringify(r.hits)} warns=${JSON.stringify(r.warns)}`);
}
eq(`🔴 comfort-negative-tier2.txt ${NEG2.length}/${NEG2.length} exit 0 + 경고(차단 아님)`, neg2Ok, NEG2.length);

let posOk = 0;
for (const line of POS) {
  const r = runLayer(line);
  if (!r.blocked && r.codes.every(c => c === 0) && r.hits.length === 0 && r.warns.length === 0) posOk++;
  else ok(`positive 오탐: ${line.slice(0, 34)}…`, false, `codes=${r.codes} hits=${JSON.stringify(r.hits)} warns=${JSON.stringify(r.warns)}`);
}
eq(`🔴 comfort-positive.txt ${POS.length}/${POS.length} exit 0 + 무경고`, posOk, POS.length);

// 족 단위 커버리지 — 코퍼스가 실제로 각 규칙군을 밟는가(6줄로 "미탐 0"을 증명하지는 못한다).
const negRules = new Set();
for (const line of NEG) for (const h of runLayer(line).hits) negRules.add(h.rule);
for (const r of ['G1', 'G2', 'G3', 'G4', 'G5', 'M1', 'M2', 'QT1', 'QT2']) {
  ok(`코퍼스에서 ${r} 가 발화한다`, negRules.has(r), `발화=${[...negRules].sort().join(',')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('② 원문 픽스처 — 네트워크 없이 대조');

// 🔴 구텐베르크 원문은 70자 안팎에서 줄바꿈으로 감겨 있다. 단순 grep 은 실재 구절을 놓친다.
const FIX_EN = join(TMP, 'pg1399.txt');
writeFileSync(FIX_EN, [
  'Happy families are all',
  'alike; every unhappy family is',
  'unhappy in its own way.',
  '',
  'Everything was in confusion in the Oblonskys house.',
].join('\n'), 'utf8');

// 띄어쓰기가 없는 원문(일본어) — 줄바꿈이 공백으로 바뀌면 강한 정규화만으로는 여전히 어긋난다.
const FIX_JA = join(TMP, 'pg789.txt');
writeFileSync(FIX_JA, ['吾輩は猫である。名前は', 'まだ無い。どこで生れたか', '頓と見当がつかぬ。'].join('\n'), 'utf8');

const INTERP = '이 문장이 말하는 것은 불행에는 저마다의 사정이 있다는 쪽에 가깝다. 지금 겪는 어긋남도 남과 비교해 설명될 수 있는 종류가 아니라는 뜻이다.';

const baseItem = (over = {}) => ({
  post_id: 'cn-2026-08-01-quote01',
  quote_ko: '행복한 가정은 모두 서로 닮았고, 불행한 가정은 저마다의 이유로 불행하다.',
  quote_original: 'Happy families are all alike; every unhappy family is unhappy in its own way.',
  source: { title: '안나 카레니나', author: '레프 톨스토이', translator: null, fulltext_file: FIX_EN },
  form: 'novel',
  public_domain: true,
  interpretation: INTERP,
  ...over,
});

const base = await gq.runGate(baseItem(), { cfg: CFG, appendQueue: false });
ok('🔴 정상 소재는 통과한다(이게 막히면 매일 발행이 죽는다)', base.pass, JSON.stringify(base.evidence.tier1_hits));
eq('원문 실재 확인됨', base.evidence.verification.status, 'found');
eq('경고 없음', base.evidence.tier2_warnings.length, 0);

// 줄바꿈으로 감긴 영어 원문 — 단순 문자열 포함으로는 못 찾는다는 것부터 보인다.
ok('🔴 단순 includes 는 실재 구절을 놓친다(정규화가 필요한 이유)',
  !readFileSync(FIX_EN, 'utf8').includes('Happy families are all alike; every unhappy family is unhappy in its own way.'));
ok('강한 정규화 대조는 찾아낸다',
  gq.quoteExistsIn(readFileSync(FIX_EN, 'utf8'), 'Happy families are all alike; every unhappy family is unhappy in its own way.'));

// 띄어쓰기 없는 원문 — 공백까지 지운 대조가 없으면 여기서 false negative 가 난다.
ok('🔴 일본어 원문(공백 없음 + 줄바꿈)도 찾아낸다',
  gq.quoteExistsIn(readFileSync(FIX_JA, 'utf8'), '吾輩は猫である。名前はまだ無い。'));
ok('가짜 구절은 찾지 못한다(판별력)',
  !gq.quoteExistsIn(readFileSync(FIX_EN, 'utf8'), 'Happy families are all alike; love conquers every unhappy home.'));

const fake = await gq.runGate(baseItem({
  quote_original: 'Happy families are all alike; love conquers every unhappy home.',
}), { cfg: CFG, appendQueue: false });
eq('🔴 가짜 인용은 차단', fake.pass, false);
eq('verdict = not_found', fake.evidence.verification.status, 'not_found');
ok('Q7 로 기록된다', fake.evidence.tier1_hits.some(h => h.rule === 'Q7'));

// ─────────────────────────────────────────────────────────────────────────────
section('③ 확인 불가(unavailable) vs 가짜(not_found) 구분 · 캐시');

const noSrc = await gq.runGate(baseItem({
  source: { title: '무명 고전', author: '작자 미상', translator: null },
}), { cfg: CFG, appendQueue: false });
eq('원문 위치가 없으면 차단(확인 불가면 그날 거른다)', noSrc.pass, false);
eq('verdict = unavailable', noSrc.evidence.verification.status, 'unavailable');
ok('🔴 일시 실패로 표시된다(가짜 인용과 다른 처리)',
  noSrc.evidence.tier1_hits.some(h => h.rule === 'Q7' && h.transient === true),
  JSON.stringify(noSrc.evidence.tier1_hits));

const netOff = await gq.runGate(baseItem({
  source: { title: '안나 카레니나', author: '레프 톨스토이', translator: null, gutenberg_id: 1399 },
}), { cfg: CFG, appendQueue: false });
eq('CARDNEWS_NO_NETWORK=1 이면 네트워크를 타지 않는다', netOff.evidence.verification.status, 'unavailable');
ok('사유에 네트워크 비활성이 드러난다', /네트워크 비활성/.test(netOff.evidence.verification.detail), netOff.evidence.verification.detail);

// 캐시가 있으면 네트워크 없이도 대조된다(매번 772KB 를 받지 않는다).
mkdirSync(gq.fulltextDir(), { recursive: true });
writeFileSync(join(gq.fulltextDir(), 'gutenberg-1399.txt'), readFileSync(FIX_EN, 'utf8'), 'utf8');
const cached = await gq.runGate(baseItem({
  source: { title: '안나 카레니나', author: '레프 톨스토이', translator: null, gutenberg_id: 1399 },
}), { cfg: CFG, appendQueue: false });
eq('캐시에서 원문을 읽는다', cached.evidence.verification.source, 'cache');
eq('캐시 경로가 state 아래다', gq.fulltextCachePath({ gutenberg_id: 1399 }).startsWith(gq.fulltextDir()), true);
ok('🔴 캐시 디렉터리가 .gitignore 에 있다(1.9GB 커밋 선례)',
  /^state\/cardnews\/fulltext\/$/m.test(readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')));

// ─────────────────────────────────────────────────────────────────────────────
section('④ 저작권 규칙 — 위반 유형별');

const blockedBy = async (label, over, rule) => {
  const r = await gq.runGate(baseItem(over), { cfg: CFG, appendQueue: false });
  ok(`${label} → 차단(${rule})`, r.pass === false && r.evidence.tier1_hits.some(h => h.rule === rule),
    JSON.stringify(r.evidence.tier1_hits.map(h => `${h.rule}:${h.label}`)));
};

await blockedBy('form=poem 은 존재 자체가 위반', { form: 'poem' }, 'Q1');
await blockedBy('form=시 도 같다(우회 차단)', { form: '시' }, 'Q1');
await blockedBy('form 누락', { form: undefined }, 'Q2');
await blockedBy('form 미허용값', { form: 'lyrics' }, 'Q2');
await blockedBy('출처 title 누락', { source: { author: '톨스토이', translator: null, fulltext_file: FIX_EN } }, 'Q3');
await blockedBy('출처 author 공백', { source: { title: 'x', author: '  ', translator: null, fulltext_file: FIX_EN } }, 'Q3');
await blockedBy('🔴 translator 키 자체가 없음(누락 ≠ 원서)',
  { source: { title: 'x', author: 'y', fulltext_file: FIX_EN } }, 'Q3');
await blockedBy('translator 빈 문자열', { source: { title: 'x', author: 'y', translator: '', fulltext_file: FIX_EN } }, 'Q3');
await blockedBy('public_domain 키 없음', { public_domain: undefined }, 'Q4');
await blockedBy('public_domain=false', { public_domain: false }, 'Q4');
await blockedBy('인용 길이 초과', { quote_ko: '가'.repeat(121), interpretation: '나'.repeat(400) }, 'Q5');
await blockedBy('해설이 인용보다 짧다', { interpretation: '짧은 해설.' }, 'Q6');

// 🔴 translator:null 은 **정상 통과 경로**다 — 소재를 저작권 만료 고전으로 한정하고
//    번역을 원문에서 직접 하기로 했으므로(2026-07-31) 역자가 없는 것이 기본값이다.
const selfTranslated = await gq.runGate(baseItem(), { cfg: CFG, appendQueue: false });
ok('🔴 translator:null(자체 번역)은 통과한다', selfTranslated.pass);
const withTranslator = await gq.runGate(baseItem({
  source: { title: 'x', author: 'y', translator: '홍길동', fulltext_file: FIX_EN },
}), { cfg: CFG, appendQueue: false });
ok('역자를 적은 경우도 통과한다', withTranslator.pass, JSON.stringify(withTranslator.evidence.tier1_hits));

// 인용 필드가 아예 없으면 fail-closed.
const noQuote = await gq.runGate({ post_id: 'cn-x', cover: { headline: '오늘의 문장' } }, { cfg: CFG, appendQueue: false });
eq('🔴 인용 필드 전무 = 차단(모르면 통과 금지)', noQuote.pass, false);
ok('Q0 로 기록된다', noQuote.evidence.tier1_hits.some(h => h.rule === 'Q0'));

// 경계값 — 상한 정확히 120자는 통과, 근접(97자 이상)은 경고.
const at120 = await gq.runGate(baseItem({ quote_ko: '가'.repeat(120), interpretation: '나'.repeat(400) }), { cfg: CFG, appendQueue: false });
ok('상한 정확히 120자는 통과', at120.pass, JSON.stringify(at120.evidence.tier1_hits));
ok('상한 근접은 경고(차단 아님)', at120.evidence.tier2_warnings.some(w => w.rule === 'QW2'));
eq('공백은 분량에서 뺀다', gq.countChars('가 나\n다'), 3);

// 설정이 없어도 기본값으로 동작해야 한다(quote 블록은 아직 config 에 없다).
eq('config 에 quote 블록이 없어도 기본 상한 120', gq.quoteCfg({}).max_chars, 120);
eq('기본 해설 비율 1.5', gq.quoteCfg({}).min_interpretation_ratio, 1.5);
eq('config 값이 있으면 그쪽을 쓴다', gq.quoteCfg({ quote: { max_chars: 90 } }).max_chars, 90);

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ 정신건강 경계 — 넓게 잡는다');

for (const [label, line] of [
  ['치료 단정', '이 문장을 읽으면 마음의 병이 치료된다.'],
  ['완치', '꾸준히 읽으면 우울증은 완치된다.'],
  ['진단', '스스로 진단해 보면 답이 나온다.'],
  ['처방', '지친 마음에 필요한 처방을 알려준다.'],
  ['복약 중단', '이제 약을 끊어도 괜찮다.'],
  ['상담 불필요', '상담은 받을 필요 없다.'],
  ['유사 진단명 라벨링', '그 사람은 전형적인 나르시시스트였다.'],
]) eq(`M1 ${label} → 차단`, gq.runGateOnLine(line).pass, false);

for (const [label, line] of [
  ['자살', '자살을 생각했다는 말을 들었다.'],
  ['죽음 소망', '요즘은 그냥 죽고 싶다.'],
  ['소멸 소망', '그냥 사라지고 싶은 밤이 있다.'],
  ['자해 수단', '손목을 그은 흔적을 봤다.'],
]) eq(`🔴 M2 ${label} → 즉시 차단(경고 아님)`, gq.runGateOnLine(line).pass, false);

ok('M2 는 경고가 아니라 차단으로 기록된다',
  gq.runGateOnLine('그냥 사라지고 싶은 밤이 있다.').evidence.tier1_hits.some(h => h.rule === 'M2'));

// 넓게 잡되 위로 어휘까지 쓸어담지는 않는다 — 그러면 게이트가 아니라 발행 정지 장치가 된다.
for (const line of [
  '마음은 조금씩 나아진다.',
  '오늘은 그냥 쉬어도 괜찮다.',
  '아픈 마음을 견디는 데에도 시간이 든다.',
]) eq(`정상 위로 문장은 통과: ${line.slice(0, 12)}…`, gq.runGateOnLine(line).pass, true);

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ 시·무출처 인용 텍스트 규칙');

eq('시인 지목 → 차단', gq.runGateOnLine('시인 릴케는 이렇게 썼다.').pass, false);
eq('시집 인용 → 차단', gq.runGateOnLine('시집 「하늘과 바람과 별과 시」를 펼쳤다.').pass, false);
eq('무출처 인용 → 차단', gq.runGateOnLine('"우리는 사랑받기 위해 태어난 것이 아니다"라고 한다.').pass, false);
eq('출처를 붙이면 통과', gq.runGateOnLine('『데미안』에서 헤세는 "새는 알에서 나오려고 투쟁한다"고 썼다.').pass, true);
ok('"시간"·"무시" 같은 흔한 음절에는 발화하지 않는다',
  gq.runGateOnLine('시간이 지나면 무시당했던 기억도 옅어진다.').pass);

// 시 형태 휴리스틱은 **경고**다(휴리스틱은 틀릴 수 있고, 카드 본문은 원래 짧은 줄의 연속이다).
ok('짧은 행의 연속 → 시 형태 의심', Boolean(gq.poemShaped('바람이 분다\n살아야겠다')));
ok('긴 산문 줄은 시로 보지 않는다',
  gq.poemShaped('그는 오랫동안 아무 말도 하지 않은 채 창밖을 바라보고 있었다.\n그것이 마지막이었다.') === null);
const verseWarn = await gq.runGate(baseItem({ quote_ko: '바람이 분다\n살아야겠다', interpretation: INTERP }), { cfg: CFG, appendQueue: false });
ok('시 형태는 경고일 뿐 차단하지 않는다', verseWarn.evidence.tier2_warnings.some(w => w.rule === 'QW1'));

// ─────────────────────────────────────────────────────────────────────────────
section('⑦ 리뷰 큐 · 검사 범위');

const queued = await gq.runGate(baseItem({
  post_id: 'cn-2026-08-01-warned',
  quote_ko: '바람이 분다\n살아야겠다',
}), { cfg: CFG });
ok('경고가 있어도 통과', queued.pass, JSON.stringify(queued.evidence.tier1_hits));
ok('review-queue.jsonl 이 생성된다', existsSync(lib.reviewQueuePath()));
const rows = readFileSync(lib.reviewQueuePath(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
eq('🔴 gate 이름이 quote 로 남는다(어느 게이트의 경고인지 구분)', rows.at(-1).gate, 'quote');
eq('post_id 가 실린다', rows.at(-1).post_id, 'cn-2026-08-01-warned');
ok('reviewed_at 키가 존재한다', 'reviewed_at' in rows.at(-1));

// 캡션에만 숨은 위기 표현이 통과하면 게이트가 없는 것과 같다.
const hidden = await gq.runGate({
  ...baseItem(),
  caption_sections: { hook: '오늘의 문장', body: '요즘은 그냥 죽고 싶다는 생각뿐이다.', cta: '저장해두세요.' },
}, { cfg: CFG, appendQueue: false });
eq('🔴 캡션에 숨은 위기 표현도 차단', hidden.pass, false);
ok('필드 경로가 캡션으로 찍힌다',
  hidden.evidence.tier1_hits.some(h => h.rule === 'M2' && h.field.startsWith('caption_sections')),
  JSON.stringify(hidden.evidence.tier1_hits));

// ─────────────────────────────────────────────────────────────────────────────
section('⑧ LLM 0회 · exit 계약');

const src = readFileSync(new URL('../cardnews/gate-quote.mjs', import.meta.url), 'utf8');
ok('🔴 게이트 소스에 callClaude 호출이 없다', !/callClaude/.test(src));
ok('게이트 소스에 claude spawn 이 없다', !/execFile|spawnSync|'claude'/.test(src));

const itemPath = join(TMP, 'item.json');
writeFileSync(itemPath, JSON.stringify(baseItem()), 'utf8');
const fileRun = runCli(QUOTE_GATE, [itemPath]);
eq('파일 모드 정상 소재 exit 0', fileRun.code, 0);
eq('stdout 이 JSON 정확히 1줄', String(fileRun.stdout).trim().split('\n').length, 1);
eq('gate 이름이 실린다', fileRun.out?.gate, 'quote');

writeFileSync(itemPath, JSON.stringify(baseItem({ form: 'poem' })), 'utf8');
eq('파일 모드 위반 exit 1', runCli(QUOTE_GATE, [itemPath]).code, 1);

writeFileSync(itemPath, '{{{ 깨진 JSON', 'utf8');
const broken = runCli(QUOTE_GATE, [itemPath]);
eq('🔴 파싱 실패는 exit 2(통과도 차단도 아님)', broken.code, 2);
ok('오류 JSON 을 남긴다', Boolean(broken.out?.error));

eq('인자 없으면 exit 2', runCli(QUOTE_GATE, []).code, 2);
eq('--line 값 없으면 exit 2', runCli(QUOTE_GATE, ['--line']).code, 2);
eq('--line 정상 문장 exit 0', runCli(QUOTE_GATE, ['--line', '오늘은 그냥 쉬어도 괜찮다.']).code, 0);
eq('--line 위반 문장 exit 1', runCli(QUOTE_GATE, ['--line', '요즘은 그냥 죽고 싶다.']).code, 1);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
