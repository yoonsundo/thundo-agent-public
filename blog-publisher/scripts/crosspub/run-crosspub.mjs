#!/usr/bin/env node
/**
 * crosspub/run-crosspub.mjs — 교차발행 오케스트레이터 (매일 발행글 미러)
 *
 * 흐름: killswitch → 예산 사전체크 → 발행글 미러 선별(최신 N일 미교차발행, 캡 3)
 *       → 글마다 플랫폼별 실 LLM 재작성 → pending 큐 적재 → index·감사 →
 *       → 브라우저 자동 게시(auto_post 플랫폼 = 티스토리) → 알림.
 *
 * 티스토리는 텍스트+역링크 무인 자동. velog·Medium은 enabled=false(Cloudflare).
 *
 * 계약: stdout JSON 1줄 {ok, posts:[{slug,queued,rejected,errors}], reason?}
 *       exit 0=정상(선정 없음 포함) / 1=일부 실패 / 2=치명 오류
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../lib/log.mjs';
import { isKilled } from '../watchdog/killswitch.mjs';
import { checkBudget } from '../watchdog/budget.mjs';
import { notify } from '../notify/index.mjs';
import { appendAudit, ACTIONS } from '../audit/append.mjs';
import { pickFreshCandidates } from './select-candidate.mjs';
import { loadCrosspubConfig, loadIndex, saveIndex, listPublishedSlugs, todayStr, REPO_ROOT } from './lib.mjs';

const log = makeLogger('crosspub/run');
const __dir = dirname(fileURLToPath(import.meta.url));

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function audit(reason) {
  try { appendAudit({ actor: 'crosspub', action: ACTIONS.PUBLISH, reason }); }
  catch (e) { log.warn(`감사로그 append 실패(계속): ${e.message}`); }
}

/** 글 1편을 대상 플랫폼들에 재작성→큐 적재. idx 를 직접 갱신. */
function rewriteOne(cand, cfg, idx) {
  const queued = [], rejected = [], errors = [];
  for (const platform of cand.platforms) {
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [join(__dir, 'rewrite.mjs'), cand.file, '--platform', platform], {
        encoding: 'utf8', timeout: 360_000, maxBuffer: 8 * 1024 * 1024, cwd: REPO_ROOT,
      });
    } catch (e) {
      const childOut = (e.stdout || '').toString().trim().split('\n').pop() || '';
      if (e.status === 1 && childOut) {
        try { const r = JSON.parse(childOut); rejected.push({ platform, similarity: r.similarity }); log.warn(`[${platform}/${cand.slug}] 유사도 FAIL`); continue; }
        catch { /* fallthrough */ }
      }
      errors.push({ platform, error: (e.stderr || e.message || '').toString().slice(0, 200) });
      log.error(`[${platform}/${cand.slug}] 재작성 실행오류`);
      continue;
    }
    let r;
    try { r = JSON.parse(stdout.trim().split('\n').pop()); }
    catch { errors.push({ platform, error: 'rewrite stdout 파싱 실패' }); continue; }
    queued.push({ platform, pending: r.pending, similarity: r.similarity });
    idx[cand.slug] = idx[cand.slug] || { platforms: {} };
    idx[cand.slug].platforms[platform] = { status: 'queued', queued_at: new Date().toISOString(), pending_file: r.pending };
    audit(`crosspub queue: ${platform}/${cand.slug} → ${r.pending} [sim=${r.similarity?.verdict}]`);
  }
  // LLM 산출이 하나라도 있으면 선정 기록(전부 실행오류면 미기록→재시도 허용)
  if (queued.length || rejected.length) {
    idx[cand.slug] = idx[cand.slug] || { platforms: {} };
    idx[cand.slug].selected_at = todayStr();
    idx[cand.slug].source_file = cand.file;
  }
  return { slug: cand.slug, queued, rejected, errors };
}

async function main() {
  let cfg;
  try { cfg = loadCrosspubConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }

  if (!cfg.enabled) { log.info('crosspub disabled — 종료'); return out({ ok: true, posts: [], reason: 'crosspub disabled' }); }

  const kill = await isKilled();
  if (kill.active) { log.warn(`킬스위치 활성 — 종료`); return out({ ok: true, posts: [], reason: 'killswitch active' }); }

  const budget = checkBudget();
  if (!budget.ok) { log.warn(`예산 소진 — 종료`); return out({ ok: true, posts: [], reason: 'budget exhausted' }); }

  // ── 미러 선별 (발행글 최신 N일, 미교차발행, 캡) ──
  const idx = loadIndex();
  const { candidates, reason } = pickFreshCandidates({ publishedList: listPublishedSlugs(), cfg, index: idx });
  if (candidates.length === 0) { log.info(`선정 없음 — ${reason}`); return out({ ok: true, posts: [], reason }); }
  log.info(`미러 선정 ${candidates.length}건: ${candidates.map(c => c.slug).join(', ')}`);
  audit(`crosspub mirror select ${candidates.length}건: ${candidates.map(c => c.slug).join(', ')}`);

  // ── 글마다 재작성→큐 (글 단위 격리) ──
  const posts = [];
  let totalQueued = 0, totalErr = 0;
  for (const cand of candidates) {
    const r = rewriteOne(cand, cfg, idx);
    posts.push(r);
    totalQueued += r.queued.length; totalErr += r.errors.length;
  }
  saveIndex(idx);

  // ── 알림 + 브라우저 자동 게시(auto_post 플랫폼 전부 pending 처리) ──
  if (totalQueued > 0) {
    await notify('CROSSPUB_PENDING', {
      reason: `교차발행 재작성 ${totalQueued}건 (글 ${posts.filter(p => p.queued.length).length}편)`,
      details: posts.flatMap(p => p.queued.map(q => `${q.platform}:${p.slug}`)).join(' | '),
    }).catch(() => {});

    const anyAuto = candidates.some(c => c.platforms.some(pl => cfg.platforms[pl]?.auto_post));
    if (anyAuto) {
      log.info('자동 게시 시도(전 pending)');
      try {
        const apOut = execFileSync(process.execPath, [join(__dir, 'auto-post.mjs')], {
          encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024, cwd: REPO_ROOT,
        });
        const ap = JSON.parse(apOut.trim().split('\n').pop());
        log.info(`자동 게시 결과: posted=${ap.posted.length} failed=${ap.failed.length} skipped=${ap.skipped.length}`);
      } catch (e) {
        log.warn(`자동 게시 실패(pending 유지): ${(e.stderr || e.message || '').toString().slice(0, 200)}`);
      }
    }
  }

  log.info(`완료: 글 ${posts.length}편, queued=${totalQueued}, errors=${totalErr}`);
  out({ ok: totalErr === 0, posts });
  if (totalErr > 0) process.exit(1);
}

main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(2); });
