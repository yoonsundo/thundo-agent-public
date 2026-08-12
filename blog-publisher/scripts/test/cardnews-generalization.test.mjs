#!/usr/bin/env node
/**
 * cardnews-generalization.test.mjs — 일반화 2단 게이트 (계획 §3.7 · AC-21 · Step 5)
 *
 * ⚠ 2026-07-31 축 교체(국명 → 성별·연령·유형)에 맞춰 갱신했다. 구조 단언(②~⑦)은 그대로
 * 두고 **축에 묶여 무효가 된 내용만** 바꿨다. 구 세계 문화 코퍼스는
 * `benchmark/cardnews/*.worldculture.bak` 로 보존돼 있다.
 *
 * 증명하는 것:
 *   ① 🔴 코퍼스 — `comfort-negative.txt` 중 **이 게이트가 소유한 8줄**(성별·유형 일반화·멸칭)
 *      전건 exit 1 · `comfort-negative-tier2.txt` 6줄 전건 exit 0+경고 ·
 *      `comfort-positive.txt` 15줄 전건 exit 0+무경고. **실제 CLI 를 spawn 해서** exit code 를
 *      확인한다 — 게이트의 계약은 반환값이 아니라 종료코드이고, 순수 함수만 호출하면
 *      `process.exit` 배선이 틀려도 초록으로 보인다.
 *      ⚠ 나머지 7줄(임상·위기·시·무출처 인용)은 `gate-quote.mjs` 소관이라 여기서 exit 0 이
 *      **정답**이다. 안전 레이어 전체의 "전건 차단"은 `cardnews-gate-quote.test.mjs` 가 두
 *      게이트를 합쳐 증명한다. 여기서 그것까지 요구하면 게이트 경계를 허무는 단언이 된다.
 *   ② 6줄 코퍼스가 "미탐 0"이라는 전칭명제를 증명하지 않는다는 것을 전제로, 5족(G1~G5)과
 *      3족(W1~W3)이 **각각 최소 1건씩** 발화하는지 확인한다(족 단위 커버리지)
 *   ③ TIER-2 는 **차단하지 않는다** — 경고가 있어도 exit 0. 넓은 규칙이 차단이면 사람이
 *      게이트를 꺼버린다
 *   ④ TIER-2 히트가 `review-queue.jsonl` 에 `reviewed_at` 필드와 함께 append 된다
 *   ⑤ 대본 스키마 전체(cover·cards·outro·caption_sections)가 검사 대상이다
 *   ⑥ **LLM 호출 0회** — 이 파일은 claude 를 import 하지도 spawn 하지도 않는다
 *   ⑦ exit 2 = 실행오류(판정 실패를 통과로도 차단으로도 보고하지 않는다)
 *   ⑧ 🔴 축 교체 자체 — 개인 지칭("그 남자는")은 차단하지 않고, 축 없는 일반화는 경고로 간다
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-gen-'));
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';

const lib = await import('../cardnews/lib.mjs');
const gg = await import('../cardnews/gate-generalization.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const CFG = lib.loadConfig();
const RULES = gg.rulesFromConfig(CFG);
const GATE = new URL('../cardnews/gate-generalization.mjs', import.meta.url).pathname;
const CORPUS = new URL('../../benchmark/cardnews/', import.meta.url).pathname;

const corpus = (f) => readFileSync(join(CORPUS, f), 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));

/** 실제 CLI spawn → {code, out}. 계약은 종료코드다. */
function runCli(args) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    encoding: 'utf8',
    env: { ...process.env, STATE_DIR_OVERRIDE: TMP, RUN_MODE: 'mock' },
  });
  let out = null;
  try { out = JSON.parse(String(r.stdout).trim().split('\n').filter(Boolean).pop()); } catch { /* 파싱 실패는 아래서 드러난다 */ }
  return { code: r.status, out, stdout: r.stdout };
}

// ─────────────────────────────────────────────────────────────────────────────
section('① 코퍼스 — 실제 CLI 종료코드');

const NEG = corpus('comfort-negative.txt');
const NEG2 = corpus('comfort-negative-tier2.txt');
const POS = corpus('comfort-positive.txt');

eq('comfort-negative.txt 15줄', NEG.length, 15);
eq('comfort-negative-tier2.txt 6줄', NEG2.length, 6);
eq('comfort-positive.txt 15줄', POS.length, 15);

