#!/usr/bin/env node
/**
 * cardnews-brief.test.mjs — 카드뉴스 에이전트 정의 5종 (계획 §3.18 · AC-16/AC-17 · Step 5)
 *
 * 🔴 버티컬 전환(2026-07-31)으로 마스코트가 갈렸다:
 *    camel→**heron**(발굴) · albatross→**deer**(선정) · tortoise→**hedgehog**(인용검증)
 *    · flamingo→**robin**(대본) · orca→**firefly**(총괄).
 *    옛 정의는 `.claude/agents/*.md.worldculture.bak` 에 보존돼 있다(되돌릴 수 있어야 한다).
 *
 * 증명하는 것:
 *   ① 5개 정의가 존재하고 frontmatter(name·description·tools·model)가 §3.18 표와 일치
 *   ② 🔴 SEED·BRIEF 마커가 **세 갈래 독립 검사**로 확인된다. 합산 카운트 한 번으로 세면
 *      `SEED:locked` 가 3줄이고 BRIEF 블록이 **하나도 없는** 파일이 통과한다. 마커가 없으면
 *      `loadAgentBrief` 가 조용히 빈 문자열을 돌려주고, 페르소나 없는 프롬프트가 그대로 나가도
 *      아무 데서도 실패하지 않는다 — 그래서 이 검사는 존재 자체가 방어선이다
 *   ③ 🔴 가드레일 문구가 **4개 콘텐츠 에이전트**의 BRIEF **안**에 문자열로 실재한다
 *   ④ 🔴 **네 단계 프롬프트 빌더가 각자 자기 BRIEF 로 시작한다** — 하나만 확인하면 나머지
 *      셋이 페르소나 없이 나가도 통과한다. 네 개를 각각 단언한다
 *   ⑤ BRIEF 가 실질적 내용을 담는다(플레이스홀더 방지)
 *   ⑥ firefly 는 조율만 — "직접 창작하지 않는다"가 정의에 실재한다
 *   ⑦ 🔴 옛 마스코트 정의가 **삭제가 아니라 보존**됐다(버티컬 되돌리기 경로)
 *
 * 네트워크·크리덴셜 불필요. exit 0 = 전체 통과 / 1 = 실패.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-brief-'));
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';

const lib = await import('../cardnews/lib.mjs');
const bk = await import('../cardnews/backlog.mjs');
const pk = await import('../cardnews/pick.mjs');
const fcm = await import('../cardnews/factcheck.mjs');
const sc = await import('../cardnews/script.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);

const CFG = lib.loadConfig();
const GUARD = '인용 날조·사람 일반화·치료 조언 금지, 원문에서 확인된 문장만';
const AGENTS_DIR = new URL('../../.claude/agents/', import.meta.url).pathname;

/** §3.18 표. `content: true` = 가드레일 문구를 BRIEF 에 담아야 하는 에이전트. */
const SPEC = [
  { name: 'heron', tools: 'Read, Write, Bash', script: 'scripts/cardnews/backlog.mjs', content: true },
  { name: 'deer', tools: 'Read, Bash', script: 'scripts/cardnews/pick.mjs', content: true },
  { name: 'hedgehog', tools: 'Read, Bash', script: 'scripts/cardnews/factcheck.mjs', content: true },
  { name: 'robin', tools: 'Read, Write, Bash', script: 'scripts/cardnews/script.mjs', content: true },
  { name: 'firefly', tools: 'Read, Bash, Glob, Grep', script: 'scripts/cardnews/run-cardnews.mjs', content: false },
];

