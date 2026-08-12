#!/usr/bin/env node
/**
 * select-candidate.mjs — 매일 발행글 미러 선별 (티스토리에 발행 3건 그대로 미러링)
 *
 * 사용: node scripts/crosspub/select-candidate.mjs
 *
 * 입력: published/ 목록 (파일명 <YYYY-MM-DD>-<slug>.md) + crosspub-index
 * 판단: mirror_lookback_days 이내 발행글 중 아직 교차발행 안 된 것을 최신순 daily_cap 개.
 *       GSC 성과 무관 — "우리가 매일 발행하는 글을 티스토리에도 똑같이" 미러.
 * 계약: stdout JSON 1줄 {ok, candidates: [{slug, file, date, platforms}], reason}
 *       exit 0=정상(선정 없음 포함) / 2=실행오류
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../lib/log.mjs';
import {
  loadCrosspubConfig, enabledPlatforms, loadIndex,
  listPublishedSlugs, REPO_ROOT,
} from './lib.mjs';

const log = makeLogger('crosspub/select');

/**
 * 미러 모드 선별 (순수 함수): 매일 발행되는 글을 티스토리에 그대로 미러링.
 * published/ 목록 중 ① mirror_lookback_days 이내 날짜 ② 활성 플랫폼 중 아직
 * 큐/게시 안 된 플랫폼이 남은 글 을, 최신순으로 daily_cap 개까지 반환(배열).
 * GSC 성과와 무관 — 발행 자체를 기준으로 한다.
 * @returns {{ candidates: [{slug, file, date, platforms}], reason }}
 */
export function pickFreshCandidates({ publishedList, cfg, index, now = new Date() }) {
  const platforms = enabledPlatforms(cfg);
  if (platforms.length === 0) return { candidates: [], reason: '활성 플랫폼 없음' };

  const cap = cfg.daily_cap ?? 3;
  const lookback = cfg.mirror_lookback_days ?? 2;
  const cutoff = new Date(now.getTime() - lookback * 86400_000).toISOString().slice(0, 10);

  const picked = [];
  for (const p of publishedList) {          // publishedList 는 최신순 정렬 가정
    if (picked.length >= cap) break;
    if (p.date < cutoff) continue;           // lookback 밖 오래된 글 제외
    const entry = index[p.slug];
    const remaining = platforms.filter(pl => !entry?.platforms?.[pl]);
    if (remaining.length === 0) continue;    // 이미 전 플랫폼에 큐/게시됨
    picked.push({ slug: p.slug, file: p.file, date: p.date, platforms: remaining });
  }
  return {
    candidates: picked,
    reason: picked.length ? 'ok' : `미교차발행 신규글 없음(lookback ${lookback}일)`,
  };
}

function main() {
  let cfg;
  try { cfg = loadCrosspubConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }

  if (!cfg.enabled) {
    process.stdout.write(JSON.stringify({ ok: true, candidates: [], reason: 'crosspub disabled' }) + '\n');
    return;
  }

  let result;
  try {
    result = pickFreshCandidates({ publishedList: listPublishedSlugs(), cfg, index: loadIndex() });
  } catch (e) {
    log.error(`선별 실패: ${e.message}`);
    process.exit(2);
  }

  result.candidates = result.candidates.map(c => ({ ...c, file: c.file.replace(REPO_ROOT + '/', '') }));
  if (result.candidates.length) {
    log.info(`미러 선정 ${result.candidates.length}건: ${result.candidates.map(c => c.slug).join(', ')}`);
  } else {
    log.info(`선정 없음 — ${result.reason}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main();
}