// 이 게이트가 소유한 줄만 센다. exit 2(실행오류)는 어느 줄에서도 나오면 안 된다.
let blocked = 0, errored = 0;
for (const line of NEG) {
  const { code, out } = runCli(['--line', line]);
  if (code === 2) { errored++; ok(`실행오류: ${line.slice(0, 34)}…`, false, JSON.stringify(out)); continue; }
  if (code === 1 && out?.pass === false && out.evidence.tier1_hits.length > 0) blocked++;
}
eq('실행오류 0건', errored, 0);
// 🔴 정확한 수를 못박는다("8건 이상"이 아니라 "정확히 8건") — 느슨하게 두면 축이 넓어져
//    임상·시 문장까지 이 게이트가 잡기 시작해도 초록으로 보인다. 그건 축 오염이다.
eq('🔴 성별·유형 일반화·멸칭 8줄을 정확히 차단', blocked, 8);

let neg2Ok = 0;
for (const line of NEG2) {
  const { code, out } = runCli(['--line', line]);
  const good = code === 0 && out?.pass === true && out.evidence.tier1_hits.length === 0;
  if (good) neg2Ok++;
  else ok(`tier2 오판(차단하면 안 된다): ${line.slice(0, 34)}…`, false, `exit=${code} ev=${JSON.stringify(out?.evidence)}`);
}
eq(`🔴 comfort-negative-tier2.txt ${NEG2.length}/${NEG2.length} 차단 없음`, neg2Ok, NEG2.length);
// 6줄 중 5줄은 이 게이트의 경고(W1~W3), 1줄은 gate-quote 의 경고(QW1) 소관이다.
const warnedHere = NEG2.filter(l => runCli(['--line', l]).out?.evidence.tier2_warnings.length > 0).length;
eq('그중 5줄은 이 게이트가 경고를 남긴다', warnedHere, 5);

let posOk = 0;
for (const line of POS) {
  const { code, out } = runCli(['--line', line]);
  const good = code === 0 && out?.pass === true
    && out.evidence.tier1_hits.length === 0 && out.evidence.tier2_warnings.length === 0;
  if (good) posOk++;
  else ok(`positive 오탐: ${line.slice(0, 34)}…`, false, `exit=${code} ev=${JSON.stringify(out?.evidence)}`);
}
eq(`🔴 comfort-positive.txt ${POS.length}/${POS.length} exit 0 + 무경고`, posOk, POS.length);

// ─────────────────────────────────────────────────────────────────────────────
section('② 족 단위 커버리지 — G1~G5 · W1~W3 각 1건 이상');

const t1Rules = new Set();
for (const line of NEG) for (const h of gg.runGateOnLine(line, { rules: RULES }).evidence.tier1_hits) t1Rules.add(h.rule);
for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) ok(`TIER-1 ${g} 가 코퍼스에서 발화한다`, t1Rules.has(g), `발화=${[...t1Rules].sort().join(',')}`);

const t2Rules = new Set();
for (const line of NEG2) for (const w of gg.runGateOnLine(line, { rules: RULES }).evidence.tier2_warnings) t2Rules.add(w.rule);
for (const w of ['W1', 'W2', 'W3']) ok(`TIER-2 ${w} 가 코퍼스에서 발화한다`, t2Rules.has(w), `발화=${[...t2Rules].sort().join(',')}`);

// 코퍼스 구성 요건: 축 없는 케이스 전건 + 장거리 본질화 2건 이상.
const noAxis = NEG2.filter(l => gg.runGateOnLine(l, { rules: RULES }).evidence.tier1_hits.length === 0);
ok('tier2 코퍼스 전건이 축(TIER-1)에 걸리지 않는다', noAxis.length === 6, `${noAxis.length}/6`);
const longDist = NEG2.filter(l => gg.runGateOnLine(l, { rules: RULES }).evidence.tier2_warnings.some(w => w.rule === 'W3'));
ok('장거리 본질화(W3) 케이스 ≥2', longDist.length >= 2, `${longDist.length}건`);

// 스톱리스트 — 국민호칭이 아닌 `…인` 은 경고를 만들지 않는다(큐 잡음 방지).
for (const s of ['직장인은 다 바쁘다.', '노인은 모두 이 제도를 안다.', '연예인들은 항상 바쁘다.']) {
  eq(`스톱리스트: "${s.slice(0, 12)}…" 무경고`, gg.runGateOnLine(s, { rules: RULES }).evidence.tier2_warnings.length, 0);
}
ok('스톱리스트에 외국인·현지인은 없다(그 일반화는 감시 대상)',
  gg.runGateOnLine('외국인은 다 그렇다.', { rules: RULES }).evidence.tier2_warnings.length > 0);

