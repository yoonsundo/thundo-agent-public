/**
 * gsc-feedback.mjs (3-3a) — GSC 약점 신호 추출 → state/evolve-feedback.jsonl append
 *
 * 약점 판정 기준:
 *   - CTR 저조: impressions >= 50 AND ctr <= 전체 haveImpression 슬러그의 하위 25th percentile
 *   - 순위 정체: avg_position 11~30 (2~3페이지 정체 구간)
 *
 * 역참조(우선순위):
 *   1차 — runs/<date>/run.json published[].{slug,writer} / drafts[].{slug,writer}
 *   2차 폴백 — published/*.md 프론트매터 slug: + writer: 필드
 *   (mock 런이 run.json을 덮어쓰거나 과거 날짜 run.json이 없는 경우를 대비)
 * 매핑 실패 slug는 스킵 + info 로그.
 *
 * evolve-feedback.jsonl 스키마: 기존 레코드 {ts, writer, all_pass, weaknesses:[]} 와 동일.
 * recentFails() 는 writer + weaknesses 두 필드만 소비하므로 all_pass 는 선택적.
 *
 * 플래그:
 *   --dry-run  실제 append 없이 결과만 stdout 출력 (검증용)
 */
import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';
import { loadSeoMetrics } from './gsc-collect.mjs';

// published/*.md 프론트매터에서 특정 키 값 추출
function fmField(text, key) {
  const m = text.match(new RegExp('^' + key + ':\\s*"?([^"\\n]+?)"?\\s*$', 'm'));
  return m ? m[1].trim() : '';
}

const log = makeLogger('seo-feedback');

const DRY_RUN       = process.argv.includes('--dry-run');
const FEEDBACK_PATH = 'state/evolve-feedback.jsonl';
const IMPRESSION_MIN    = 50;  // 노출 최소 임계: 이 이상이어야 CTR 판정
const POSITION_WEAK_MIN = 11;  // 순위 약함 하한
const POSITION_WEAK_MAX = 30;  // 순위 약함 상한

// ── 슬러그 추출 ───────────────────────────────────────────────────────────────

