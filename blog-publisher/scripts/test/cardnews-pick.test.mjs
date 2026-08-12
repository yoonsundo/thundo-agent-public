#!/usr/bin/env node
/**
 * cardnews-pick.test.mjs — Deer 🦌 best-pick 유닛테스트 (계획 §3.4 · Step 5)
 *
 * 증명하는 것:
 *   ① 프롬프트가 **deer BRIEF 로 시작**한다(AC-17) + 가드레일 문구
 *   ② 🔴 클램프는 **셋으로 좁다**(성별·유형 일반화 / 임상 조언 / 위기 조장). 모호어를 쓰면
 *      LLM 이 넓게 해석해 멀쩡한 소재가 게이트에 닿기도 전에 죽는다 — 실측된 실패다
 *   ③ 🔴 역압력: 뻔한 위로는 resonance ≤0.3. 안전한 쪽으로만 힘이 걸리면 평형점이 밋밋함이다
 *   ④ freshness 회전축은 **`problem`(문제 유형)** 이고, **같은 책은 감점하지 않는다**
 *      (같은 책이 여러 번 나오는 것은 이 채널의 정체성이다 — 옛 나라 백스톱은 제거됐다)
 *   ⑤ `scoreAll` 가중합·정렬, 미채점 후보의 중립 폴백
 *   ⑥ 유사 재탕 차단 · `pendingBacklog`(held 도 소비로 본다)
 *   ⑦ 채점 claude 가 죽어도 선정은 계속된다. 단 예산 초과는 그대로 던진다
 *
 * 🔴 실 `claude -p` 미사용 — 전부 `deps.callClaude` 스텁. 네트워크 0.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-pick-'));
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';

const lib = await import('../cardnews/lib.mjs');
const pk = await import('../cardnews/pick.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const near = (label, got, want) => ok(label, Math.abs(got - want) < 1e-9, `got=${got} want=${want}`);
const section = (s) => console.log(`\n${s}`);

const CFG = lib.loadConfig();
const GUARD = '인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만';

const it = (id, problem, book = '오만과 편견', author = '제인 오스틴') => ({
  id, problem, subject: problem,
  situation: '답장을 기다리다 밤을 새우는 장면',
  quote_original: 'I declare after all there is no enjoyment like reading',
  quote_ko: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
  source: { title: book, author, translator: null, year: 1813, fulltext_url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt' },
  form: 'novel',
  interpretation: '그 시간은 도피가 아니라 회복이었다는 것을, 오스틴은 농담처럼 흘려 말한다. 우리가 자기에게 돌려주는 유일한 몫이다.',
  shift: '자책하던 자리에서 한 걸음 옆으로',
  audience: '요즘 지쳐 보이는 사람에게',
  public_domain: true,
  created_at: '2026-08-01T00:00:00.000Z',
});

// ─────────────────────────────────────────────────────────────────────────────
section('① 프롬프트 — BRIEF 선두 주입 + 가드레일');

const brief = lib.loadAgentBrief('deer');
ok('deer BRIEF 가 비어있지 않다', brief.length > 100, `len=${brief.length}`);

const prompt = pk.buildScorePrompt([it('aaa', '내가 너무 많이 준 것 같을 때')]);
ok('프롬프트가 deer BRIEF 로 시작한다', prompt.startsWith(brief), `head='${prompt.slice(0, 40)}…'`);
ok('프롬프트에 가드레일 문구가 실린다', prompt.includes(GUARD));
ok('세 축이 모두 프롬프트에 있다', ['resonance', 'savability', 'clarity'].every(a => prompt.includes(a)));
ok('🔴 옛 축(surprise)은 남아 있지 않다(놀라움 ≠ 위로)', !prompt.includes('surprise'));
ok('후보 id 가 실린다', prompt.includes('"aaa"'));

// ── 🔴 클램프 좁히기 ────────────────────────────────────────────────────────
// 이 클램프는 **정규식 게이트보다 앞**에 있는 LLM 재량이다. 모호어("웃음거리" 같은)를 쓰면
// 판정이 넓어져 재미있는 소재가 게이트에 닿기도 전에 죽는다 — 이전 버티컬에서 실측됐다.
ok('클램프가 성별·유형 일반화 / 임상 조언 / 위기 조장 셋으로 좁혀졌다',
  prompt.includes('성별·연령·유형(MBTI 등)으로 사람을 묶거나')
  && prompt.includes('진단·치료·처방')
  && prompt.includes('위기 상황을 부추기면'));
ok('🔴 차단 사유가 셋뿐임을 명시한다', prompt.includes('차단 사유는 이 셋뿐이다'));
ok('🔴 슬프거나 세다는 이유로 깎지 말라는 반대 압력이 있다',
  /슬프거나 세거나 불편하다는 이유로 깎지 마라/.test(prompt));
ok('모호어를 쓰지 않는다(웃음거리 류)', !prompt.includes('웃음거리'));

// counter-pressure — 모든 힘이 안전한 쪽으로만 걸리면 평형점이 밋밋함이다.
ok('🔴 뻔한 위로에 resonance 상한을 건다', /resonance 0\.3 이하/.test(prompt));
ok('뻔함의 정의가 프롬프트에 있다',
  prompt.includes('이미 밈이 된 구절') && prompt.includes('결국 다 지나간다'));

// 같은 책 반복은 감점 사유가 아니라는 것이 채점자에게도 전달돼야 한다.
ok('🔴 같은 책 반복이 감점 사유가 아님을 알린다', prompt.includes('감점 사유가 아니다'));

// 인용·해설·전환이 채점자에게 보여야 resonance·savability 를 판정할 근거가 생긴다.
const p2 = pk.buildScorePrompt([it('bbb', '거절을 못 해서 나를 미룰 때')]);
for (const f of ['problem', 'situation', 'quote_ko', 'source', 'interpretation', 'shift', 'audience']) {
  ok(`채점 프롬프트가 ${f} 를 후보에 싣는다`, p2.includes(f));
}
ok('출처가 "제목 · 저자"로 실린다', p2.includes('오만과 편견 · 제인 오스틴'));
ok('옛 재고(필드 없음)도 빈 값으로 안전하게 직렬화된다',
  pk.buildScorePrompt([{ id: 'ccc', subject: '옛 소재' }]).includes('"quote_ko":""'));

// ─────────────────────────────────────────────────────────────────────────────
section('② 🔴 freshness — 회전축은 problem(문제 유형)이고, 책은 회전시키지 않는다');
//
// 같은 고민이 연달아 나오면 계정이 한 자리에 갇힌다. 반대로 같은 책이 여러 번 나오는 것은
// 결함이 아니라 정체성이다 — 한 작가를 계속 읽는 계정은 팔로우할 이유가 된다.
// 그래서 옛 버티컬의 "최근 N건이 전부 같은 나라면 감점" 백스톱은 통째로 제거됐다.

const prob = (p, book = '오만과 편견') => ({ problem: p, source: { title: book } });
const idx = {
  'cn-2026-08-03-c': { backlog_id: 'c', problem: '거절을 못 해서 나를 미룰 때', book: '데미안', published_at: '2026-08-03T00:00:00Z' },
  'cn-2026-08-02-b': { backlog_id: 'b', problem: '떠난 사람이 자꾸 생각날 때', book: '안나 카레니나', published_at: '2026-08-02T00:00:00Z' },
  'cn-2026-08-01-a': { backlog_id: 'a', problem: '내가 너무 많이 준 것 같을 때', book: '오만과 편견', published_at: '2026-08-01T00:00:00Z' },
};
const fresh = pk.freshnessMap(idx, []);
near('가장 최근 문제 = 0.4', fresh(prob('거절을 못 해서 나를 미룰 때')), 0.4);
near('두 번째 문제 = 0.6', fresh(prob('떠난 사람이 자꾸 생각날 때')), 0.6);
near('세 번째 문제 = 0.8', fresh(prob('내가 너무 많이 준 것 같을 때')), 0.8);
near('미사용 문제 = 1.0', fresh(prob('일이 끝나도 쉬어지지 않을 때')), 1.0);
near('문제 표기 흔들림(공백)은 같은 축으로 본다', fresh(prob('거절을  못 해서   나를 미룰 때')), 0.4);

// 🔴 같은 책이 계속 나와도 감점이 없다.
const monoBook = {};
for (let i = 0; i < 7; i++) {
  monoBook[`p${i}`] = { backlog_id: `p${i}`, problem: `문제${i}`, book: '오만과 편견', published_at: `2026-08-0${i + 1}T00:00:00Z` };
}
near('🔴 최근 7건이 전부 같은 책이어도 감점 없음(연재가 정체성이 된다)',
  pk.freshnessMap(monoBook, [])(prob('새 문제', '오만과 편견')), 1.0);
ok('🔴 나라/책 백스톱 상수가 제거됐다',
  pk.COUNTRY_BACKSTOP_WINDOW === undefined && pk.COUNTRY_BACKSTOP_FACTOR === undefined);

// 옛 재고 폴백 — problem 이 없으면 trigger_situation → domain 으로 돈다(회전축이 잠들지 않게).
const legacyFresh = pk.freshnessMap({
  x: { backlog_id: 'x', trigger_situation: '공항 환승', domain: '교통', published_at: '2026-08-03T00:00:00Z' },
}, []);
near('🔴 옛 재고는 trigger_situation 으로 폴백한다', legacyFresh({ trigger_situation: '공항 환승' }), 0.4);
eq('rotationKey 는 problem 을 우선한다',
  pk.rotationKey({ problem: '거절을 못 할 때', trigger_situation: '공항 환승' }), '거절을 못 할 때');
eq('rotationKey 는 없으면 옛 축으로 폴백', pk.rotationKey({ trigger_situation: '공항 환승' }), '공항 환승');
eq('rotationKey 는 아무것도 없으면 null', pk.rotationKey({}), null);

near('미발행 포스트는 이력에 들어가지 않는다',
  pk.freshnessMap({ x: { backlog_id: 'x', problem: '거절', published_at: null } }, [])(prob('거절')), 1.0);
// 백로그 역참조 — 인덱스에 problem 이 없어도 backlog_id 로 복원된다(buffer 경로 방어).
near('인덱스에 problem 이 없으면 백로그에서 복원한다',
  pk.freshnessMap({ x: { backlog_id: 'zz', published_at: '2026-08-03T00:00:00Z' } },
    [it('zz', '내가 너무 많이 준 것 같을 때')])(prob('내가 너무 많이 준 것 같을 때')), 0.4);

// ─────────────────────────────────────────────────────────────────────────────
section('③ scoreAll — 가중합·정렬·중립 폴백');

const items = [it('a1', '문제 하나'), it('b2', '문제 둘')];
const W = { resonance: 0.35, savability: 0.30, clarity: 0.20, freshness: 0.15 };
ok('config 가중치가 세 축 + freshness 로 갈렸다',
  Object.keys(CFG.pick.weights).join(',') === 'resonance,savability,clarity,freshness',
  Object.keys(CFG.pick.weights).join(','));

const sorted = pk.scoreAll({
  items,
  scores: [{ id: 'a1', resonance: 1, savability: 1, clarity: 1 }, { id: 'b2', resonance: 0, savability: 0, clarity: 0 }],
  freshOf: () => 1.0, weights: W,
});
eq('만점 후보가 1위', sorted[0].item.id, 'a1');
near('만점 total = 1.0', sorted[0].total, 1.0);
near('0점 후보 total = freshness 몫만', sorted[1].total, 0.15);

const neutral = pk.scoreAll({ items, scores: [{ id: 'a1', resonance: 1, savability: 1, clarity: 1 }], freshOf: () => 1.0, weights: W });
near('미채점 후보는 0 이 아니라 중립 0.5 로 산정된다', neutral.find(s => s.item.id === 'b2').total, 0.5 * 0.85 + 0.15);

const byFresh = pk.scoreAll({ items, scores: [], freshOf: (i) => (i.id === 'b2' ? 1.0 : 0.4), weights: W });
eq('채점이 통째로 없으면 freshness 로 순위가 갈린다', byFresh[0].item.id, 'b2');
ok('🔴 freshOf 는 항목 전체를 받는다(문제 축을 보려면 필수)', byFresh.every(s => Number.isFinite(s.freshness)));

// ─────────────────────────────────────────────────────────────────────────────
section('④ 유사 재탕 차단');

eq('조사·괄호·문장부호를 지운 정규화가 같은 계열을 한 문자열로 모은다',
  pk.normalizeSubject('내가 「너무 많이」 준 것 같을 때!'), pk.normalizeSubject('내가 너무 많이 준 것 같을 때'));
ok('완전 포함관계는 중복', pk.isNearDuplicate('내가 너무 많이 준 것 같을 때 (연애편)', ['내가 너무 많이 준 것 같을 때']).dup);
ok('문구만 바뀐 재탕은 중복(sha1 은 못 잡는다)',
  pk.isNearDuplicate('내가 너무 많이 준 것 같을 때', ['내가 너무 많이 주었던 것 같을 때']).dup);
ok('무관한 문제는 중복 아님',
  !pk.isNearDuplicate('일이 끝나도 쉬어지지 않을 때', ['내가 너무 많이 준 것 같을 때']).dup);
ok('빈 목록이면 중복 아님', !pk.isNearDuplicate('아무거나', []).dup);
ok('stripJosa 는 어간 2자를 보존한다', pk.stripJosa('밥은') === '밥은' && pk.stripJosa('마음을') === '마음');
eq('titleOf 는 problem 을 우선하고 subject 로 폴백',
  `${pk.titleOf({ problem: 'p', subject: 's' })}/${pk.titleOf({ subject: 's' })}`, 'p/s');

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ pendingBacklog — 인덱스 소비 판정');

const backlog = [it('a', '문제 A'), it('b', '문제 B'), it('c', '문제 C')];
const consumed = {
  'cn-2026-08-01-a': { backlog_id: 'a', status: 'published' },
  'cn-2026-08-02-b': { backlog_id: 'b', status: 'held', held_reason: 'factcheck:quote-not-found' },
};
const pending = pk.pendingBacklog({ backlog, index: consumed });
eq('미소비 1건만 남는다', pending.length, 1);
eq('남은 것은 c', pending[0].id, 'c');
ok('🔴 held 도 소비로 본다(매일 같은 소재가 슬롯을 독점하지 않게)', !pending.some(p => p.id === 'b'));
eq('빈 인덱스면 전건 pending', pk.pendingBacklog({ backlog, index: {} }).length, 3);

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ pick() — 스텁 경로 · 채점 실패 복원력 · 예산 초과 전파');

lib.appendBacklog(backlog);
lib.resetClaudeCalls();

const scoreStub = () => JSON.stringify([
  { id: 'a', resonance: 0.2, savability: 0.2, clarity: 0.2 },
  { id: 'b', resonance: 0.9, savability: 0.9, clarity: 0.9 },
  { id: 'c', resonance: 0.5, savability: 0.5, clarity: 0.5 },
]);
const r = pk.pick({ cfg: CFG, deps: { callClaude: scoreStub } });
eq('ok', r.ok, true);
eq('최고점 후보가 선정된다', r.pick.id, 'b');
eq('reason=ok', r.reason, 'ok');
ok('breakdown 이 상위 후보를 싣는다', Array.isArray(r.breakdown) && r.breakdown.length >= 3, JSON.stringify(r.breakdown?.length));
ok('breakdown 에 네 축이 모두 있다',
  ['resonance', 'savability', 'clarity', 'freshness'].every(k => k in r.breakdown[0]));
ok('breakdown 에 책·저자가 실린다(사람이 읽는 브리핑용)',
  r.breakdown[0].book === '오만과 편견' && r.breakdown[0].author === '제인 오스틴');

const rFail = pk.pick({ cfg: CFG, deps: { callClaude: () => { throw new Error('claude 실행 실패(network)'); } } });
eq('🔴 채점이 죽어도 선정은 계속된다(결방 방지)', rFail.ok, true);
ok('선정 결과가 있다', rFail.pick !== null);

let budgetErr = null;
try {
  pk.pick({ cfg: CFG, deps: { callClaude: () => { const e = new Error('budget: 런당 claude 호출 상한 초과(10/9)'); e.budget = { calls: 10, cap: 9 }; throw e; } } });
} catch (e) { budgetErr = e; }
ok('예산 초과는 삼키지 않고 던진다(폭주 방지)', budgetErr !== null && Boolean(budgetErr.budget), budgetErr?.message);

const stillThere = pk.pick({ cfg: CFG, deps: { callClaude: scoreStub } });
rmSync(lib.backlogPath(), { force: true });
const none = pk.pick({ cfg: CFG, deps: { callClaude: scoreStub } });
eq('후보 0건은 ok:true + pick:null', none.ok && none.pick === null, true);
eq('사유가 no-candidates', none.reason, 'no-candidates');
ok('후보가 있을 땐 pick 이 null 이 아니다', stillThere.pick !== null);

// ─────────────────────────────────────────────────────────────────────────────
section('⑦ 🔴 채점 분포 로그 — 클램프가 얼마나 자주 발화하는지 아무도 몰랐다');

const distItems = [it('d1', '뻔한 위로'), it('d2', '센 문제'), it('d3', '무채점')];
const distSorted = pk.scoreAll({
  items: distItems,
  scores: [
    { id: 'd1', resonance: 0.2, savability: 0.1, clarity: 0.2 },   // 클램프 발화(세 축 ≤0.2)
    { id: 'd2', resonance: 0.9, savability: 0.8, clarity: 0.7 },
  ],
  freshOf: () => 1.0, weights: W,
});
eq('클램프 판정 — 세 축 모두 ≤0.2', pk.isClamped(distSorted.find(s => s.item.id === 'd1')), true);
eq('센 후보는 클램프 아님', pk.isClamped(distSorted.find(s => s.item.id === 'd2')), false);
eq('🔴 미채점(중립 0.5)은 클램프로 세지 않는다(집계 오염 방지)',
  pk.isClamped(distSorted.find(s => s.item.id === 'd3')), false);
eq('뻔함 판정 — resonance ≤0.3', pk.isObvious(distSorted.find(s => s.item.id === 'd1')), true);

const summary = pk.summarizeScores(distSorted);
eq('후보 수', summary.candidates, 3);
eq('채점된 후보 수', summary.scored, 2);
eq('미채점 수', summary.unscored, 1);
eq('클램프 발화 건수', summary.clamped, 1);
ok('클램프된 id 가 남는다(어느 소재가 죽었는지 추적 가능)', summary.clamped_ids.includes('d1'));
eq('뻔함 건수', summary.obvious, 1);
eq('검증 가능한 인용을 가진 건수', summary.with_quote, 3);
ok('축별 통계가 있다', ['resonance', 'savability', 'clarity', 'freshness'].every(k => summary[k] && 'mean' in summary[k]));
near('resonance 평균', summary.resonance.mean, 0.55);
ok('선정 결과가 함께 기록된다', summary.picked?.id === 'd2');
ok('날짜(KST)가 기록된다', /^\d{4}-\d{2}-\d{2}$/.test(summary.date));
eq('빈 후보도 죽지 않는다', pk.summarizeScores([]).candidates, 0);
eq('빈 후보의 picked 는 null', pk.summarizeScores([]).picked, null);

lib.appendBacklog(backlog);
const rLog = pk.pick({ cfg: CFG, deps: { callClaude: scoreStub } });
ok('pick 결과에 distribution 이 실린다', Boolean(rLog.distribution));
ok('pick-scores.jsonl 이 runs.jsonl 의 형제로 생성된다',
  existsSync(lib.pickScoresPath()) && lib.pickScoresPath().endsWith('pick-scores.jsonl'), lib.pickScoresPath());
const logged = readFileSync(lib.pickScoresPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
ok('JSONL 1줄 이상이 append 된다', logged.length >= 1);
eq('마지막 줄이 이번 선정을 담는다', logged[logged.length - 1].picked.id, rLog.pick.id);
const before = logged.length;
pk.pick({ cfg: CFG, deps: { callClaude: scoreStub } });
eq('호출마다 1줄씩 누적된다(덮어쓰지 않는다)',
  readFileSync(lib.pickScoresPath(), 'utf8').trim().split('\n').length, before + 1);
pk.pick({ cfg: CFG, deps: { callClaude: scoreStub }, logScores: false });
eq('logScores:false 면 기록하지 않는다',
  readFileSync(lib.pickScoresPath(), 'utf8').trim().split('\n').length, before + 1);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
