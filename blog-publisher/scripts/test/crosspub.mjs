#!/usr/bin/env node
/**
 * test/crosspub.mjs — 외부 교차발행 단위·통합 테스트 (실 LLM 호출 없음)
 *
 * 격리: mkdtemp 임시 디렉토리 + STATE_DIR_OVERRIDE / PUBLISHED_DIR_OVERRIDE /
 *       CROSSPUB_CONFIG_OVERRIDE / CROSSPUB_TEST_NO_AUDIT=1 (실 감사체인 보호).
 * 재작성 자체는 실 LLM 필수 계약이라 실행하지 않고 순수 함수만 검증한다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '../../');
const S = (p) => join(ROOT, 'scripts', 'crosspub', p);

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// ── 픽스처 ──────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'crosspub-test-'));
const stateDir = join(tmp, 'state');
const pubDir = join(tmp, 'published');
const cfgPath = join(tmp, 'crosspub.json');
mkdirSync(stateDir, { recursive: true });
mkdirSync(pubDir, { recursive: true });

const BASE = 'https://www.thundo.kr/blog';
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

const testCfg = {
  enabled: true, site_base_url: BASE, daily_cap: 3,
  similarity_band: { min: 0.3, max: 0.6 },
  mirror_lookback_days: 7,
  platforms: {
    tistory: { enabled: true, lang: 'ko', similarity_check: true },
    velog: { enabled: true, lang: 'ko', similarity_check: true },
    medium: { enabled: true, lang: 'en', similarity_check: false },
  },
  success_targets: { horizon_days: 90, followers_total: 100, referral_clicks_weekly: 30 },
};
writeFileSync(cfgPath, JSON.stringify(testCfg, null, 2));

// 미러 픽스처: 최근 발행 3건(alpha/beta/gamma) + lookback 밖 오래된 1건(old)
writeFileSync(join(pubDir, `${daysAgo(0)}-test-post-alpha.md`),
  `---\ntitle: "알파 글"\nslug: "test-post-alpha"\ndate: "${daysAgo(0)}"\n---\n\n## 본문\n알파 내용입니다.\n`);
writeFileSync(join(pubDir, `${daysAgo(1)}-test-post-beta.md`),
  `---\ntitle: "베타 글"\nslug: "test-post-beta"\ndate: "${daysAgo(1)}"\n---\n\n## 본문\n베타 내용입니다.\n`);
writeFileSync(join(pubDir, `${daysAgo(1)}-test-post-gamma.md`),
  `---\ntitle: "감마 글"\nslug: "test-post-gamma"\ndate: "${daysAgo(1)}"\n---\n\n## 본문\n감마 내용입니다.\n`);
writeFileSync(join(pubDir, `${daysAgo(20)}-test-post-old.md`),
  `---\ntitle: "옛 글"\nslug: "test-post-old"\ndate: "${daysAgo(20)}"\n---\n\n## 본문\n오래된 글.\n`);

const childEnv = {
  ...process.env, RUN_MODE: 'mock',
  STATE_DIR_OVERRIDE: stateDir, PUBLISHED_DIR_OVERRIDE: pubDir,
  CROSSPUB_CONFIG_OVERRIDE: cfgPath, CROSSPUB_TEST_NO_AUDIT: '1',
};
function runCli(script, args = [], env = childEnv) {
  const out = execFileSync(process.execPath, [S(script), ...args], { encoding: 'utf8', env, cwd: ROOT });
  return JSON.parse(out.trim().split('\n').pop());
}

// ── 단위: lib ───────────────────────────────────────────────────────────────
console.log('\n[1] lib.mjs 순수 함수');
const { urlToSlug } = await import(S('lib.mjs'));
ok(urlToSlug(`${BASE}/my-post`, BASE) === 'my-post', 'urlToSlug: 기본');
ok(urlToSlug(`${BASE}/my-post?utm=x#h`, BASE) === 'my-post', 'urlToSlug: query/hash 제거');
ok(urlToSlug('https://www.thundo.kr/about', BASE) === null, 'urlToSlug: 블로그 밖 → null');
ok(urlToSlug(`${BASE}/a/b`, BASE) === null, 'urlToSlug: 중첩 경로 → null');

// ── 단위: 미러 선별 ──────────────────────────────────────────────────────────
console.log('\n[2] select-candidate 미러 모드');
const { pickFreshCandidates } = await import(S('select-candidate.mjs'));
const { listPublishedSlugs } = await import(S('lib.mjs'));
// listPublishedSlugs 는 PUBLISHED_DIR_OVERRIDE 를 본다(childEnv 아닌 현 프로세스 env 설정)
process.env.PUBLISHED_DIR_OVERRIDE = pubDir;
const pubList = listPublishedSlugs();
ok(pubList.length === 4 && pubList[0].date >= pubList[3].date, 'listPublishedSlugs: 4건 최신순 파싱');

let r = pickFreshCandidates({ publishedList: pubList, cfg: testCfg, index: {} });
const slugs = r.candidates.map(c => c.slug);
ok(r.candidates.length === 3, 'mirror: cap=3 이내 최근 3건 선정');
ok(slugs.includes('test-post-alpha') && slugs.includes('test-post-beta') && slugs.includes('test-post-gamma'), 'mirror: 오늘·최근 3건 선정');
ok(!slugs.includes('test-post-old'), 'mirror: lookback(7일) 밖 옛 글 제외');

r = pickFreshCandidates({ publishedList: pubList, cfg: { ...testCfg, daily_cap: 2 }, index: {} });
ok(r.candidates.length === 2, 'mirror: daily_cap=2 → 2건');

const oneDone = { 'test-post-alpha': { platforms: { tistory: { status: 'posted' } } } };
r = pickFreshCandidates({ publishedList: pubList, cfg: { ...testCfg, platforms: { tistory: { enabled: true } } }, index: oneDone });
ok(r.candidates.length === 2 && !r.candidates.some(c => c.slug === 'test-post-alpha'), 'mirror: 이미 티스토리 게시된 글 제외(중복회피)');

r = pickFreshCandidates({ publishedList: [], cfg: testCfg, index: {} });
ok(r.candidates.length === 0 && /신규글 없음/.test(r.reason), 'mirror: 발행글 없으면 선정 없음');

// ── 단위: 재작성 순수 함수 ──────────────────────────────────────────────────
console.log('\n[3] rewrite 순수 함수');
const { buildPrompt, ensureBacklink, judgeSimilarity } = await import(S('rewrite.mjs'));
const bl = `${BASE}/test-post-alpha`;
const p1 = buildPrompt('tistory', { title: 'T' }, '본문', bl);
ok(p1.includes(bl) && p1.includes('티스토리'), 'buildPrompt: tistory 브리프+역링크 포함');
const p2 = buildPrompt('medium', { title: 'T' }, '본문', bl);
ok(/English/.test(p2) && /translation/.test(p2), 'buildPrompt: medium 영어 번역 재작성 지시');
let threw = false;
try { buildPrompt('naver', {}, '', bl); } catch { threw = true; }
ok(threw, 'buildPrompt: 미지원 플랫폼 throw (naver 포함 — 중단 유지)');

ok(ensureBacklink('본문 끝', bl).endsWith(`원문: ${bl}\n`), 'ensureBacklink: 누락 시 강제 추가');
const withLink = `본문\n\n원문: ${bl}\n`;
ok(ensureBacklink(withLink, bl) === withLink, 'ensureBacklink: 있으면 그대로');

const band = testCfg.similarity_band;
ok(judgeSimilarity('아무 원문', '완전 다른 글', { similarity_check: false }, band).verdict === 'SKIP', 'similarity: 교차언어 SKIP');
const sameText = '동일한 텍스트가 계속 반복되는 본문입니다. 동일한 텍스트가 계속 반복되는 본문입니다.';
ok(judgeSimilarity(sameText, sameText, { similarity_check: true }, band).verdict === 'FAIL', 'similarity: 복붙(j=1) → FAIL(상한 초과)');
ok(judgeSimilarity('가나다라마바사아자차카타파하 원문 텍스트', 'completely different english text here', { similarity_check: true }, band).verdict === 'FAIL', 'similarity: 과변형(j≈0) → FAIL(하한 미달)');
ok(judgeSimilarity(sameText, sameText, { similarity_check: true }, { min: 0, max: 1 }).verdict === 'PASS', 'similarity: 밴드 내 → PASS');

// ── 단위: auto-post 문서 변환 ───────────────────────────────────────────────
console.log('\n[3.5] auto-post toDoc');
const { toDoc } = await import(S('auto-post.mjs'));
const rawDoc = `---\nslug: x\ntitle: "FM 제목"\n---\n\n# 본문 제목\n\n## 소제목\n\n내용 문단.\n\n원문: ${bl}\n`;
const d1 = toDoc(rawDoc, null, ['AI']);
ok(d1.title === '본문 제목', 'toDoc: 첫 # 을 제목으로 분리');
ok(!d1.bodyMd.includes('# 본문 제목') && d1.bodyMd.includes('## 소제목'), 'toDoc: 본문에서 H1 제거, 이하 유지');
ok(d1.bodyHtml.includes('<h2>') && d1.bodyHtml.includes(bl), 'toDoc: HTML 변환 + 역링크 보존');
const d2 = toDoc(`---\ntitle: "FM만"\n---\n\n제목 헤딩 없는 본문.\n`, null, []);
ok(d2.title === 'FM만', 'toDoc: # 없으면 frontmatter title 폴백');

// ── 단위: 태그 (parseTags + toDoc 우선순위) ─────────────────────────────────
console.log('\n[3.6] 태그 처리');
const { parseTags } = await import(S('rewrite.mjs'));
ok(parseTags('["프롬프트 캐싱", "Claude API", "AI"]').join('|') === '프롬프트 캐싱|Claude API|AI', 'parseTags: JSON 배열');
ok(parseTags('AI, Claude, 자동화').join('|') === 'AI|Claude|자동화', 'parseTags: 쉼표 구분');
ok(parseTags('["AI","AI","Claude"]').length === 2, 'parseTags: 중복 제거');
ok(parseTags('').length === 0 && parseTags(null).length === 0, 'parseTags: 빈값·null → []');
ok(parseTags('["a","b","c","d","e","f","g","h","i","j","k"]').length === 10, 'parseTags: 최대 10개');
const dTags = toDoc(`---\ncrosspub_tags: AI, Claude, 자동화\ntitle: "T"\n---\n\n# 제목\n\n본문\n`, null, ['default1']);
ok(dTags.tags.join('|') === 'AI|Claude|자동화', 'toDoc: crosspub_tags 우선');
const dDefault = toDoc(`---\ntitle: "T"\n---\n\n# 제목\n\n본문\n`, null, ['default1', 'default2']);
ok(dDefault.tags.join('|') === 'default1|default2', 'toDoc: crosspub_tags 없으면 default 폴백');

// ── 단위: 카테고리 매핑 (pickCategory) ──────────────────────────────────────
console.log('\n[3.7] 카테고리 매핑');
const { pickCategory } = await import(S('rewrite.mjs'));
const catRules = [
  { category: 'AI 트레이딩', keywords: ['트레이딩', '퀀트', 'FinRL', '강화학습'] },
  { category: '자동화·생산성', keywords: ['자동화', 'GSC'] },
];
const catDef = 'AI 도구·개발';
ok(pickCategory({ title: 'LLM 트레이딩 샤프비율', tags: [] }, catRules, catDef) === 'AI 트레이딩', 'pickCategory: 제목 키워드 → 트레이딩');
ok(pickCategory({ title: '강화학습 주식 매매', tags: ['퀀트'] }, catRules, catDef) === 'AI 트레이딩', 'pickCategory: 태그 키워드도 매칭');
ok(pickCategory({ title: '반복 작업 자동화 복리', tags: [] }, catRules, catDef) === '자동화·생산성', 'pickCategory: 자동화 규칙');
ok(pickCategory({ title: 'Claude 프롬프트 캐싱 가이드', tags: ['Claude API'] }, catRules, catDef) === 'AI 도구·개발', 'pickCategory: 미매칭 → 기본');
ok(pickCategory({ title: 'x', tags: [] }, [], 'FB') === 'FB', 'pickCategory: 규칙 없으면 기본');
const dCat = toDoc(`---\ncrosspub_category: AI 트레이딩\ntitle: "T"\n---\n\n# 제목\n\n본문\n`, null, []);
ok(dCat.category === 'AI 트레이딩', 'toDoc: crosspub_category → doc.category');
const dNoCat = toDoc(`---\ntitle: "T"\n---\n\n# 제목\n\n본문\n`, null, []);
ok(dNoCat.category === null, 'toDoc: crosspub_category 없으면 null');

// ── 단위: 세션 판정 (judgeTistorySession) ───────────────────────────────────
console.log('\n[3.8] 세션 만료 판정');
const { judgeTistorySession } = await import(S('browser/context.mjs'));
ok(judgeTistorySession({ url: 'https://thundo.tistory.com/manage/newpost/?type=post', hasEditor: true }).valid === true, 'session: 에디터 있으면 유효');
ok(judgeTistorySession({ url: 'https://www.tistory.com/auth/login?redirectUrl=x', hasEditor: false }).valid === false, 'session: auth/login 리다이렉트 → 만료');
ok(judgeTistorySession({ url: 'https://accounts.kakao.com/login', hasEditor: false }).valid === false, 'session: 카카오 로그인 → 만료');
ok(judgeTistorySession({ url: 'https://thundo.tistory.com/manage/newpost/', hasEditor: false }).valid === false, 'session: 에디터 없으면 만료(쿠키 false positive 차단)');

// ── 단위: impact ────────────────────────────────────────────────────────────
console.log('\n[4] impact-report 순수 함수');
const { compareWindows } = await import(S('impact-report.mjs'));
const days = new Map([
  [daysAgo(10), { clicks: 10, impressions: 100, position: 5 }],
  [daysAgo(9), { clicks: 10, impressions: 100, position: 5 }],
  [daysAgo(2), { clicks: 1, impressions: 50, position: 9 }],
]);
const cw = compareWindows(days, daysAgo(7), 7);
ok(cw.pre.clicks === 20 && cw.post.clicks === 1, 'compareWindows: 전/후 윈도우 합산');
ok(cw.declined === true, 'compareWindows: 70% 이상 하락 → declined');
const cw2 = compareWindows(new Map([[daysAgo(10), { clicks: 2, impressions: 10, position: 5 }]]), daysAgo(7), 7);
ok(cw2.declined === false, 'compareWindows: 표본 부족(전 5클릭 미만) → 판단 유보');

// ── 통합: CLI (임시 state, 실 LLM 없음) ─────────────────────────────────────
console.log('\n[5] CLI 통합 (격리 state)');
let sel = runCli('select-candidate.mjs');
ok(sel.ok && Array.isArray(sel.candidates) && sel.candidates.length === 3, 'select CLI: 미러 3건 선정 JSON + exit 0');

// 전부 교차발행 기록 후 재실행 → 선정 없음(중복회피)
const allPosted = {};
for (const s of ['test-post-alpha', 'test-post-beta', 'test-post-gamma']) {
  allPosted[s] = { platforms: { tistory: { status: 'posted' }, velog: { status: 'posted' }, medium: { status: 'posted' } } };
}
writeFileSync(join(stateDir, 'crosspub-index.json'), JSON.stringify(allPosted, null, 2));
sel = runCli('select-candidate.mjs');
ok(sel.ok && sel.candidates.length === 0, 'select CLI: 전부 교차발행됨 → 선정 없음');

// 큐 전이: pending 파일 만들고 --mark-posted
const pendDir = join(stateDir, 'crosspub-queue', 'tistory', 'pending');
mkdirSync(pendDir, { recursive: true });
const pendName = `${today}-test-post-alpha.tistory.md`;
writeFileSync(join(pendDir, pendName),
  `---\nsource: published/${daysAgo(20)}-test-post-alpha.md\nslug: test-post-alpha\nplatform: tistory\nsource_url: ${bl}\n---\n\n재작성 본문\n\n원문: ${bl}\n`);
const mp = runCli('queue-status.mjs', ['--mark-posted', 'tistory', 'test-post-alpha', '--url', 'https://x.tistory.com/1']);
ok(mp.ok && mp.moved === pendName, 'mark-posted: pending 파일 매칭·이동');
ok(!existsSync(join(pendDir, pendName)) && existsSync(join(stateDir, 'crosspub-queue', 'tistory', 'posted', pendName)), 'mark-posted: posted/ 이동 확인');
const postedLog = readFileSync(join(stateDir, 'crosspub-queue', 'tistory', 'posted.jsonl'), 'utf8').trim();
ok(JSON.parse(postedLog).url === 'https://x.tistory.com/1', 'mark-posted: posted.jsonl 기록');
const idxAfter = JSON.parse(readFileSync(join(stateDir, 'crosspub-index.json'), 'utf8'));
ok(idxAfter['test-post-alpha'].platforms.tistory.status === 'posted' && idxAfter['test-post-alpha'].platforms.tistory.url, 'mark-posted: index posted 전이 + url');

// run-crosspub: disabled 정상 종료 (LLM 미호출 경로)
const offCfg = join(tmp, 'crosspub-off.json');
writeFileSync(offCfg, JSON.stringify({ ...testCfg, enabled: false }));
const off = runCli('run-crosspub.mjs', [], { ...childEnv, CROSSPUB_CONFIG_OVERRIDE: offCfg });
ok(off.ok && off.reason === 'crosspub disabled', 'run CLI: enabled=false → 무동작 정상 종료');

// ── 불변 검증: naver 원본 무수정 ────────────────────────────────────────────
console.log('\n[6] 네이버 기계 휴면 보존');
let naverClean = true;
try { execFileSync('git', ['diff', '--quiet', '--', 'scripts/naver', 'config/naver.json'], { cwd: ROOT }); }
catch { naverClean = false; }
ok(naverClean, 'scripts/naver/ + config/naver.json diff 0줄 (무수정)');
const naverCfg = JSON.parse(readFileSync(join(ROOT, 'config', 'naver.json'), 'utf8'));
ok(naverCfg.enabled === false, 'config/naver.json enabled=false 불변');

// ── 마무리 ──────────────────────────────────────────────────────────────────
rmSync(tmp, { recursive: true, force: true });
console.log(`\ncrosspub 테스트: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
