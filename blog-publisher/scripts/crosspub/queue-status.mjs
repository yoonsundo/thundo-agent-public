#!/usr/bin/env node
/**
 * crosspub/queue-status.mjs — 교차발행 반자동 큐 상태 조회 · 게시완료 처리
 *
 * 사용:
 *   node scripts/crosspub/queue-status.mjs                                # 전 플랫폼 pending 표
 *   node scripts/crosspub/queue-status.mjs --mark-posted <platform> <slug> [--url <게시주소>]
 *
 * --mark-posted: pending→posted/ 이동 + posted.jsonl append + crosspub-index 갱신
 *                + 감사로그 append (actor=crosspub, action=publish).
 * scripts/naver/queue-status.mjs 의 플랫폼-일반화 복제(원본 무수정 보존).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../lib/log.mjs';
import { appendAudit, ACTIONS } from '../audit/append.mjs';
import { jaccardOfTexts, judgeBand } from '../naver/check-rewrite-similarity.mjs';
import {
  loadCrosspubConfig, platformDirs, parseDoc, recordPosted, REPO_ROOT,
} from './lib.mjs';

const log = makeLogger('crosspub/queue');

function listPending(platform) {
  const { pending } = platformDirs(platform);
  if (!existsSync(pending)) return [];
  return readdirSync(pending).filter(f => f.endsWith(`.${platform}.md`)).sort();
}

/** pending 1건 평가 — frontmatter similarity 기록 우선, ko 는 재계산 검증 */
function evaluate(platform, fname, cfg) {
  const { pending } = platformDirs(platform);
  const raw = readFileSync(join(pending, fname), 'utf8');
  const { fm } = parseDoc(raw);
  const slug = fm.slug || fname.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(new RegExp(`\\.${platform}\\.md$`), '');
  if (!cfg.platforms?.[platform]?.similarity_check) {
    return { slug, jaccard: null, verdict: 'SKIP(교차언어)' };
  }
  const srcRel = fm.source;
  if (!srcRel) return { slug, jaccard: null, verdict: 'source 미상' };
  const srcAbs = resolve(REPO_ROOT, srcRel);
  if (!existsSync(srcAbs)) return { slug, jaccard: null, verdict: `원문 없음(${srcRel})` };
  const band = cfg.similarity_band || { min: 0.3, max: 0.6 };
  const { jaccard } = jaccardOfTexts(readFileSync(srcAbs, 'utf8'), raw);
  const { pass, reason } = judgeBand(jaccard, band);
  return { slug, jaccard, verdict: pass ? 'PASS' : `FAIL — ${reason}` };
}

function showStatus(cfg) {
  const platforms = Object.keys(cfg.platforms || {});
  let total = 0;
  for (const platform of platforms) {
    const files = listPending(platform);
    total += files.length;
    const label = cfg.platforms[platform].label || platform;
    process.stdout.write(`\n[${label}] pending ${files.length}건${cfg.platforms[platform].enabled ? '' : ' (플랫폼 비활성)'}\n`);
    if (files.length === 0) continue;
    process.stdout.write('─'.repeat(72) + '\n');
    process.stdout.write(`${'slug'.padEnd(42)} ${'jaccard'.padEnd(9)} 판정\n`);
    for (const f of files) {
      let row;
      try { row = evaluate(platform, f, cfg); }
      catch (e) { process.stdout.write(`${f.padEnd(42)} ${'ERR'.padEnd(9)} ${e.message}\n`); continue; }
      const j = row.jaccard == null ? '—' : row.jaccard.toFixed(4);
      process.stdout.write(`${row.slug.slice(0, 42).padEnd(42)} ${j.padEnd(9)} ${row.verdict}\n`);
    }
  }
  process.stdout.write(`\n합계 pending ${total}건\n`);
  process.stdout.write('게시 후: node scripts/crosspub/queue-status.mjs --mark-posted <platform> <slug> [--url <주소>]\n\n');
}

function markPosted(cfg, platform, slug, url) {
  if (!cfg.platforms?.[platform]) { log.error(`알 수 없는 플랫폼: ${platform}`); process.exit(2); }
  const dirs = platformDirs(platform);
  const files = listPending(platform);
  let target = null;
  for (const f of files) {
    const { fm } = parseDoc(readFileSync(join(dirs.pending, f), 'utf8'));
    if (fm.slug === slug) { target = f; break; }
  }
  if (!target) target = files.find(f => f.includes(slug)) || null;
  if (!target) {
    log.error(`[${platform}] pending 에서 slug='${slug}' 매칭 파일을 못 찾음. 현재: ${files.join(', ') || '(없음)'}`);
    process.exit(1);
  }

  const rec = recordPosted(platform, target, slug, url);

  // CROSSPUB_TEST_NO_AUDIT=1: 테스트 격리 — 실 감사체인(.omc/audit, append-only) 오염 방지
  if (process.env.CROSSPUB_TEST_NO_AUDIT !== '1') {
    try {
      appendAudit({
        actor: 'crosspub', action: ACTIONS.PUBLISH,
        reason: `crosspub posted: ${platform}/${slug}${url ? ' → ' + url : ''}`,
      });
    } catch (e) { log.warn(`감사로그 append 실패(계속): ${e.message}`); }
  }

  log.info(`게시완료: [${platform}] ${target} → posted/ ${url ? '(' + url + ')' : '(url 미지정)'}`);
  process.stdout.write(JSON.stringify({ ok: true, platform, moved: target, posted: rec }) + '\n');
}

function main() {
  let cfg;
  try { cfg = loadCrosspubConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }

  const args = process.argv.slice(2);
  const mi = args.indexOf('--mark-posted');
  if (mi >= 0) {
    const platform = args[mi + 1];
    const slug = args[mi + 2];
    if (!platform || !slug || platform.startsWith('--') || slug.startsWith('--')) {
      log.error('--mark-posted <platform> <slug> 필요'); process.exit(2);
    }
    const ui = args.indexOf('--url');
    markPosted(cfg, platform, slug, ui >= 0 ? args[ui + 1] : undefined);
    return;
  }
  showStatus(cfg);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main();
}