const raw = {};
for (const s of SPEC) {
  const p = join(AGENTS_DIR, `${s.name}.md`);
  raw[s.name] = existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ─────────────────────────────────────────────────────────────────────────────
section('① 파일 존재 + frontmatter');

for (const s of SPEC) {
  const t = raw[s.name];
  ok(`${s.name}.md 존재`, t !== null);
  if (!t) continue;
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  ok(`${s.name}: frontmatter 블록`, Boolean(fm));
  const body = fm ? fm[1] : '';
  ok(`${s.name}: name 일치`, new RegExp(`^name:\\s*${s.name}\\s*$`, 'm').test(body));
  ok(`${s.name}: description 존재`, /^description:\s*\S/m.test(body));
  ok(`${s.name}: tools = ${s.tools}`, new RegExp(`^tools:\\s*${s.tools.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(body),
    body.match(/^tools:.*$/m)?.[0]);
  ok(`${s.name}: model = claude-sonnet-4-5`, /^model:\s*claude-sonnet-4-5\s*$/m.test(body));
}

// ─────────────────────────────────────────────────────────────────────────────
section('② 마커 — 세 갈래 독립 검사(합산 카운트 금지)');

for (const s of SPEC) {
  const t = raw[s.name] || '';
  const seedOpen = /<!--\s*SEED:locked\s*-->/.test(t);
  const seedClose = /<!--\s*\/SEED:locked\s*-->/.test(t);
  const briefStart = /<!--\s*BRIEF:start\s*-->/.test(t);
  const briefEnd = /<!--\s*BRIEF:end\s*-->/.test(t);

  ok(`${s.name}: (a) <!-- SEED:locked --> 존재`, seedOpen);
  ok(`${s.name}: (b) <!-- /SEED:locked --> 존재`, seedClose);
  ok(`${s.name}: (c) BRIEF start·end 가 쌍으로 존재`, briefStart && briefEnd, `start=${briefStart} end=${briefEnd}`);

  if (seedOpen && seedClose) ok(`${s.name}: SEED 마커 순서`, t.indexOf('<!-- SEED:locked -->') < t.indexOf('<!-- /SEED:locked -->'));
  if (briefStart && briefEnd) ok(`${s.name}: BRIEF 마커 순서`, t.indexOf('<!-- BRIEF:start -->') < t.indexOf('<!-- BRIEF:end -->'));

  ok(`${s.name}: SEED 블록에 실행 경로 명시`, t.includes(s.script), s.script);
  // 계약 섹션은 **분리형이 저장소 표준**이다 — meerkat 준수 감사 R6/R7 이
  //   `## 입력 계약` 과 `## 출력 계약` 을 각각 요구하고, lion·beaver·bee·eagle·penguin·
  //   elephant·crane·meerkat 등 이미 준수인 에이전트가 전부 그 형식이다(결합형 0개).
  //   이 단언은 카드뉴스 5인에만 결합형(`## 입력·출력 계약`)을 강제해 R6/R7 과 정면
  //   충돌했다 — 2026-08-21 에 둘을 동시에 만족시킬 수 없다는 것이 실제로 드러났다.
  //   단언의 의도는 "역할·계약·원칙 섹션이 있는가" 이므로 두 형식 모두 받는다.
  const hasContract = t.includes('## 입력·출력 계약')
    || (t.includes('## 입력 계약') && t.includes('## 출력 계약'));
  ok(`${s.name}: 역할·계약·원칙 섹션`, ['## 역할', '## 원칙'].every(h => t.includes(h)) && hasContract);
}

// ─────────────────────────────────────────────────────────────────────────────
section('③ loadAgentBrief 추출 + 가드레일 문구(BRIEF 블록 안)');

const briefs = {};
for (const s of SPEC) {
  const b = lib.loadAgentBrief(s.name);
  briefs[s.name] = b;
  ok(`${s.name}: loadAgentBrief 가 비어있지 않다`, b.length > 0, `len=${b.length}`);
  ok(`${s.name}: 플레이스홀더가 아니다(200자 이상)`, b.length >= 200, `len=${b.length}`);
  ok(`${s.name}: 마커 자체는 추출물에 남지 않는다`, !b.includes('BRIEF:'));
  ok(`${s.name}: SEED 문구가 BRIEF 에 섞이지 않는다`, !b.includes('SEED:locked'));
}

for (const s of SPEC.filter(x => x.content)) {
  ok(`🔴 ${s.name}: 가드레일 문구가 **BRIEF 블록 안**에 실재`, briefs[s.name].includes(GUARD),
    `BRIEF 내 미발견(파일 전체 포함 여부=${(raw[s.name] || '').includes(GUARD)})`);
}
eq('가드레일을 담는 콘텐츠 에이전트는 정확히 4개',
  SPEC.filter(x => briefs[x.name].includes(GUARD)).length, 4);

// ─────────────────────────────────────────────────────────────────────────────
section('④ 🔴 네 단계 프롬프트 빌더가 각자 자기 BRIEF 로 시작한다');

const ITEM = {
  id: 'a1b2c3d4e5', problem: '내가 너무 많이 준 것 같을 때',
  situation: '답장을 기다리는 밤',
  quote_original: 'I declare after all there is no enjoyment like reading',
  quote_ko: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
  source: { title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813,
    fulltext_url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt' },
  form: 'novel',
  interpretation: '그 시간은 도피가 아니라 회복이었다는 것을 오스틴은 농담처럼 말한다.',
  shift: '자책하던 자리에서 한 걸음 옆으로', audience: '요즘 지쳐 보이는 사람에게',
};

const BUILDERS = [
  { stage: 'backlog(heron)', agent: 'heron', prompt: bk.buildBacklogPrompt(CFG, [], 10) },
  { stage: 'pick(deer)', agent: 'deer', prompt: pk.buildScorePrompt([ITEM]) },
  { stage: 'factcheck(hedgehog)', agent: 'hedgehog', prompt: fcm.buildPrompt(ITEM, { context: '…enjoyment like reading…' }) },
  { stage: 'script(robin)', agent: 'robin', prompt: sc.buildScriptPrompt(ITEM, CFG) },
];

for (const b of BUILDERS) {
  ok(`${b.stage}: 프롬프트가 ${b.agent} BRIEF 로 시작한다`,
    b.prompt.startsWith(briefs[b.agent]), `head='${b.prompt.slice(0, 50)}…'`);
  ok(`${b.stage}: 가드레일 문구가 프롬프트에 실린다`, b.prompt.includes(GUARD));
  for (const other of BUILDERS.filter(x => x.agent !== b.agent)) {
    ok(`${b.stage}: ${other.agent} 페르소나로 시작하지 않는다`, !b.prompt.startsWith(briefs[other.agent]));
  }
}
eq('빌더 4개를 모두 검사했다', BUILDERS.length, 4);

// ─────────────────────────────────────────────────────────────────────────────
section('⑤ 페르소나 실질 — 테마·역할 반영');

ok('heron: 물가에서 한 문장을 건진다', /물가|건져|기다/.test(briefs.heron));
ok('🔴 heron: 지어내지 말라는 것이 페르소나에 있다', /지어내|날조/.test(briefs.heron));
ok('🔴 heron: 시(詩) 배제가 페르소나에 있다', /시\(詩\)/.test(briefs.heron));
ok('🔴 heron: 번역을 직접 한다(번역자 저작권)', /직접|번역자의 저작권/.test(briefs.heron));
ok('deer: 멈춰 서는 짐승', /멈추|멈춰/.test(briefs.deer));
ok('🔴 deer: 뻔한 위로를 막는 역압력이 페르소나에 있다', /뻔한 위로/.test(briefs.deer));
ok('hedgehog: 확신 없으면 웅크린다', /웅크리|확신이 없으면/.test(briefs.hedgehog));
ok('🔴 hedgehog: 실재 판정은 기계 몫임이 페르소나에 있다', /기계가 원문|대조 결과/.test(briefs.hedgehog));
ok('🔴 hedgehog: 구절을 고쳐 쓰지 말라는 규칙이 있다', /구절은 절대 고쳐 쓰지 마라|정정이 아니라 차단/.test(briefs.hedgehog));
ok('robin: 겨울에도 노래하는 새', /겨울|노래/.test(briefs.robin));
ok('🔴 robin: 6번 전환이 전부임이 페르소나에 있다', /노력의 문제가 아니었다/.test(briefs.robin));
ok('🔴 robin: 인용을 한 글자도 바꾸지 말라', /한 글자도 바꾸지 마라/.test(briefs.robin));
ok('🔴 firefly: 직접 창작하지 않는다(조율만)', /직접 창작하지 않는다|길을 대신 걸어/.test(briefs.firefly));
ok('firefly 정의(SEED)에도 조율 전용이 못박혀 있다', /조율만 한다|직접 창작하지 않는다/.test(raw.firefly || ''));
ok('firefly 는 발행 스위치를 켜지 않는다', /publish\.enabled/.test(raw.firefly || ''));
ok('hedgehog 는 차단권만임이 정의에 있다', /차단권만/.test(raw.hedgehog || ''));

eq('미존재 에이전트는 빈 문자열 폴백', lib.loadAgentBrief('없는에이전트'), '');
eq('withBrief 는 페르소나 없으면 원문 그대로', lib.withBrief('없는에이전트', 'X'), 'X');
ok('withBrief 는 페르소나를 선두에 붙인다', lib.withBrief('heron', 'X').startsWith(briefs.heron));
ok('withBrief 결과가 원문으로 끝난다', lib.withBrief('heron', 'X').endsWith('\n\nX'));

// ─────────────────────────────────────────────────────────────────────────────
section('⑥ 🔴 옛 마스코트는 삭제가 아니라 보존 — 버티컬을 되돌릴 수 있어야 한다');

for (const old of ['camel', 'albatross', 'tortoise', 'flamingo', 'orca']) {
  ok(`${old}.md.worldculture.bak 로 보존됐다`, existsSync(join(AGENTS_DIR, `${old}.md.worldculture.bak`)));
  ok(`${old}.md 는 활성 정의에서 내려갔다(서브에이전트 혼선 방지)`, !existsSync(join(AGENTS_DIR, `${old}.md`)));
  eq(`loadAgentBrief('${old}') 는 빈 문자열(더 이상 주입되지 않는다)`, lib.loadAgentBrief(old), '');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failN === 0 ? 'PASS' : 'FAIL'} — ${passN} passed, ${failN} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(failN === 0 ? 0 : 1);
