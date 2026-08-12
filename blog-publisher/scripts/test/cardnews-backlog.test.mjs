#!/usr/bin/env node
/**
 * cardnews-backlog.test.mjs — Heron 🪶 소재 백로그 유닛테스트 (계획 §3.3 · Step 5)
 *
 * 증명하는 것:
 *   ① 프롬프트가 **heron BRIEF 로 시작**한다(AC-17) + 가드레일 문구가 실린다
 *   ② `ingest` 정규화 — 스키마 v2 필수 필드 결손 폐기 · problem sha1 dedup
 *   ③ 🔴 **저작권 안전 3종이 스키마 수준에서 강제된다**: 시(poem) 배제 · 대조 가능한
 *      원문 주소(화이트리스트) · translator 는 항상 null(기존 번역서 사용 정황이면 폐기)
 *   ④ `idOf` 결정론 — post_id 의 꼬리이므로 형식 계약이다
 *   ⑤ append 가 실제 JSONL 에 쓰이고 `loadBacklog` 로 되읽힌다
 *   ⑥ 예산 카운터 · claude 실패가 `err.diag` 로 나온다
 *
 * 🔴 **실 `claude -p` 를 절대 호출하지 않는다.** 이 레포는 CLI 다일 장애 이력이 문서화돼
 * 있고(R9 · 2026-07-25/26 6슬롯 전멸), 거기에 테스트를 걸면 무관한 이유로 빨개진다.
 * 네트워크도 0 이다(원문 대조는 factcheck 테스트에서 주입 스텁으로 검증한다).
 *
 * exit 0 = 전체 통과 / 1 = 실패.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-backlog-'));
process.env.STATE_DIR_OVERRIDE = TMP;   // 실 state/ 격리 — 반드시 import 전
process.env.RUN_MODE = 'mock';

const lib = await import('../cardnews/lib.mjs');
const bk = await import('../cardnews/backlog.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const CFG = lib.loadConfig();
const GUARD = '인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만';

const QUOTE_KO = '결국 독서만 한 즐거움은 없다고 나는 단언한다.';
const INTERP = '지금 네가 도망치고 있다고 느끼는 그 시간이, 오스틴이 보기에는 사람이 자기에게 돌려주는 유일한 몫이었다. 회피가 아니라 회복이다.';

const item = (problem, over = {}) => ({
  problem,
  situation: '답장이 늦어질수록 내가 뭘 잘못했는지 되짚게 되는 밤',
  quote_original: 'I declare after all there is no enjoyment like reading',
  quote_ko: QUOTE_KO,
  source: {
    title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813,
    fulltext_url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
  },
  form: 'novel',
  interpretation: INTERP,
  shift: '혼자 있는 시간을 도피로 부르던 자리에서, 그것이 회복이었다는 쪽으로',
  audience: '요즘 아무 말도 하기 싫은 사람에게',
  public_domain: true,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
section('① 프롬프트 — BRIEF 선두 주입 + 가드레일');

const brief = lib.loadAgentBrief('heron');
ok('heron BRIEF 가 비어있지 않다', brief.length > 100, `len=${brief.length}`);

const prompt = bk.buildBacklogPrompt(CFG, ['기존 문제 A'], 10);
ok('프롬프트가 heron BRIEF 로 시작한다', prompt.startsWith(brief), `head='${prompt.slice(0, 40)}…'`);
ok('프롬프트에 가드레일 문구가 실린다', prompt.includes(GUARD));
ok('프롬프트가 기존 문제를 중복 회피용으로 싣는다', prompt.includes('기존 문제 A'));
ok('프롬프트가 문제 축을 싣는다', CFG.channel.problem_axes.every(d => prompt.includes(d)));

// 🔴 이 채널에서 가장 현실적인 사고는 가짜 인용이다 — 프롬프트가 그것을 이름 불러 막는가.
ok('🔴 지어내지 말라는 지시가 있다', prompt.includes('지어내지 마라'));
ok('🔴 확신이 없으면 내지 말라는 비대칭이 명시된다', prompt.includes('그 후보를 내지 마라'));
ok('🔴 시(詩) 금지가 프롬프트에 있다', prompt.includes('시(詩) 금지'));
ok('🔴 저작권 만료 고전만이라고 못박는다', prompt.includes('저작권 만료 고전만'));
ok('🔴 인용 길이 상한이 프롬프트에 실린다', prompt.includes(`${CFG.quote.max_chars}자 이내`));
ok('🔴 출처 3종(제목·저자·원문주소)을 요구한다', prompt.includes('출처 3종 필수'));
ok('🔴 기존 번역서를 가져오지 말라고 지시한다', prompt.includes('기존 번역서의 문장을 가져오지 마라'));
ok('translator 가 항상 null 임을 명시한다', prompt.includes('translator 는 **항상 null**'));
ok('원문 대조가 어떻게 도는지 알려준다(의역·기억 재구성이 걸린다)',
  prompt.includes('문장 자체가 다르면 즉시 폐기') && prompt.includes('의역'));
ok('허용 호스트가 프롬프트에 실린다', CFG.quote.fulltext_hosts.every(h => prompt.includes(h)));
for (const f of ['problem', 'situation', 'quote_original', 'quote_ko', 'interpretation', 'shift', 'audience', 'fulltext_url']) {
  ok(`프롬프트가 ${f} 를 요구한다`, prompt.includes(f));
}
ok('해설이 인용보다 길어야 함을 비율로 알려준다', prompt.includes(`최소 ${CFG.quote.min_interpretation_ratio}배`));

// ─────────────────────────────────────────────────────────────────────────────
section('② ingest 정규화 · dedup');

const payload = JSON.stringify([
  item('내가 너무 많이 준 것 같을 때'),
  item('내가 너무 많이 준 것 같을 때'),                    // 완전 중복 → 1건만
  item('상황 결손', { situation: '' }),                     // 필수 결손 → 폐기
  { problem: '스키마 없음' },                               // 대부분 결손 → 폐기
  item('거절을 못 해서 나를 미룰 때'),
  'not-an-object',
]);
const seen = new Set();
const got = bk.ingest(payload, { seen, cfg: CFG });
eq('유효 2건만 남는다(중복1·결손2·비객체1 폐기)', got.length, 2);
ok('스키마 v2 필드가 모두 있다',
  got.every(g => ['id', 'problem', 'subject', 'situation', 'quote_original', 'quote_ko', 'source',
    'form', 'interpretation', 'shift', 'audience', 'public_domain', 'created_at'].every(k => k in g)),
  JSON.stringify(Object.keys(got[0] || {})));
ok('source 3종이 보존된다',
  got[0].source.title === '오만과 편견' && got[0].source.author === '제인 오스틴'
  && got[0].source.fulltext_url.includes('gutenberg.org'));
eq('🔴 translator 는 null 로 명시된다(키 누락이 아니다)', got[0].source.translator, null);
ok('translator 키가 실제로 존재한다', 'translator' in got[0].source);
eq('year 는 숫자로 정규화된다', got[0].source.year, 1813);
// 🔴 엔진 호환 슬롯 — run-cardnews.mjs(무수정)와 유사재탕 차단이 subject 키를 읽는다.
eq('🔴 subject 는 problem 의 미러(엔진 호환)', got[0].subject, got[0].problem);

for (const missing of ['problem', 'situation', 'quote_original', 'quote_ko', 'interpretation', 'shift', 'audience']) {
  const bad = item(`${missing} 없는 소재`);
  delete bad[missing];
  eq(`🔴 ${missing} 결손이면 폐기된다`, bk.ingest(JSON.stringify([bad]), { seen: new Set(), cfg: CFG }).length, 0);
  const blank = item(`${missing} 공백인 소재`, { [missing]: '   ' });
  eq(`${missing} 공백문자열도 폐기된다`, bk.ingest(JSON.stringify([blank]), { seen: new Set(), cfg: CFG }).length, 0);
}
for (const missing of ['title', 'author', 'fulltext_url']) {
  const bad = item(`source.${missing} 없는 소재`);
  delete bad.source[missing];
  eq(`🔴 source.${missing} 결손이면 폐기된다`, bk.ingest(JSON.stringify([bad]), { seen: new Set(), cfg: CFG }).length, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
section('③ 🔴 저작권 안전 3종 — 프롬프트가 아니라 스키마가 막는다');
//
// 프롬프트로 요구만 하고 여기서 안 막으면 실패가 조용해진다(이전 버티컬에서 실측). 그리고
// 이 셋은 "조용히 빠지면" 저작권 위험이 되는 항목이라, 모델의 준수에 걸어 둘 수 없다.

eq('🔴 form=poem 은 폐기된다(시는 스키마에 존재하지 않는다)',
  bk.ingest(JSON.stringify([item('시 소재', { form: 'poem' })]), { seen: new Set(), cfg: CFG }).length, 0);
eq('허용 form 밖(memoir)도 폐기', bk.ingest(JSON.stringify([item('회고록', { form: 'memoir' })]), { seen: new Set(), cfg: CFG }).length, 0);
ok('config 가 허용하는 form 은 통과',
  CFG.quote.allowed_forms.every(f => bk.ingest(JSON.stringify([item(`${f} 소재`, { form: f })]), { seen: new Set(), cfg: CFG }).length === 1));
ok('🔴 allowed_forms 에 poem 이 없다', !CFG.quote.allowed_forms.includes('poem'));

const badUrl = (u) => bk.ingest(JSON.stringify([item(`url ${u}`, { source: { ...item('x').source, fulltext_url: u } })]),
  { seen: new Set(), cfg: CFG }).length;
eq('🔴 화이트리스트 밖 호스트는 폐기(지어낸 URL 로 대조를 우회하지 못한다)',
  badUrl('https://quotes.example.com/austen.txt'), 0);
eq('http 스킴이 아니면 폐기', badUrl('ftp://gutenberg.org/x.txt'), 0);
eq('URL 형식이 아니면 폐기', badUrl('구텐베르크에서 확인 가능'), 0);
eq('허용 호스트는 통과', badUrl('https://www.gutenberg.org/cache/epub/1342/pg1342.txt'), 1);
ok('isAllowedFulltextUrl 는 서브도메인도 허용', bk.isAllowedFulltextUrl('https://gutenberg.org/x.txt', CFG));
ok('isAllowedFulltextUrl 는 유사 도메인을 거부', !bk.isAllowedFulltextUrl('https://gutenberg.org.evil.io/x.txt', CFG));

eq('🔴 translator 에 사람 이름이 있으면 폐기(기존 번역서 사용 정황)',
  bk.ingest(JSON.stringify([item('번역서 인용', { source: { ...item('x').source, translator: '김번역' } })]),
    { seen: new Set(), cfg: CFG }).length, 0);

// 인용 종속성 — 해설이 인용보다 충분히 길어야 정당한 인용이 된다(28조).
eq('🔴 해설이 인용보다 짧으면 폐기',
  bk.ingest(JSON.stringify([item('짧은 해설', { interpretation: '좋은 말이다.' })]), { seen: new Set(), cfg: CFG }).length, 0);
ok('interpretationLongEnough 는 config 비율을 읽는다(게이트와 같은 값)',
  bk.interpretationLongEnough({ quote_ko: '가'.repeat(10), interpretation: '나'.repeat(15) }, CFG)
  && !bk.interpretationLongEnough({ quote_ko: '가'.repeat(10), interpretation: '나'.repeat(14) }, CFG));

// hasQuoteSource — 읽는 쪽 판정. 옛 재고(세계 문화 스키마)를 죽이지 않고 구분만 한다.
ok('hasQuoteSource: 신규 항목은 true', bk.hasQuoteSource(got[0]));
ok('🔴 hasQuoteSource: 옛 재고는 false 지만 throw 하지 않는다',
  bk.hasQuoteSource({ subject: 'x', country: '일본', contrast: 'y' }) === false);
ok('hasQuoteSource: null 도 안전', bk.hasQuoteSource(null) === false);

// ─────────────────────────────────────────────────────────────────────────────
section('④ id · 파싱 복원력');

eq('id 는 problem sha1 10자', got[0].id, bk.idOf('내가 너무 많이 준 것 같을 때'));
eq('id 길이 10', got[0].id.length, 10);
ok('idOf 는 결정론적(공백 무관)', bk.idOf(' 같은 문제 ') === bk.idOf('같은 문제'));
ok('idOf 는 다른 problem 에 다른 id', bk.idOf('A') !== bk.idOf('B'));

eq('파싱 불가 응답은 빈 배열(런을 죽이지 않는다)', bk.ingest('완전 쓰레기', { seen: new Set() }).length, 0);
eq('배열 아닌 JSON 도 빈 배열', bk.ingest('{"a":1}', { seen: new Set() }).length, 0);
eq('seen 누적 dedup', bk.ingest(payload, { seen, cfg: CFG }).length, 0);

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ refillBacklog — append + 되읽기');

lib.resetClaudeCalls();
let seenPrompt = null;
const stub = (p) => { seenPrompt = p; return payload; };

const r1 = bk.refillBacklog({ n: 6, cfg: CFG, deps: { callClaude: stub } });
eq('added=2', r1.added, 2);
eq('total=2', r1.total, 2);
ok('backlog.jsonl 이 state/cardnews/backlog 아래에 생성된다',
  existsSync(lib.backlogPath()) && lib.backlogPath().includes(join('cardnews', 'backlog')), lib.backlogPath());
eq('loadBacklog 로 2건 되읽기', lib.loadBacklog().length, 2);
ok('스텁이 받은 프롬프트도 BRIEF 로 시작한다', seenPrompt.startsWith(brief));
ok('요청 개수 n 이 프롬프트에 반영된다', seenPrompt.includes('**6개**'));

const r2 = bk.refillBacklog({ n: 6, cfg: CFG, deps: { callClaude: stub } });
eq('재투입 시 added=0(기존 백로그와 dedup)', r2.added, 0);
eq('총계 유지', lib.loadBacklog().length, 2);
ok('보충 프롬프트가 기존 problem 을 회피 목록으로 싣는다', seenPrompt.includes('내가 너무 많이 준 것 같을 때'));

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ 예산 카운터 · 실패 진단');

lib.resetClaudeCalls();
eq('초기 0', lib.claudeCallCount(), 0);
for (let i = 0; i < 3; i++) lib.chargeClaudeCall({ cfg: CFG });
eq('3회 계상', lib.claudeCallCount(), 3);

lib.resetClaudeCalls();
let threw = null;
try { for (let i = 0; i < 5; i++) lib.chargeClaudeCall({ max: 3 }); } catch (e) { threw = e; }
ok('상한 초과 시 throw', threw !== null && /상한 초과/.test(threw.message), threw?.message);
eq('throw 시점 호출수 = 상한+1', threw?.budget?.calls, 4);

lib.resetClaudeCalls();
let exemptThrew = null;
try { for (let i = 0; i < 5; i++) lib.chargeClaudeCall({ max: 3, exempt: true }); } catch (e) { exemptThrew = e; }
ok('exempt 는 throw 하지 않는다', exemptThrew === null, exemptThrew?.message);
eq('🔴 exempt 여도 계상은 한다(F4 과소보고 방지)', lib.claudeCallCount(), 5);

lib.resetClaudeCalls();
const fakeExecFail = (bin) => {
  if (bin === 'claude') {
    const e = new Error('Command failed: claude -p');
    e.status = 1; e.stderr = ''; e.stdout = 'usage limit reached';
    throw e;
  }
  throw new Error('unexpected exec');
};
let diagErr = null;
try {
  lib.callClaude('x', {
    exec: fakeExecFail, retries: 0,
    versionProbe: () => ({ ok: true, version: 'test' }),
    onFailure: () => {}, max: 99, budgetMax: 99,
  });
} catch (e) { diagErr = e; }
ok('실패가 err.diag 를 달고 나온다', Boolean(diagErr?.diag), diagErr?.message);
eq('usage-limit 로 분류된다', diagErr?.diag?.kind, 'usage-limit');
eq('사람이 읽는 라벨이 붙는다', diagErr?.diag?.label, lib.FAILURE_LABELS['usage-limit']);
eq('진단 source 가 cardnews 경로', diagErr?.diag?.source, 'cardnews/callClaude');
eq('stdout 도 함께 본다(stderr 가 비어도 분류된다)', diagErr?.diag?.stderr_empty, true);
eq('실패해도 호출은 계상된다', lib.claudeCallCount(), 1);

lib.resetClaudeCalls();
const fakeExecOk = () => JSON.stringify({ subtype: 'success', is_error: false, result: '```json\n[]\n```' });
eq('성공 시 코드펜스가 벗겨진다', lib.callClaude('x', { exec: fakeExecOk, budgetMax: 9 }), '[]');

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
