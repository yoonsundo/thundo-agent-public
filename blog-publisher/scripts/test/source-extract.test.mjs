#!/usr/bin/env node
/**
 * source-extract.test.mjs — 원문 발췌 추출기 스모크 (ralplan v6 S1)
 *
 * [1] 정제·절단(인젝션 방어) [2] allowlist [3] mock e2e(pool 병합·coverage·run.json)
 * [4] 드롭·부분 실패 [5] config degrade
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.RUN_MODE = 'mock';
const { sanitizeExcerpt, isAllowedUrl, loadSourcePackConfig, DEFAULTS, runExtract, extractOne } =
  await import('../lib/source-extract.mjs');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };
const eq  = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `${JSON.stringify(a)} != ${JSON.stringify(b)}`));

console.log('[1] 정제(인젝션 방어)·절단');
{
  const evil = '본문 시작\n---\ntitle: "위조 frontmatter"\n---\n```bash\nrm -rf /\n<script>x</script>\n제어문자\n\n\n\n끝';
  const clean = sanitizeExcerpt(evil, 8192);
  eq(/^---$/m.test(clean), false, '--- 단독 라인 제거(frontmatter 위조 차단)');
  eq(clean.includes('```'), false, '코드펜스 제거');
  eq(clean.includes('<script>'), false, 'HTML 태그 제거');
  eq(clean.includes(''), false, '제어문자 제거');
  eq(/\n{3,}/.test(clean), false, '3연속 개행 압축');

  const big = sanitizeExcerpt('한글텍스트'.repeat(5000), 1000);
  eq(Buffer.byteLength(big, 'utf8') <= 1000, true, '바이트 절단 상한');
  eq(big.includes('�'), false, '멀티바이트 경계 안전(깨진 문자 없음)');
}

console.log('[2] 도메인 allowlist');
{
  const allow = ['reddit.com', 'github.com'];
  eq(isAllowedUrl('https://www.reddit.com/r/x/1', allow), true, 'www 서브도메인 허용');
  eq(isAllowedUrl('https://old.reddit.com/r/x', allow), true, '서브도메인 허용');
  eq(isAllowedUrl('https://evil-reddit.com/x', allow), false, '유사 도메인 거부');
  eq(isAllowedUrl('https://naver.com/x', allow), false, 'allowlist 밖 거부');
  eq(isAllowedUrl('not-a-url', allow), false, '비정상 URL 거부');
}

console.log('[3] mock e2e (격리 cwd — pool 병합·coverage)');
const sb = mkdtempSync(join(tmpdir(), 'sx-'));
{
  const day = join(sb, 'runs', '2026-01-02');
  mkdirSync(join(day, 'topics'), { recursive: true });
  const pool = [
    { topic: 'A주제', channel: 'magpie', keep_me: 1, sources: [{ title: 'a', url: 'https://reddit.com/r/a' }] },
    { topic: 'B주제', channel: 'owl',    sources: [{ title: 'b', url: 'https://evil.com/b' }] },      // allowlist 밖
    { topic: 'C주제', channel: 'cheetah', sources: [{ title: 'c' }] },                                  // url 없음 → 분모 제외
  ];
  writeFileSync(join(day, 'topics', 'pool.json'), JSON.stringify(pool));
  writeFileSync(join(day, 'topics', 'selection.json'), JSON.stringify([
    { writer: 'beaver', pool_index: 0 }, { writer: 'fox', pool_index: 1 }, { writer: 'wolf', pool_index: 2 },
  ]));

  const cfg = { ...DEFAULTS, allow_domains: ['reddit.com'] };
  const r = await runExtract(join(day, 'topics', 'selection.json'), { cfg });
  eq(r.coverage, '1/2', 'coverage — url 보유 2편 중 1편 성공(분모에서 C 제외)');
  eq(existsSync(join(day, 'sources', 'beaver.json')), true, '팩 파일 sources/<writer>.json 생성');
  eq(existsSync(join(day, 'sources', 'fox.json')), false, 'allowlist 밖은 팩 미생성');
  eq(r.dropped.some(d => d.reason === 'allowlist-밖'), true, '드롭 사유에 allowlist-밖 기록');

  const mergedPool = JSON.parse(readFileSync(join(day, 'topics', 'pool.json'), 'utf8'));
  eq(mergedPool[0].keep_me, 1, 'pool 기존 필드 보존(읽기→병합→쓰기)');
  eq(typeof mergedPool[0].excerpt_file, 'string', 'pool[0]에 excerpt_file 기입');
  eq('excerpt_file' in mergedPool[1], false, '실패 항목엔 excerpt_file 없음');

  const run = JSON.parse(readFileSync(join(day, 'run.json'), 'utf8'));
  eq(run.excerpt_coverage, '1/2', 'run.json 에 excerpt_coverage 멱등 기입');

  const packSaved = JSON.parse(readFileSync(join(day, 'sources', 'beaver.json'), 'utf8'));
  eq(packSaved.entries.length >= 1 && packSaved.entries[0].excerpt.length > 20, true, '팩에 정제된 excerpt 실림');
}

console.log('[4] 실패 드롭 (live 모의 — fetchImpl 주입)');
{
  const day = join(sb, 'runs', '2026-01-03');
  mkdirSync(join(day, 'topics'), { recursive: true });
  writeFileSync(join(day, 'topics', 'pool.json'), JSON.stringify([
    { topic: 'X', sources: [{ title: 'x', url: 'https://reddit.com/r/x' }] },
  ]));
  writeFileSync(join(day, 'topics', 'selection.json'), JSON.stringify([{ writer: 'beaver', pool_index: 0 }]));
  // mock 이 아니라 fetchImpl 경로를 태우기 위해 extractOne 의 mock 판정을 우회해야 한다 →
  // runExtract 는 extractOne 내부 mock 판정을 쓰므로, 여기서는 RUN_MODE 를 지운 자식이 아니라
  // extractOne 단위로 검증한다(재시도 1회 후 드롭).
  let calls = 0;
  const failing = async () => { calls++; throw new Error('HTTP 500'); };
  const out = await extractOne('https://reddit.com/r/x', { ...DEFAULTS }, { mock: false, fetchImpl: failing });
  eq(out, null, '재시도 소진 후 null(드롭)');
  eq(calls, 2, '재시도 정확히 1회(총 2콜)');
}

console.log('[5] config degrade');
{
  const c = loadSourcePackConfig(join(sb, '없는파일.json'));
  eq(c.max_bytes, DEFAULTS.max_bytes, 'config 부재 → 내장 기본값');
  const broken = join(sb, 'broken.json');
  writeFileSync(broken, '{잘림');
  const c2 = loadSourcePackConfig(broken);
  eq(c2.enabled, DEFAULTS.enabled, 'config 손상 → 내장 기본값(throw 없음)');
}

console.log(`\n소스 추출 스모크: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
