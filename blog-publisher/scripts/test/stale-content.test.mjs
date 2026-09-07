#!/usr/bin/env node
/**
 * stale-content.test.mjs — 노출 0 발행글 분류기 유닛테스트
 *
 * 이 도구의 산출물은 "지워도 되는 글 목록"으로 읽힌다. 그래서 검증의 무게는
 * **틀린 분류가 사람을 잘못된 삭제로 이끌지 않는가**에 둔다. 세 축이다.
 *
 *  ① 파싱이 조용히 틀리지 않는가 — frontmatter 태그가 세 가지 모양으로 섞여 있고,
 *     못 읽으면 "태그 없음"이 되어 merge 판정이 통째로 무너진다(실측 8편).
 *  ② 0 과 null 을 구분하는가 — 수집 결손일은 "노출 0회"가 아니라 "모른다".
 *     네이버 rank=null 도 "순위 없음"이 아니라 display 상한 밖이라 모르는 것이다.
 *  ③ 최근 글이 drop 으로 새지 않는가 — 색인될 시간이 없던 글을 지우면 되돌릴 수 없다.
 *
 * 순수 함수 + 임시 디렉터리만 쓴다. 실 네트워크·크리덴셜 불필요. exit 0/1.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';

import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const M = await import('../seo/stale-content.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// ── 1. frontmatter 리스트 파싱 (실제 published/ 에 있는 세 가지 모양) ────────
console.log('\n[1] frontmatter 리스트 파싱');
const fmJson  = '---\ntitle: "A"\ntags: ["자동화", "생산성"]\n---\n본문\n';
const fmFlow  = '---\ntitle: "B"\ntags: [팩터투자, AI에이전트, 퀀트]\n---\n본문\n';
const fmBlock = '---\ntitle: "C"\ntags:\n  - 퀀트트레이딩\n  - 백테스트\ndescription: "x"\n---\n본문\n';
eq('JSON 배열', M.readListField(fmJson, 'tags'), ['자동화', '생산성']);
eq('따옴표 없는 flow 리스트', M.readListField(fmFlow, 'tags'), ['팩터투자', 'AI에이전트', '퀀트']);
eq('블록 리스트', M.readListField(fmBlock, 'tags'), ['퀀트트레이딩', '백테스트']);
ok('블록 리스트는 다음 키에서 멈춘다', !M.readListField(fmBlock, 'tags').includes('x'));
eq('없는 필드는 빈 배열', M.readListField(fmJson, 'nope'), []);
eq('frontmatter 없으면 빈 배열', M.readListField('그냥 본문', 'tags'), []);

// ── 2. URL → slug (목록·태그 URL 을 글로 오인하면 노출 집계가 통째로 틀린다) ─
console.log('\n[2] URL → slug');
eq('글 URL', M.slugFromUrl('https://www.thundo.kr/blog/my-post'), 'my-post');
eq('말미 슬래시', M.slugFromUrl('https://www.thundo.kr/blog/my-post/'), 'my-post');
eq('목록 URL 은 글이 아니다', M.slugFromUrl('https://www.thundo.kr/blog'), null);
eq('태그 URL 은 글이 아니다', M.slugFromUrl('https://www.thundo.kr/blog?tag=Claude'), null);
eq('홈은 글이 아니다', M.slugFromUrl('https://www.thundo.kr/'), null);
eq('퍼센트 인코딩 복원', M.slugFromUrl('https://www.thundo.kr/blog/%ED%95%9C%EA%B8%80'), '한글');

// ── 3. 수집 커버리지 — 결손일을 0 으로 뭉개지 않는가 ─────────────────────────
console.log('\n[3] 수집 커버리지 (0 vs 모름)');
const cov = M.coverageOf(['2026-09-01', '2026-09-02', '2026-09-05', '2026-09-02']);
eq('중복 날짜는 한 번만', cov.collectedDays, 3);
eq('결손일을 빠짐없이 센다', cov.missingDays, ['2026-09-03', '2026-09-04']);
eq('빈 입력은 0 이 아니라 null 로 남긴다', M.coverageOf([]).first, null);

// ── 4. GSC 집계 — 같은 (날짜,차원) 중복 줄에서 마지막이 이기는가 ─────────────
console.log('\n[4] GSC 집계 (last-wins · 이중계산 금지)');
const tmp = mkdtempSync(join(tmpdir(), 'stale-'));
const metricsPath = join(tmp, 'seo-metrics.jsonl');
writeFileSync(metricsPath, [
  // 같은 날짜·차원이 두 줄. 계약상 **뒤 줄이 이긴다** — 합치면 20 이 된다.
  JSON.stringify({ date: '2026-08-01', dimension: 'page', rows: [{ key: 'https://www.thundo.kr/blog/alpha', impressions: 8, clicks: 0, position: 9 }] }),
  JSON.stringify({ date: '2026-08-01', dimension: 'page', rows: [{ key: 'https://www.thundo.kr/blog/alpha', impressions: 12, clicks: 1, position: 5 }] }),
  JSON.stringify({ date: '2026-08-02', dimension: 'page', rows: [{ key: 'https://www.thundo.kr/blog', impressions: 99, clicks: 9, position: 3 }] }),
  JSON.stringify({ date: '2026-08-03', dimension: 'query', rows: [{ key: 'q', impressions: 5, clicks: 0, position: 1 }] }),
].join('\n') + '\n', 'utf8');
const { loadSeoMetrics } = await import('../seo/gsc-collect.mjs');
const gscReal = M.collectGscExposure(loadSeoMetrics(metricsPath));
eq('중복 줄을 합치지 않는다(마지막이 이긴다)', gscReal.bySlug.get('alpha').impressions, 12);
eq('목록 URL 은 slug 로 잡히지 않는다', gscReal.bySlug.size, 1);
eq('page 차원만 커버리지에 센다', gscReal.coverage.collectedDays, 2);
eq('최고 순위는 최솟값', gscReal.bySlug.get('alpha').bestPosition, 5);

// ── 5. 네이버 — rank=null 은 "0위"가 아니라 "모름" ───────────────────────────
console.log('\n[5] 네이버 순위 (null 은 노출 아님)');
const naver = M.collectNaverExposure([
  JSON.stringify({ date: '2026-08-01', query: 'q1', ranks: [{ type: 'webkr', rank: null, url: null }] }),
  JSON.stringify({ date: '2026-08-02', query: 'q2', ranks: [{ type: 'blog', rank: 7, url: 'https://www.thundo.kr/blog/beta' }] }),
  JSON.stringify({ date: '2026-08-03', query: 'q3', ranks: [{ type: 'webkr', rank: 3, url: 'https://www.thundo.kr/blog/beta' }] }),
  '깨진 줄 {',
].join('\n'));
eq('null 순위는 노출로 안 센다', naver.bySlug.has('q1'), false);
eq('최고 순위는 최솟값', naver.bySlug.get('beta').bestRank, 3);
eq('쿼리를 근거로 남긴다', naver.bySlug.get('beta').queries.sort(), ['q2', 'q3']);
eq('깨진 줄은 조용히 버린다(전체가 죽지 않는다)', naver.bySlug.size, 1);

// ── 6. 유예 기준일 — 달력이 아니라 **실측된 날 수**로 센다 ──────────────────
console.log('\n[6] 유예 기준일 (결손일을 0회로 뭉개지 않는다)');
// 결손 없이 매일 수집: 08-25~09-07 = 14일 → 08-25 발행글이 딱 자격을 갖춘다.
const dense = [];
for (let d = new Date('2026-08-01T00:00:00Z'); d <= new Date('2026-09-07T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  dense.push(d.toISOString().slice(0, 10));
}
// 두 기준 중 **이른 쪽**이 이긴다(=유예가 넓어지는 쪽). 08-25 는 실측 14일을 채우지만
// 달력으로는 13일차라 아직 이르다 → 08-24 가 기준일이 된다.
eq('결손 없으면 달력 기준이 이긴다',
  M.graceCutoff({ today: '2026-09-07', gscDates: dense, graceDays: 14 }), '2026-08-24');
// 같은 구간인데 격일 수집(=절반 결손)이면 14일치를 모으려면 두 배 뒤로 가야 한다.
const sparse = dense.filter((_, i) => i % 2 === 0);
const sparseCutoff = M.graceCutoff({ today: '2026-09-07', gscDates: sparse, graceDays: 14 });
ok('결손이 있으면 유예가 더 길어진다(더 보수적)', sparseCutoff < '2026-08-25', `cutoff=${sparseCutoff}`);
eq('유예 기준일은 뒤에서 graceDays 번째 수집일', sparseCutoff, sparse[sparse.length - 14]);
// 수집일 자체가 14일이 안 되면 "판단 자격 0편" 이다. 여기서 가장 이른 수집일을 돌려주면
// 그보다 앞선 옛 글이 "판단 완료"로 새어나가 drop 으로 간다 — 0 과 모름을 섞는 사고다.
eq('수집일이 graceDays 보다 적으면 기준일은 0 이 아니라 null',
  M.graceCutoff({ today: '2026-09-07', gscDates: ['2026-09-01', '2026-09-02'], graceDays: 14 }), null);
{
  const thin = { bySlug: new Map(), coverage: { first: '2026-09-01', last: '2026-09-02', collectedDays: 2, missingDays: [], dates: ['2026-09-01', '2026-09-02'] } };
  const r = M.classify({
    posts: [{ slug: 'ancient', date: '2026-01-01', title: '아주 오래된 글', tags: ['잡담'] }],
    gsc: thin, naver: { bySlug: new Map(), coverage: { dates: [] } }, today: '2026-09-07',
  });
  eq('수집 부족이면 옛 글도 drop 으로 새지 않는다', r.drop.length, 0);
  ok('전원 유예로 간다', r.improve.some(x => x.slug === 'ancient' && x.grace_period === true));
}
eq('수집 이력이 없으면 달력만(첫 실행 폴백)',
  M.graceCutoff({ today: '2026-09-07', gscDates: [], gscLast: null, graceDays: 14 }), '2026-08-24');

// ── 7. 유사도 — 같은 소재는 잡고, 남남은 안 잡는가 ───────────────────────────
console.log('\n[7] 유사도');
const corpusPosts = [
  { title: 'n8n 자동화 초보가 빠지는 함정 3가지', tags: ['n8n', '자동화'] },
  { title: 'n8n 자동화 워크플로우 유지보수 가이드', tags: ['n8n', '자동화'] },
  { title: '고전문학으로 읽는 위로의 문장', tags: ['문학'] },
  { title: '백테스트 슬리피지 4단계 모델링', tags: ['백테스트'] },
];
const corpus = M.tokenDocFreq(corpusPosts.map(M.topicText));
const same = M.topicPair(corpusPosts[0], corpusPosts[1], corpus);
const diff = M.topicPair(corpusPosts[0], corpusPosts[2], corpus);
ok('같은 소재 쌍이 남남 쌍보다 높다', same.topic > diff.topic, `same=${same.topic} diff=${diff.topic}`);
ok('같은 소재 쌍은 merge 관문을 넘는다', M.isSameTopic(same, M.DEFAULTS) !== null, JSON.stringify(same));
eq('남남 쌍은 안 넘는다', M.isSameTopic(diff, M.DEFAULTS), null);
ok('공유 내용어가 1개뿐이면 소재 관문은 안 걸린다',
  M.isSameTopic({ topic: 0.9, wording: 0, tags: 0, shared: ['n8n'] }, M.DEFAULTS) === null);
ok('제목 표현이 대놓고 닮으면 소재유사도가 낮아도 잡는다',
  M.isSameTopic({ topic: 0.05, wording: 0.4, tags: 0, shared: [] }, M.DEFAULTS) === 'wording');

// ── 8. 분류 — 우선순위와 안전장치 ────────────────────────────────────────────
console.log('\n[8] 분류');
const posts = [
  { slug: 'exposed', date: '2026-07-01', title: 'n8n 자동화 초보가 빠지는 함정 3가지', tags: ['n8n', '자동화'] },
  { slug: 'twin-a',  date: '2026-07-02', title: '클로드 프롬프트 캐싱으로 API 비용 절반', tags: ['Claude API', '비용 최적화'] },
  { slug: 'twin-b',  date: '2026-07-03', title: '클로드 배치 API 로 추론 비용 절반', tags: ['Claude API', '비용 최적화'] },
  { slug: 'lonely',  date: '2026-07-04', title: '고전문학으로 읽는 위로의 문장', tags: ['문학'] },
  { slug: 'fresh',   date: '2026-09-05', title: '아무도 안 읽는 최신 글', tags: ['잡담'] },
  // 유예 중인데 twin 쌍과 같은 소재 — merge 가 유예보다 먼저 잡혀야 한다.
  { slug: 'twin-c',  date: '2026-09-06', title: '클로드 프롬프트 캐싱 API 비용 절반으로', tags: ['Claude API', '비용 최적화'] },
  { slug: 'naver-only', date: '2026-07-05', title: '네이버에만 걸린 글', tags: ['잡담'] },
];
// 07-01~09-04 를 매일 수집했다고 가정 → 유예 기준일은 08-22.
const denseDates = [];
for (let d = new Date('2026-07-01T00:00:00Z'); d <= new Date('2026-09-04T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
  denseDates.push(d.toISOString().slice(0, 10));
}
const gsc = {
  bySlug: new Map([['exposed', { impressions: 40, clicks: 2, days: 5, bestPosition: 6, medianPosition: 7 }]]),
  coverage: { first: '2026-07-01', last: '2026-09-04', collectedDays: denseDates.length, missingDays: [], dates: denseDates },
};
const nv = { bySlug: new Map([['naver-only', { bestRank: 4, hits: 2, queries: ['q'], lastDate: '2026-08-01' }]]),
  coverage: { first: '2026-07-15', last: '2026-09-06', collectedDays: 50, missingDays: [], dates: [] } };
const res = M.classify({ posts, gsc, naver: nv, today: '2026-09-07', nicheKeywords: [{ keyword: 'n8n', weight: 3 }] });
const has = (bucket, slug) => res[bucket].some(x => x.slug === slug);

ok('노출 있으면 keep', has('keep', 'exposed'));
ok('네이버 순위만 있어도 keep', has('keep', 'naver-only'));
ok('같은 소재 쌍은 merge', has('merge', 'twin-a') && has('merge', 'twin-b'));
eq('같은 소재 3편은 한 클러스터로 묶인다',
  new Set(['twin-a', 'twin-b', 'twin-c'].map(s => res.merge.find(x => x.slug === s).cluster_id)).size, 1);
ok('merge 근거에 상대 글이 실린다', res.merge[0].evidence.similar_posts.length > 0);
ok('겹치지도 인접하지도 않으면 drop', has('drop', 'lonely'));
ok('최근 글은 drop 에 없다', !has('drop', 'fresh'));
ok('최근 글은 유예 표시로 improve 에 들어간다',
  res.improve.some(x => x.slug === 'fresh' && x.grace_period === true));
ok('유예 근거에 실측일수가 남는다',
  res.improve.find(x => x.slug === 'fresh').evidence.gsc_observed_days === 0);
// 중복 사실은 노출 데이터에 기대지 않는다 → 유예 중이어도 merge 로 잡아야 사람이 쌍을 본다.
ok('유예 중인 중복도 merge 로 잡힌다', has('merge', 'twin-c'));
ok('유예 중인 merge 항목은 유예 표시를 단다',
  res.merge.find(x => x.slug === 'twin-c')?.grace_period === true);
ok('유예 중인 merge 항목은 노출 0 을 사실로 주장하지 않는다',
  /유예 중/.test(res.merge.find(x => x.slug === 'twin-c')?.reason || ''));
ok('유예 중인 중복도 drop 에는 없다', !has('drop', 'twin-c'));
ok('클러스터가 멤버별 분류를 싣는다',
  res.clusters.every(c => c.members.every(m => typeof m.bucket === 'string')));
ok('모든 항목에 근거 문장이 있다',
  ['keep', 'merge', 'improve', 'drop'].every(b => res[b].every(x => typeof x.reason === 'string' && x.reason.length > 0)));
eq('전편이 정확히 한 번씩만 분류된다',
  res.keep.length + res.merge.length + res.improve.length + res.drop.length, posts.length);

// niche 매칭만으로 improve 로 살아나는지 (노출 0 · 소재 겹침 없음)
const res2 = M.classify({
  posts: [{ slug: 'niche-only', date: '2026-07-01', title: 'n8n 워크플로우 만들기', tags: ['n8n'] }],
  gsc: { bySlug: new Map(), coverage: gsc.coverage }, naver: { bySlug: new Map(), coverage: nv.coverage },
  today: '2026-09-07', nicheKeywords: [{ keyword: 'n8n', weight: 3 }],
});
ok('현재 니치 타겟에 걸리면 drop 대신 improve', res2.improve.some(x => x.slug === 'niche-only'));
const res3 = M.classify({
  posts: [{ slug: 'niche-only', date: '2026-07-01', title: 'n8n 워크플로우 만들기', tags: ['n8n'] }],
  gsc: { bySlug: new Map(), coverage: gsc.coverage }, naver: { bySlug: new Map(), coverage: nv.coverage },
  today: '2026-09-07', nicheKeywords: [{ keyword: 'n8n', weight: 1 }],   // 가중치 하한 미달
});
ok('가중치 낮은 키워드로는 살아나지 않는다', res3.drop.some(x => x.slug === 'niche-only'));

// ── 9. 실 데이터 불변식 — 저장소 현물로 검증 ─────────────────────────────────
console.log('\n[9] 실 데이터 불변식');
const real = M.buildResult({ today: '2026-09-07' });
const c = real.meta.counts;
eq('전편이 정확히 한 번씩 분류된다(실 데이터)',
  c.keep + c.merge + c.improve + c.drop, real.meta.published_total);
ok('keep 은 GSC 매칭분 + 네이버 단독분과 정확히 일치한다',
  c.keep === real.meta.gsc.blog_slugs_with_impressions - real.meta.gsc.slugs_not_in_published.length
    + real.keep.filter(x => x.evidence.gsc_impressions === 0).length,
  `keep=${c.keep} gsc=${real.meta.gsc.blog_slugs_with_impressions} unmatched=${real.meta.gsc.slugs_not_in_published.length}`);
ok('keep 은 전원 노출 근거를 갖는다',
  real.keep.every(x => x.evidence.gsc_impressions > 0 || x.evidence.naver_best_rank != null));
ok('drop 에 유예 기준일 이후 글이 하나도 없다',
  real.drop.every(x => x.date <= real.meta.grace.cutoff),
  real.drop.filter(x => x.date > real.meta.grace.cutoff).map(x => x.slug).join(','));
ok('drop 은 전원 노출 0 이다', real.drop.every(x => x.evidence.gsc_impressions === 0 && x.evidence.naver_best_rank === null));
ok('drop 은 전원 GSC 실측 ' + real.meta.thresholds.graceDays + '일 이상',
  real.drop.every(x => (x.evidence.gsc_observed_days ?? 0) >= real.meta.thresholds.graceDays),
  real.drop.filter(x => (x.evidence.gsc_observed_days ?? 0) < real.meta.thresholds.graceDays).map(x => `${x.slug}:${x.evidence.gsc_observed_days}`).join(','));
ok('결손일을 산출물에 명시한다(0 으로 뭉개지 않는다)', Array.isArray(real.meta.gsc.missing_days));
ok('리포트가 삭제 금지를 명시한다', M.renderReport(real).includes('스크립트는 아무것도 지우지 않는다'));

rmSync(tmp, { recursive: true, force: true });

console.log(`\n결과: ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
