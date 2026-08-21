#!/usr/bin/env node
/**
 * shorts/select.mjs — 매일 쇼츠 후보 1편 best-pick 선별
 *
 * 사용: node scripts/shorts/select.mjs
 *
 * 입력: published/ 목록 + shorts-index. 판단: 최근 lookback_days 발행글 중
 *       아직 쇼츠화(queued/uploaded) 안 된 것 중 "쇼츠 적합도" 최고 1편.
 * 적합도 = H2 소제목 수(카드거리) + 목록 존재 + 적정 길이(너무 길면 감점).
 * 계약: stdout JSON 1줄 {ok, candidate|null, reason}. exit 0=정상 / 2=실행오류
 */
import { readFileSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';
import { listPublishedSlugs, parseDoc } from '../lib/published-doc.mjs';
import { loadShortsConfig, loadIndex, isMainModule } from './lib.mjs';

const log = makeLogger('shorts/select');

/**
 * 쇼츠 적합도 스코어 (순수 함수). 높을수록 카드형 쇼츠로 만들기 좋다.
 * - H2(## ) 소제목 3~6개면 카드 매핑 최적 → 가점
 * - 순서/불릿 목록 존재 → 가점(요점 추출 쉬움)
 * - 본문이 너무 길면(>5000자) 압축 부담 → 소폭 감점
 */
export function shortsFitness(body) {
  const h2 = (body.match(/^##\s+/gm) || []).length;
  const lists = (body.match(/^\s*(?:[-*]|\d+\.)\s+/gm) || []).length;
  const len = body.length;
  let score = 0;
  score += Math.min(h2, 6) * 2;              // 소제목: 최대 12
  if (h2 >= 3 && h2 <= 6) score += 4;         // 카드 매핑 최적 구간 보너스
  score += Math.min(lists, 8);                // 목록: 최대 8
  if (len > 5000) score -= 3;
  if (len < 1200) score -= 2;                 // 너무 짧으면 소재 부족
  return score;
}

/** 순수 선별 로직 — 최신 lookback 창 안에서 미제작 글 중 최고 적합도 1편. */
export function pickBestCandidate({ publishedList, cfg, index, now = new Date() }) {
  const lookback = cfg.selection?.lookback_days ?? 3;
  const cutoff = new Date(now.getTime() - lookback * 86400_000).toISOString().slice(0, 10);
  const scored = [];
  for (const p of publishedList) {
    if (p.date < cutoff) continue;
    const entry = index[p.slug];
    if (entry && (entry.status === 'queued' || entry.status === 'uploaded')) continue; // 이미 제작
    let body = '';
    try { body = parseDoc(readFileSync(p.file, 'utf8')).body; } catch { continue; }
    scored.push({ ...p, score: shortsFitness(body) });
  }
  if (scored.length === 0) return { candidate: null, reason: `쇼츠 미제작 신규글 없음(lookback ${lookback}일)` };
  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1)); // 적합도↓, 동점이면 최신
  const top = scored[0];
  return { candidate: { slug: top.slug, file: top.file, date: top.date, score: top.score }, reason: 'ok' };
}

function main() {
  let cfg;
  try { cfg = loadShortsConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }
  if (!cfg.enabled) {
    process.stdout.write(JSON.stringify({ ok: true, candidate: null, reason: 'shorts disabled' }) + '\n');
    return;
  }
  try {
    const { candidate, reason } = pickBestCandidate({
      publishedList: listPublishedSlugs(), cfg, index: loadIndex(),
    });
    log.info(candidate ? `선정: ${candidate.slug} (적합도 ${candidate.score})` : `선정 없음: ${reason}`);
    process.stdout.write(JSON.stringify({ ok: true, candidate, reason }) + '\n');
  } catch (e) {
    log.error(`선별 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, candidate: null, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