function extractSlug(pageUrl) {
  // https://www.thundo.kr/blog/<slug> 형태 파싱
  const m = pageUrl.match(/\/blog\/([^/?#]+)/);
  return m ? m[1] : null;
}

// ── slug → writer 역참조 맵 구축 ─────────────────────────────────────────────

function buildSlugWriterMap() {
  const map = new Map(); // slug → writer

  // ─ 1차: runs/<date>/run.json ─
  if (existsSync('runs')) {
    let dates = [];
    try { dates = readdirSync('runs').filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)); } catch {}
    for (const date of dates) {
      const runPath = `runs/${date}/run.json`;
      if (!existsSync(runPath)) continue;
      try {
        const run = JSON.parse(readFileSync(runPath, 'utf8'));
        // 형식 A: run.published = [{slug, writer}]
        if (Array.isArray(run.published)) {
          for (const p of run.published) {
            if (p.slug && p.writer) map.set(p.slug, p.writer.toLowerCase());
          }
        }
        // 형식 B (mock): run.drafts = [{slug, writer}]
        if (Array.isArray(run.drafts)) {
          for (const d of run.drafts) {
            if (d.slug && d.writer) map.set(d.slug, d.writer.toLowerCase());
          }
        }
      } catch { /* 손상 run.json 스킵 */ }
    }
  }

  // ─ 2차 폴백: published/*.md 프론트매터 ─
  // mock 런이 run.json을 덮어쓰거나 과거 날짜 run.json이 없어 1차에서 누락된 slug를 보완.
  if (existsSync('published')) {
    let files = [];
    try { files = readdirSync('published').filter(f => f.endsWith('.md')); } catch {}
    for (const f of files) {
      try {
        const text = readFileSync(`published/${f}`, 'utf8');
        const slug   = fmField(text, 'slug')   || f.replace(/\.md$/, '');
        const writer = fmField(text, 'writer');
        if (slug && writer && !map.has(slug)) {
          map.set(slug, writer.toLowerCase());
        }
      } catch { /* 손상 파일 스킵 */ }
    }
  }

  return map;
}

// ── page 차원 집계 → slug별 통합 지표 ────────────────────────────────────────

function aggregatePageMetrics(metrics) {
  const slugAgg = new Map(); // slug → {clicks, impressions, positions[]}

  for (const [, rec] of metrics) {
    if (rec.dimension !== 'page') continue;
    for (const row of (rec.rows || [])) {
      const slug = extractSlug(row.key || '');
      if (!slug) continue;
      if (!slugAgg.has(slug)) slugAgg.set(slug, { clicks: 0, impressions: 0, positions: [] });
      const e = slugAgg.get(slug);
      e.clicks      += (row.clicks      || 0);
      e.impressions += (row.impressions || 0);
      if (row.position != null) e.positions.push(row.position);
    }
  }

  const result = new Map();
  for (const [slug, d] of slugAgg) {
    const avg_position = d.positions.length
      ? d.positions.reduce((a, b) => a + b, 0) / d.positions.length
      : null;
    const ctr = d.impressions > 0 ? d.clicks / d.impressions : 0;
    result.set(slug, { clicks: d.clicks, impressions: d.impressions, ctr, avg_position });
  }
  return result;
}

// CTR 하위 25th percentile 계산 (impression >= IMPRESSION_MIN 인 슬러그 기준)
function ctrLowerQuartile(slugMetrics) {
  const ctrs = [...slugMetrics.values()]
    .filter(m => m.impressions >= IMPRESSION_MIN)
    .map(m => m.ctr)
    .sort((a, b) => a - b);
  if (ctrs.length === 0) return 0;
  return ctrs[Math.floor(ctrs.length * 0.25)];
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const metrics = loadSeoMetrics();
  if (metrics.size === 0) {
    log.warn('state/seo-metrics.jsonl 데이터 없음 — 스킵 (gsc-collect 먼저 실행 필요)');
    process.exit(0);
  }

  const slugMetrics = aggregatePageMetrics(metrics);
  if (slugMetrics.size === 0) {
    log.warn('page 차원 데이터 없음 — 스킵');
    process.exit(0);
  }

  const ctrThreshold = ctrLowerQuartile(slugMetrics);
  const slugWriterMap = buildSlugWriterMap();
  log.info(`slug ${slugMetrics.size}개, CTR 하위 25th ${(ctrThreshold * 100).toFixed(2)}%, writer 매핑 ${slugWriterMap.size}개`);

  // writer별 약점 수집
  const writerWeaknesses = new Map(); // writer → weaknesses[]

  for (const [slug, m] of slugMetrics) {
    const writer = slugWriterMap.get(slug);
    if (!writer) {
      log.info(`slug 매핑 실패: ${slug} — 스킵`);
      continue;
    }

    const weaknesses = [];

    if (m.impressions >= IMPRESSION_MIN && m.ctr <= ctrThreshold) {
      weaknesses.push(
        `검색 노출 대비 클릭 저조 — 제목·메타설명 개선 필요 (노출 ${m.impressions}, CTR ${(m.ctr * 100).toFixed(1)}%)`
      );
    }

    if (m.avg_position !== null && m.avg_position >= POSITION_WEAK_MIN && m.avg_position <= POSITION_WEAK_MAX) {
      weaknesses.push(
        `검색 순위 2~3페이지 정체 — 콘텐츠 깊이·내부링크 강화 필요 (평균 순위 ${m.avg_position.toFixed(1)}위)`
      );
    }

    if (weaknesses.length === 0) continue;

    if (!writerWeaknesses.has(writer)) writerWeaknesses.set(writer, []);
    writerWeaknesses.get(writer).push(...weaknesses);
  }

  if (writerWeaknesses.size === 0) {
    log.info('약점 신호 없음 — evolve-feedback 추가 없음');
    process.exit(0);
  }

  // 엔트리 구성 (기존 스키마: {ts, writer, weaknesses})
  const entries = [];
  for (const [writer, weaknesses] of writerWeaknesses) {
    // 중복 제거 후 최대 10개
    const deduped = [...new Set(weaknesses)].slice(0, 10);
    entries.push({ ts: new Date().toISOString(), writer, weaknesses: deduped });
    log.info(`${writer}: 약점 ${deduped.length}개`);
  }

  if (DRY_RUN) {
    console.log('[gsc-feedback] --dry-run: 실제 append 없음. 생성될 엔트리:');
    for (const e of entries) console.log(JSON.stringify(e));
    process.exit(0);
  }

  for (const entry of entries) {
    appendFileSync(FEEDBACK_PATH, JSON.stringify(entry) + '\n', 'utf8');
  }
  log.info(`evolve-feedback.jsonl append 완료: ${entries.length}엔트리`);
}

main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