// ─────────────────────────────────────────────────────────────────────────────
section('③ TIER-2 는 차단하지 않는다 / TIER-1 은 차단한다');

const warnOnly = gg.runGateOnLine('그런 사람들은 원래 다 그렇다.', { rules: RULES });
eq('TIER-2 만 있으면 pass=true', warnOnly.pass, true);
ok('경고는 남는다', warnOnly.evidence.tier2_warnings.length > 0);
ok('사유에 비차단임이 드러난다', /비차단/.test(warnOnly.reason), warnOnly.reason);

const blockedOne = gg.runGateOnLine('여자들은 다 속마음을 숨긴다.', { rules: RULES });
eq('TIER-1 이 있으면 pass=false', blockedOne.pass, false);
ok('사유에 규칙·필드가 드러난다', /G1@/.test(blockedOne.reason), blockedOne.reason);

// ─────────────────────────────────────────────────────────────────────────────
section('④ review-queue.jsonl — reviewed_at 필드');

const dirtyScript = {
  post_id: 'cn-2026-08-01-a1b2c3d4',
  cover: { headline: '내가 너무 많이 준 것 같을 때', sub: '『안나 카레니나』가 건네는 문장' },
  cards: [
    { index: 1, headline: '먼저 연락하는 쪽', body: '연락을 먼저 하는 쪽이 늘 손해처럼 느껴지는 날이 있다.' },
    { index: 2, headline: '애쓴 시간', body: '관계에서 애쓴 시간이 아깝게 느껴진다면 그만큼 진심이었다는 뜻이다.' },
    { index: 3, headline: '책의 말', body: '『안나 카레니나』에서 톨스토이는 불행에 저마다의 사정이 있다고 썼다.' },
    { index: 4, headline: '무슨 뜻인가', body: '지금 겪는 어긋남은 남과 비교해 설명될 수 있는 종류가 아니라는 뜻이다.' },
    { index: 5, headline: '정리', body: '덜 준 것도 더 준 것도 아니었다는 쪽으로 생각이 옮겨간다.' },
  ],
  outro: { headline: '저장해두세요', body: '요즘 지쳐 보이는 사람에게 보내도 좋습니다.' },
  caption_sections: {
    hook: '너무 많이 준 것 같을 때',
    body: '그런 사람들은 원래 다 그렇게 떠난다고들 하지만 실제로는 상황마다 다르다.',  // ← TIER-2
    cta: '저장해두고 지친 날 다시 보세요.',
  },
  hashtags: ['#위로', '#책속의문장'],
};

const gated = gg.runGate(dirtyScript, { cfg: CFG, rules: RULES });
eq('TIER-2 만 있으므로 통과', gated.pass, true);
ok('캡션에 숨은 일반화를 잡는다', gated.evidence.tier2_warnings.some(w => w.field.startsWith('caption_sections')),
  JSON.stringify(gated.evidence.tier2_warnings));

