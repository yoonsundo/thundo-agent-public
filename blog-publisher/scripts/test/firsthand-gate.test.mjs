#!/usr/bin/env node
/**
 * firsthand-gate.test.mjs — 게이트17(firsthand) 유닛테스트
 *
 * 검증 대상:
 *   (a) 조작된 1인칭 실행·측정·소유 주장을 잡는다
 *   (b) **정상 문장을 막지 않는다** — 의견·독자권유·부인·미래가정·출처귀속
 *       (과차단은 매일 발행 0편을 뜻한다. 이 축이 이 테스트의 절반이다)
 *   (c) frontmatter·코드블록은 판정에서 제외된다
 *   (d) 게이트 계약 — evaluate export / stdout JSON 1줄 / exit 0·1·2 / isMainModule 가드
 *   (e) run-all-gates 에 편입돼 있고, 기존 16개의 순서를 밀지 않았다
 *   (f) 실제 발행물 코퍼스에서 fail/pass 가 둘 다 나온다(전부 fail 이면 과차단, 전부 pass 면 무력)
 *
 * 네트워크·크리덴셜 불필요. 실 state 오염 없음(임시 디렉터리만 쓴다).
 * exit 0 = 전체 통과 / 1 = 실패.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '../../');
const GATE = join(ROOT, 'scripts/gates/check-firsthand.mjs');

// import 만으로 CLI 본체가 돌면 여기서 프로세스가 죽는다 — isMainModule 가드의 산증인이다.
const { evaluate, findClaims, CLAIM_THRESHOLD } = await import(GATE);

const TMP = mkdtempSync(join(tmpdir(), 'firsthand-gate-'));

let passN = 0, failN = 0;
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${extra ? ` — ${extra}` : ''}`); failN++; }
}

/** 본문만 주면 최소 frontmatter 를 붙여 임시 초안 파일을 만든다 */
let seq = 0;
function draft(body, frontmatter = 'title: "테스트 초안"\nwriter: "wolf"') {
  const p = join(TMP, `d${seq++}.md`);
  writeFileSync(p, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  return p;
}

const verdict = (body, fm) => evaluate(draft(body, fm));

// ─── (a) 조작 주장을 잡는다 ────────────────────────────────────────────────────

console.log('\n[a] 조작된 1인칭 실행·측정·소유 주장 → fail');

const MUST_FAIL = [
  ['제가 직접 실행 선언',   '제가 직접 스크립트를 돌려서 결과를 확인했습니다.'],
  ['돌려봤더니',            'Ollama로 로컬 에이전트를 돌려봤더니 코드 생성이 잘 됐어요.'],
  ['돌려보니',              '이 워크플로우를 3주간 돌려보니 정리 시간이 80% 줄었어요.'],
  ['써보니',                '한 달 동안 이렇게 써보니 비용이 30% 줄었습니다.'],
  ['써봤는데',              '저는 5월 한 달 동안 써봤는데, 통합 인박스가 강력했어요.'],
  ['측정해봤',              '전체 자동화를 단계별로 시간 측정해봤습니다. 로그인은 2초였어요.'],
  ['실측한 결과',           '4월 한 달간 메인으로 쓰면서 실측한 결과, 하루 15분이 절약됐어요.'],
  ['테스트해봤',            '실제로 테스트해봤더니 첫 재시도는 1초 대기였습니다.'],
  ['세어봤더니',            '구체적으로 세어봤더니 코드 120건 중 67건에서 문제가 났어요.'],
  ['타이머로 재봤',         '실제로 타이머로 재봤더니 도구 전환 한 번당 2분 47초가 걸렸어요.'],
  ['제 노트북(소유 장비)',  '제 노트북에서 자산 12개 최적화는 1초 안쪽으로 끝납니다.'],
  ['제 환경은(소유 환경)',  '제 환경은 우분투 22.04, 파이썬 3.10입니다.'],
  ['제 환경(괄호형)',       '제 환경(12코어)에서는 4개 이상 동시 실행하면 오히려 느려집니다.'],
  ['직접 설치하고 비교',    '두 오픈소스 트레이딩 봇을 직접 설치하고 비교했습니다.'],
  ['직접 테스트한',         '메모리 최적화까지 직접 테스트한 방법을 단계별로 보여드릴게요.'],
];
for (const [label, body] of MUST_FAIL) {
  const r = verdict(body);
  ok(label, r.pass === false, `pass=${r.pass} reason=${r.reason}`);
}

// ─── (b) 정상 문장을 막지 않는다 (과차단 방지) ────────────────────────────────

console.log('\n[b] 정상 문장 → pass (과차단하면 매일 발행 0편이 된다)');

const MUST_PASS = [
  ['의견 표명',             '제가 보기엔 이 방식이 더 안전합니다. 저는 A 쪽이라고 봅니다.'],
  ['제 생각엔',             '제 생각엔 에이전트를 늘리는 것보다 게이트를 조이는 게 낫습니다.'],
  ['독자 권유(보세요)',     '배포 전엔 스테이징에서 시나리오 3개를 직접 실행해보세요.'],
  ['독자 권유(봐야)',       '"얼마나 잘"은 직접 써봐야 알 수 있습니다.'],
  ['부인(못했다)',          'ZCode를 직접 써보진 못했습니다. 공개된 자료로만 판단했어요.'],
  ['부인(않았다)',          '제가 직접 백테스트를 돌려보진 않았지만, 구조는 타당해 보입니다.'],
  ['부인(쓰진 않아서)',     '저도 직접 OpenAI API를 대량으로 쓰진 않아서 체감은 제한적입니다.'],
  ['조건 제시(다면)',       '로컬 LLM 에이전트를 돌려봤다면 이제 도구를 확장해보세요.'],
  ['미래 가정(할 기회)',    '제가 ZCode를 직접 테스트할 기회가 생기면 다시 다루겠습니다.'],
  ['부사적 직접 비교',      'Alpha Arena와 별개 실험이라 직접 비교는 어려워요.'],
  ['출처 귀속 수치',        '공식 문서 기준 타임아웃은 30초입니다. 릴리스 노트에 따르면 컨텍스트는 200K예요.'],
  ['조건부 비교',           '파일이 10개를 넘으면 A가 유리하고, 단일 파일 작업이면 B가 낫습니다.'],
  ['제3자 실행 귀속',       '논문이 26만 거래일 실증에 돌린 결과는 통계적으로 유의미하지 않았습니다.'],
  ['평범한 how-to 서술',    '먼저 Node.js 20을 설치합니다. 그다음 설정 파일에 API 키를 넣으면 됩니다.'],
];
for (const [label, body] of MUST_PASS) {
  const r = verdict(body);
  ok(label, r.pass === true, `pass=${r.pass} claims=${JSON.stringify(r.evidence.claims)}`);
}

// '논문이 ... 돌린 결과' 는 통과시키지만, 같은 문장에 1인칭이 붙으면 잡아야 한다.
ok('제3자 귀속에 숨긴 1인칭은 잡는다',
   verdict('공식 문서에 따르면 30초지만, 제가 직접 돌려봤더니 48초였어요.').pass === false);

// ─── (c) frontmatter·코드블록 제외 ────────────────────────────────────────────

console.log('\n[c] frontmatter·코드블록은 판정 대상이 아니다');

ok('frontmatter 안 표현은 무시',
   evaluate(draft('공식 문서 기준 30초입니다.', 'title: "직접 써본 후기"\ntags: ["실측"]')).pass === true);

ok('코드블록 안 표현은 무시',
   verdict('설정은 아래와 같습니다.\n\n```bash\n# 제가 직접 돌려봤더니\nnpm run gate\n```\n\n공식 문서 기준 30초입니다.').pass === true);

// ─── (d) 게이트 계약 ──────────────────────────────────────────────────────────

console.log('\n[d] 게이트 계약 (evaluate / stdout JSON 1줄 / exit 0·1·2)');

ok('CLAIM_THRESHOLD 는 1 (한 건도 허용 안 함)', CLAIM_THRESHOLD === 1, `got=${CLAIM_THRESHOLD}`);

const passPath = draft('공식 문서 기준 타임아웃은 30초입니다.');
const failPath = draft('제가 직접 돌려봤더니 48초가 걸렸어요.');

const runCli = (arg) => spawnSync(process.execPath, arg === undefined ? [GATE] : [GATE, arg],
  { encoding: 'utf8', cwd: ROOT });

const cliPass = runCli(passPath);
ok('통과 시 exit 0', cliPass.status === 0, `status=${cliPass.status} stderr=${cliPass.stderr}`);
{
  const lines = cliPass.stdout.trim().split('\n');
  ok('stdout 은 JSON 1줄', lines.length === 1, `lines=${lines.length}`);
  let parsed = null;
  try { parsed = JSON.parse(lines[0]); } catch { /* 아래 단언에서 걸린다 */ }
  ok('JSON 파싱 가능 + gate 이름 firsthand', parsed?.gate === 'firsthand', `got=${parsed?.gate}`);
  ok('pass 필드는 boolean', typeof parsed?.pass === 'boolean');
}

const cliFail = runCli(failPath);
ok('판정 실패 시 exit 1', cliFail.status === 1, `status=${cliFail.status}`);
ok('실패 이유에 대체 지침이 담긴다', /출처 귀속/.test(JSON.parse(cliFail.stdout.trim()).reason));

const cliMissing = runCli(join(TMP, 'nope-does-not-exist.md'));
ok('없는 파일은 실행오류 exit 2 (판정실패 1과 구분)', cliMissing.status === 2, `status=${cliMissing.status}`);

const cliNoArg = runCli(undefined);
ok('인자 없으면 exit 2', cliNoArg.status === 2, `status=${cliNoArg.status}`);

let threw = false;
try { evaluate(join(TMP, 'nope-does-not-exist.md')); } catch { threw = true; }
ok('evaluate 는 읽기 실패 시 throw (조용한 pass 금지)', threw);

// ─── (e) run-all-gates 편입 ───────────────────────────────────────────────────

console.log('\n[e] run-all-gates 편입 + 기존 순서 보존');

const runAllSrc = readFileSync(join(ROOT, 'scripts/gates/run-all-gates.mjs'), 'utf8');
ok('check-firsthand 를 import 한다', /from\s+'\.\/check-firsthand\.mjs'/.test(runAllSrc));
ok('GATES 목록에 firsthand 가 있다', /\['firsthand',/.test(runAllSrc));
{
  // 결과 배열 순서가 계약이다 — 새 게이트는 맨 뒤여야 기존 인덱스가 안 밀린다.
  const names = [...runAllSrc.matchAll(/^\s*\['([a-z-]+)',/gm)].map(m => m[1]);
  ok('firsthand 는 마지막에 붙었다', names[names.length - 1] === 'firsthand', `order=${names.join(',')}`);
  ok('기존 16종이 그대로 앞에 있다', names.length === 17 && names[15] === 'source-fidelity', `n=${names.length}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
ok('package.json 에 gate:firsthand 등록', typeof pkg.scripts['gate:firsthand'] === 'string');
ok('package.json 에 test:firsthand 등록', typeof pkg.scripts['test:firsthand'] === 'string');

// ─── (f) 실제 발행물 코퍼스 ───────────────────────────────────────────────────

console.log('\n[f] 실제 발행물 코퍼스 — 양쪽 판정이 다 나오는가');

const pubDir = join(ROOT, 'published');
if (!existsSync(pubDir)) {
  console.log('  [SKIP] published/ 없음');
} else {
  const files = readdirSync(pubDir).filter(f => f.endsWith('.md')).sort();
  let fails = 0, passes = 0;
  for (const f of files) {
    (evaluate(join(pubDir, f)).pass ? () => passes++ : () => fails++)();
  }
  console.log(`  코퍼스 ${files.length}편 → fail ${fails} / pass ${passes}`);
  ok('조작이 있는 편이 실제로 걸린다', fails > 0, `fails=${fails}`);
  ok('조작이 없는 편은 통과한다(전량 차단 아님)', passes > 0, `passes=${passes}`);
  // 전량 차단은 과차단의 신호다. 절반 넘게 깨끗해야 한다는 뜻이 아니라,
  // "한 편도 못 통과한다"면 패턴이 망가진 것이다.
  ok('통과 비율이 10% 이상 (과차단 조기경보)', passes / files.length >= 0.1,
     `ratio=${(passes / files.length).toFixed(3)}`);
}

// ─── findClaims 직접 검사 ─────────────────────────────────────────────────────

console.log('\n[g] findClaims 반환 형태');
{
  const claims = findClaims('제가 직접 돌려봤더니 48초였고, 제 노트북에서는 20분 걸렸습니다.');
  ok('종류가 execution / owned_environment 로 구분된다',
     claims.some(c => c.kind === 'execution') && claims.some(c => c.kind === 'owned_environment'),
     JSON.stringify(claims));
  ok('문맥이 함께 실린다(사람이 판정 근거를 볼 수 있게)',
     claims.every(c => typeof c.context === 'string' && c.context.length > 0));
}

// ─── 정리 ────────────────────────────────────────────────────────────────────

rmSync(TMP, { recursive: true, force: true });

console.log(`\n결과: ${passN} 통과 / ${failN} 실패`);
process.exit(failN === 0 ? 0 : 1);
