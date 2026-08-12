/**
 * cohort-report.mjs (AC-21) — SEO 적용 전/후 코호트 비교 마크다운 리포트
 *
 * 적용 이벤트 감지:
 *   1차: .omc/audit/audit-log.jsonl 에서 action='seo-targeting-applied' 엔트리 타임스탬프
 *   2차: state/config-backups/pipeline-*.json 파일명 타임스탬프 (감사로그 없을 때)
 *
 * 코호트 정의:
 *   pre-apply  — 첫 번째 적용 이벤트 이전에 발행된 글
 *   post-apply — 첫 번째 적용 이벤트 이후에 발행된 글
 *
 * 지표:
 *   runs/<date>/run.json published[].slug → 발행일 → GSC page 차원 rows 집계
 *   (발행일 이후 모든 날짜의 클릭·노출 합산, N=관측 가능한 모든 날)
 *
 * 출력: docs/reports/seo/cohort-<YYYY-MM-DD>.md
 *
 * 데이터 부족 조건:
 *   - 적용 이벤트 없음 → 리포트에 "적용 이벤트 없음" 명시
 *   - 어느 코호트든 슬러그 수 < 3 → "표본 부족" 명시
 *   - post-apply 코호트 발행 후 경과 < 7일 → "관측 기간 부족" 명시
 *
 * 사용: node scripts/seo/cohort-report.mjs [YYYY-MM-DD]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';
import { loadSeoMetrics } from './gsc-collect.mjs';

const log = makeLogger('seo-cohort');

const REPORT_DIR    = 'docs/reports/seo';
const AUDIT_LOG     = '.omc/audit/audit-log.jsonl';
const BACKUP_DIR    = 'state/config-backups';
const MIN_COHORT    = 3;   // 코호트당 최소 슬러그 수
const MIN_POST_DAYS = 7;   // post-apply 발행 후 최소 관측 기간(일)

const TODAY = process.argv[2] || new Date().toISOString().slice(0, 10);

// ── 감사 로그에서 첫 번째 적용 이벤트 타임스탬프 ───────────────────────────

function findFirstApplyTs() {
  // 1차: 감사 로그
  if (existsSync(AUDIT_LOG)) {
    const lines = readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.action === 'seo-targeting-applied' && e.ts) return e.ts;
      } catch {}
    }
  }

  // 2차: config-backups 파일명 타임스탬프
  if (existsSync(BACKUP_DIR)) {
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('pipeline-') && f.endsWith('.json'))
      .sort();
    if (files.length > 0) {
      // pipeline-2026-07-02T00-00-00-000Z.json → ISO 복원
      const name = files[0].replace(/^pipeline-/, '').replace(/\.json$/, '');
      const iso = name.replace(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
        '$1T$2:$3:$4.$5Z'
      );
      if (!isNaN(Date.parse(iso))) return iso;
    }
  }

  return null;
}

// ── runs/ 에서 발행일별 slug→{date, writer} 맵 구축 ─────────────────────────

function buildPublishMap() {
  const map = new Map(); // slug → {date, writer}
  if (!existsSync('runs')) return map;

  let dates;
  try { dates = readdirSync('runs').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); }
  catch { return map; }

  for (const date of dates) {
    const runPath = `runs/${date}/run.json`;
    if (!existsSync(runPath)) continue;
    try {
      const run = JSON.parse(readFileSync(runPath, 'utf8'));
      const published = Array.isArray(run.published) ? run.published : [];
      for (const p of published) {
        if (p.slug) map.set(p.slug, { date, writer: (p.writer || '').toLowerCase() });
      }
    } catch {}
  }

  return map;
}

// ── GSC page 차원에서 slug별 집계 ────────────────────────────────────────────

function buildSlugGscMap(metrics) {
  // slug → {clicks, impressions, days: Set<date>}
  const agg = new Map();

  for (const [, rec] of metrics) {
    if (rec.dimension !== 'page') continue;
    for (const row of (rec.rows || [])) {
      const m = (row.key || '').match(/\/blog\/([^/?#]+)/);
      if (!m) continue;
      const slug = m[1];
      if (!agg.has(slug)) agg.set(slug, { clicks: 0, impressions: 0, days: new Set() });
      const e = agg.get(slug);
      e.clicks      += (row.clicks      || 0);
      e.impressions += (row.impressions || 0);
    }
    // rec 자체의 date를 관측 날짜로 기록
    for (const row of (rec.rows || [])) {
      const m = (row.key || '').match(/\/blog\/([^/?#]+)/);
      if (!m) continue;
      const slug = m[1];
      if (agg.has(slug)) agg.get(slug).days.add(rec.date);
    }
  }

  const result = new Map();
  for (const [slug, d] of agg) {
    const dayCount = d.days.size;
    result.set(slug, {
      clicks:      d.clicks,
      impressions: d.impressions,
      ctr:         d.impressions > 0 ? d.clicks / d.impressions : 0,
      observed_days: dayCount,
      avg_daily_clicks: dayCount > 0 ? d.clicks / dayCount : 0,
    });
  }
  return result;
}

// ── 코호트 평균 계산 ─────────────────────────────────────────────────────────

function cohortAvg(slugs, slugGscMap) {
  const data = slugs.map(s => slugGscMap.get(s)).filter(Boolean);
  if (data.length === 0) return null;
  const avg = f => data.reduce((s, d) => s + f(d), 0) / data.length;
  return {
    n:                   data.length,
    avg_clicks:          avg(d => d.clicks),
    avg_impressions:     avg(d => d.impressions),
    avg_ctr:             avg(d => d.ctr),
    avg_daily_clicks:    avg(d => d.avg_daily_clicks),
    avg_observed_days:   avg(d => d.observed_days),
    has_data:            data.length,
  };
}

// ── 마크다운 생성 ────────────────────────────────────────────────────────────

function pct(n) { return (n * 100).toFixed(1) + '%'; }
function n2(n)  { return n.toFixed(2); }

function buildMarkdown(applyTs, pre, post, preAvg, postAvg) {
  const L = [];

  L.push(`# SEO 코호트 비교 리포트 — ${TODAY}`);
  L.push('');
  L.push(`> 자동 생성: \`scripts/seo/cohort-report.mjs\``);
  L.push(`> 적용 이벤트: ${applyTs || '없음'}`);
  L.push('');

  if (!applyTs) {
    L.push('## 상태');
    L.push('');
    L.push('`seo-targeting-applied` 이벤트가 감사 로그에 없습니다.');
    L.push('`apply-targeting.mjs` 를 먼저 실행하거나 GSC 데이터를 충분히 수집해야 합니다.');
    return L.join('\n');
  }

  // 요약
  L.push('## 요약');
  L.push('');
  L.push(`| 항목 | 값 |`);
  L.push(`|------|----|`);
  L.push(`| 적용 시점 | ${applyTs.slice(0, 16)} KST |`);
  L.push(`| 적용 전 코호트 | ${pre.length}편 |`);
  L.push(`| 적용 후 코호트 | ${post.length}편 |`);
  L.push('');

  // 표본 부족 경고
  const warnings = [];
  if (pre.length  < MIN_COHORT) warnings.push(`적용 전 코호트 표본 부족 (${pre.length}편 < ${MIN_COHORT}편)`);
  if (post.length < MIN_COHORT) warnings.push(`적용 후 코호트 표본 부족 (${post.length}편 < ${MIN_COHORT}편)`);

  // post-apply 최근 발행일 기준 경과 확인
  if (post.length > 0) {
    const applyDate = new Date(applyTs);
    const elapsedDays = (new Date(TODAY) - applyDate) / 86400000;
    if (elapsedDays < MIN_POST_DAYS) {
      warnings.push(`적용 후 관측 기간 부족 (${elapsedDays.toFixed(0)}일 < ${MIN_POST_DAYS}일) — 지표가 아직 확정되지 않음`);
    }
  }

  if (warnings.length > 0) {
    L.push('## ⚠️ 주의');
    L.push('');
    for (const w of warnings) L.push(`- **${w}**`);
    L.push('');
    if (pre.length < MIN_COHORT || post.length < MIN_COHORT) {
      L.push('표본 부족으로 통계적 비교가 불가합니다. 더 많은 GSC 데이터 수집 후 재실행하세요.');
      return L.join('\n');
    }
  }

  // 지표 비교표
  L.push('## GSC 지표 비교');
  L.push('');
  L.push('| 지표 | 적용 전 | 적용 후 | 변화 |');
  L.push('|------|---------|---------|------|');

  if (preAvg && postAvg) {
    const row = (label, preV, postV, fmt, higherIsBetter = true) => {
      const delta = postV - preV;
      const pctDelta = preV > 0 ? ((delta / preV) * 100).toFixed(1) : 'N/A';
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '→';
      const sign = higherIsBetter
        ? (delta >= 0 ? '✅' : '⚠️')
        : (delta <= 0 ? '✅' : '⚠️');
      return `| ${label} | ${fmt(preV)} | ${fmt(postV)} | ${arrow} ${pctDelta}% ${sign} |`;
    };

    L.push(row('평균 클릭수 (전체)',     preAvg.avg_clicks,       postAvg.avg_clicks,       n2));
    L.push(row('평균 노출수 (전체)',     preAvg.avg_impressions,   postAvg.avg_impressions,  n2));
    L.push(row('평균 CTR',              preAvg.avg_ctr,           postAvg.avg_ctr,          pct));
    L.push(row('일평균 클릭 (GSC 날짜 기준)', preAvg.avg_daily_clicks, postAvg.avg_daily_clicks, n2));
  } else {
    L.push('| (GSC 데이터 없음) | — | — | — |');
  }

  L.push('');

  // 슬러그 목록
  L.push('## 코호트 구성');
  L.push('');
  L.push('### 적용 전');
  L.push('');
  if (pre.length > 0) {
    for (const s of pre) L.push(`- \`${s}\``);
  } else {
    L.push('(없음)');
  }
  L.push('');
  L.push('### 적용 후');
  L.push('');
  if (post.length > 0) {
    for (const s of post) L.push(`- \`${s}\``);
  } else {
    L.push('(없음)');
  }
  L.push('');

  L.push('---');
  L.push(`*생성: ${new Date().toISOString()} · scripts/seo/cohort-report.mjs*`);

  return L.join('\n');
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const applyTs    = findFirstApplyTs();
  const publishMap = buildPublishMap();
  const metrics    = loadSeoMetrics();
  const slugGscMap = buildSlugGscMap(metrics);

  log.info(`적용 이벤트: ${applyTs || '없음'}, 발행 slug ${publishMap.size}개, GSC slug ${slugGscMap.size}개`);

  // 코호트 분류
  const pre  = [];
  const post = [];

  for (const [slug, { date }] of publishMap) {
    if (!applyTs) {
      pre.push(slug);
    } else {
      const pubTs = `${date}T00:00:00.000Z`;
      if (pubTs < applyTs) pre.push(slug);
      else                  post.push(slug);
    }
  }

  log.info(`pre-apply ${pre.length}편, post-apply ${post.length}편`);

  const preAvg  = cohortAvg(pre,  slugGscMap);
  const postAvg = cohortAvg(post, slugGscMap);

  const md = buildMarkdown(applyTs, pre, post, preAvg, postAvg);

  mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = `${REPORT_DIR}/cohort-${TODAY}.md`;
  writeFileSync(outPath, md, 'utf8');
  log.info(`리포트 저장: ${outPath}`);
  console.log(`[cohort-report] ✅ ${outPath}`);
}

main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