ok('review-queue.jsonl 이 생성된다', existsSync(lib.reviewQueuePath()), lib.reviewQueuePath());
const rows = readFileSync(lib.reviewQueuePath(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
eq('1줄 append', rows.length, 1);
ok('🔴 reviewed_at 키가 존재한다', 'reviewed_at' in rows[0]);
eq('초기값 null(= 아직 안 봤다)', rows[0].reviewed_at, null);
eq('post_id 가 실린다', rows[0].post_id, 'cn-2026-08-01-a1b2c3d4');
eq('gate 이름', rows[0].gate, 'generalization');
ok('경고 내용이 실린다', Array.isArray(rows[0].warnings) && rows[0].warnings.length > 0);
ok('필드 경로가 실린다', typeof rows[0].warnings[0].field === 'string');

// 무경고 대본은 큐를 건드리지 않는다.
const cleanScript = {
  ...dirtyScript,
  post_id: 'cn-2026-08-02-clean',
  caption_sections: { hook: '너무 많이 준 것 같을 때', body: '오늘 마음이 무거웠다면 그건 오래 참아왔기 때문이다.', cta: '저장해두세요.' },
};
const cleanGated = gg.runGate(cleanScript, { cfg: CFG, rules: RULES });
eq('무경고 대본은 통과', cleanGated.pass && cleanGated.evidence.tier2_warnings.length === 0, true);
eq('큐가 늘지 않는다', readFileSync(lib.reviewQueuePath(), 'utf8').split('\n').filter(Boolean).length, 1);

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ 검사 대상 범위 — 대본 스키마 전 필드');

const parts = gg.collectParts(dirtyScript);
const fields = parts.map(p => p.field);
for (const f of ['cover.headline', 'cover.sub', 'cards[1].headline', 'cards[1].body', 'cards[5].body',
  'outro.headline', 'outro.body', 'caption_sections.hook', 'caption_sections.body', 'caption_sections.cta']) {
  ok(`검사 대상에 ${f} 포함`, fields.includes(f), fields.join(','));
}
ok('해시태그는 검사 대상이 아니다(조사가 없어 규칙이 발화하지 않고 잡음만 는다)',
  !fields.some(f => f.includes('hashtag')));

// 각 필드에 심어도 각각 잡히는가.
for (const field of ['cover.headline', 'outro.body']) {
  const s = JSON.parse(JSON.stringify(cleanScript));
  if (field === 'cover.headline') s.cover.headline = '여자들은 다 그렇다';
  else s.outro.body = '여자들은 다 그렇다';
  const r = gg.runGate(s, { cfg: CFG, rules: RULES, appendQueue: false });
  ok(`${field} 에 심은 TIER-1 이 잡힌다`, r.pass === false && r.evidence.tier1_hits[0].field === field,
    JSON.stringify(r.evidence.tier1_hits));
}

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ LLM 호출 0회 · ⑦ exit 계약');

const src = readFileSync(new URL('../cardnews/gate-generalization.mjs', import.meta.url), 'utf8');
ok('🔴 게이트 소스에 callClaude 호출이 없다', !/callClaude/.test(src));
ok('게이트 소스에 claude spawn 이 없다', !/execFile|spawn|'claude'/.test(src));

// 파일 경로 모드 — 정상 대본은 exit 0.
const scriptPath = join(TMP, 'script.json');
writeFileSync(scriptPath, JSON.stringify(cleanScript), 'utf8');
const fileRun = runCli([scriptPath]);
eq('파일 모드 정상 대본 exit 0', fileRun.code, 0);
eq('stdout 이 JSON 정확히 1줄', String(fileRun.stdout).trim().split('\n').length, 1);
eq('gate 이름이 실린다', fileRun.out?.gate, 'generalization');

writeFileSync(scriptPath, '{{{ 깨진 JSON', 'utf8');
const brokenRun = runCli([scriptPath]);
eq('🔴 파싱 실패는 exit 2(통과도 차단도 아님)', brokenRun.code, 2);
ok('오류 JSON 을 남긴다', Boolean(brokenRun.out?.error));

eq('인자 없으면 exit 2', runCli([]).code, 2);

// 패턴 파일이 없어도 죽지 않는다(비하어 축만 남고 게이트는 계속 동작).
const noGroups = gg.buildRules({ groups: [], banned: ['짱깨'] });
eq('축 목록이 비면 G1~G4·G6 비활성', noGroups.hasGroups, false);
eq('그래도 G5 는 살아있다', gg.checkParts([{ field: 'x', text: '짱깨' }], noGroups).pass, false);
eq('축 목록이 비면 G1 은 발화하지 않는다',
  gg.checkParts([{ field: 'x', text: '여자들은 다 그렇다' }], noGroups).evidence.tier1_hits.length, 0);
ok('컴파일 불가 패턴은 graceful skip(전체를 죽이지 않는다)',
  gg.buildRules({ groups: ['여자', '(((깨진'], banned: [] }).hasGroups === true);

// ─────────────────────────────────────────────────────────────────────────────
section('⑧ 축 교체 — 사람 축이 실제로 걸리는가 / 개인 지칭은 빠지는가');

// 축 파일이 실재하고 규칙이 실제로 조립됐는가. (구 국명 축을 그대로 뒀다면 이 채널의
// 본문에는 국명이 없어 TIER-1 이 한 건도 발화하지 않았고, 코드는 경고조차 찍지 않았다.)
ok('사람 축 파일을 읽는다', /cardnews-groups\.txt$/.test(gg.groupsPath(CFG)), gg.groupsPath(CFG));
eq('축 규칙이 조립됐다', RULES.hasGroups, true);

for (const s of [
  '여자들은 다 결국 조건을 본다.',
  '남자는 원래 표현을 못 한다.',
  'INFP는 항상 상처를 삭인다.',
  '20대는 다 흔들린다.',
  'O형은 원래 덜렁댄다.',
  '회피형은 늘 먼저 도망친다.',
]) eq(`축 문형 차단: "${s.slice(0, 14)}…"`, gg.runGateOnLine(s, { rules: RULES }).pass, false);

// 🔴 개인 지칭은 일반화가 아니다. 국명 축에는 없던 오탐원이고, 하필 이 버티컬에서 가장
//    자주 쓰이는 문형이라 여기서 막히면 매일 발행이 죽는다.
for (const s of [
  '그 남자는 결국 아무 말도 하지 않았다.',
  '그 여자는 그날 이후로 연락하지 않았다.',
  '한 남자는 끝까지 사과하지 않았다.',
]) eq(`개인 지칭은 차단하지 않는다: "${s.slice(0, 14)}…"`, gg.runGateOnLine(s, { rules: RULES }).pass, true);

// 연애 버티컬의 일상 어휘가 축 토큰과 겹쳐도 걸리지 않아야 한다.
for (const s of [
  '남자친구가 연락을 줄인 뒤로 잠이 오지 않는다.',
  '여자친구에게 서운했던 말을 아직 꺼내지 못했다.',
  '20대에는 그런 실수를 할 수도 있다.',
]) eq(`인접 어휘 무반응: "${s.slice(0, 14)}…"`, gg.runGateOnLine(s, { rules: RULES }).evidence.tier1_hits.length, 0);

// ─────────────────────────────────────────────────────────────────────────────
section('배포 무결성 — 패턴 파일이 레포에 실려 있는가');
//
// 🔴 `loadLines` 는 파일이 없으면 **경고 한 줄만 남기고 빈 배열**을 준다(게이트가 죽지 않게).
// 그 폴백 자체는 옳지만, 파일을 커밋에서 빠뜨리면 클론에서 **규칙 0개로 전부 통과**하는
// 게이트가 된다 — 런은 초록이고 로그에만 warn 이 남아 아무도 모른다. 실제로 최초 커밋이
// config/cardnews-groups.txt·cardnews-banned-terms.txt·benchmark/cardnews/ 를 통째로
// 빠뜨렸다(2026-07-31). 위 ① 코퍼스 테스트는 이 파일들을 읽으므로 부재 시 터지지만,
// **규칙이 비어도 통과하는** 경로는 따로 막아야 한다.
{
  const g = gg.loadLines(gg.groupsPath(CFG));
  const b = gg.loadLines(gg.bannedTermsPath());
  ok('사람 축 목록이 비어있지 않다', g.length > 0, `${g.length}줄 — 0이면 일반화 게이트가 무력화된다`);
  ok('금칙어 목록이 비어있지 않다', b.length > 0, `${b.length}줄 — 0이면 금칙어 게이트가 무력화된다`);
  // 폴백이 왜 조용한지를 수치로 못박는다 — 목록이 비면 TIER-1 규칙이 **정확히 0개**가 되고,
  // 그 상태의 게이트는 무엇을 넣어도 통과시킨다.
  eq('빈 목록 → TIER-1 규칙 0개 (게이트 무력화)', gg.buildRules({ groups: [], banned: [] }).tier1.length, 0);
  // 개수를 상수로 박지 않는다(목록이 늘면 조용히 어긋난다). 대신 **규칙군이 전부 살아 있는지**를
  // 본다 — 축 파일만 빠져도 G1~G4·G6 이 통째로 사라지므로 이쪽이 실제 위험을 겨눈다.
  const families = new Set(RULES.tier1.map(r => r.id));
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6']) {
    ok(`실제 설정에 규칙군 ${g} 활성`, families.has(g), `활성=${[...families].join(',')}`);
  }
}

// 구 축·구 코퍼스는 지우지 않고 보존한다(버티컬을 되돌릴 수 있어야 한다).
for (const f of ['../../config/cardnews-countries.txt.worldculture.bak',
  '../../benchmark/cardnews/negative.txt.worldculture.bak',
  '../../benchmark/cardnews/positive.txt.worldculture.bak']) {
  ok(`구 세계 문화 파일 보존: ${f.split('/').pop()}`, existsSync(new URL(f, import.meta.url).pathname));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
