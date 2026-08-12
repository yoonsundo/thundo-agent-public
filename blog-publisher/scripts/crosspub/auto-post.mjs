#!/usr/bin/env node
/**
 * crosspub/auto-post.mjs — pending 큐를 브라우저로 자동 게시 → posted 전이
 *
 * 사용:
 *   node scripts/crosspub/auto-post.mjs                  # 전 플랫폼 pending 전부
 *   node scripts/crosspub/auto-post.mjs --platform velog # 한 플랫폼만
 *   node scripts/crosspub/auto-post.mjs --headed         # 창 보면서 (디버그)
 *
 * 전제: npm run crosspub:login 으로 세션 확보(최초 1회, 비밀번호 저장 안 함).
 * 실패한 항목은 pending 에 남는다(반자동 폴백) — 스크린샷이 진단 증거.
 *
 * ⚠ 브라우저 자동 게시는 플랫폼 약관 회색·위반 지대 — 2026-07-06 사용자가
 *   계정 정지 리스크를 명시적으로 수용하고 활성화함.
 *
 * 계약: stdout JSON 1줄 {ok, posted:[], failed:[], skipped:[]} / exit 0=전부 성공(0건 포함), 1=실패 있음, 2=치명
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLogger } from '../lib/log.mjs';
import { mdToHtml } from '../lib/md-to-html.mjs';
import { appendAudit, ACTIONS } from '../audit/append.mjs';
import { notify } from '../notify/index.mjs';
import { loadCrosspubConfig, platformDirs, parseDoc, recordPosted } from './lib.mjs';
import { openContext, saveSessionState, verifySession } from './browser/context.mjs';
import { DRIVERS, PREPARE, snapError, waitForHumanPublish } from './browser/drivers.mjs';

const log = makeLogger('crosspub/auto-post');

/** 재작성본 → 드라이버 입력 문서. 본문 첫 # 제목을 분리한다. */
export function toDoc(raw, fmTitleFallback, tags) {
  const { fm, body } = parseDoc(raw);
  const m = body.match(/^\s*#\s+(.+?)\r?\n([\s\S]*)$/);
  const title = m ? m[1].trim() : (fm.title || fmTitleFallback || '(제목 미상)');
  const bodyMd = (m ? m[2] : body).trim() + '\n';
  // 태그: 원문 태그(crosspub_tags) 우선, 없으면 config default_tags 폴백
  const srcTags = fm.crosspub_tags
    ? fm.crosspub_tags.split(',').map(t => t.trim()).filter(Boolean)
    : [];
  const finalTags = srcTags.length ? srcTags : tags;
  return { title, bodyMd, bodyHtml: mdToHtml(bodyMd), tags: finalTags, category: fm.crosspub_category || null };
}

function listPending(platform) {
  const { pending } = platformDirs(platform);
  if (!existsSync(pending)) return [];
  return readdirSync(pending).filter(f => f.endsWith(`.${platform}.md`)).sort();
}

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--platform');
  const only = pi >= 0 ? args[pi + 1] : null;
  const assist = args.includes('--assist');   // 하이브리드: 자동으로 채우고 사람이 캡차+발행
  const headed = args.includes('--headed') || assist;   // assist 는 항상 창을 띄운다

  const cfg = loadCrosspubConfig();
  const tags = cfg.default_tags || { ko: ['AI', 'Claude', '자동화'], en: ['AI', 'Claude', 'Automation', 'Productivity'] };
  // 무인(headless) 런은 캡차 게이트 플랫폼을 건너뛴다 — 캡차는 우회하지 않으므로
  // 사람이 붙는 assist 런에서만 처리. --assist 면 캡차 게이트 플랫폼만 대상.
  const platforms = Object.entries(cfg.platforms)
    .filter(([id, p]) => p.enabled && p.auto_post && (!only || id === only))
    .filter(([, p]) => assist ? p.captcha_gated : !p.captcha_gated)
    .map(([id]) => id);

  if (platforms.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, posted: [], failed: [], skipped: [], reason: 'auto_post 대상 플랫폼 없음' }) + '\n');
    return;
  }

  const work = platforms.flatMap(p => listPending(p).map(f => ({ platform: p, file: f })));
  if (work.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, posted: [], failed: [], skipped: [], reason: 'pending 없음' }) + '\n');
    return;
  }

  const ctx = await openContext({ headed });
  const posted = [], failed = [], skipped = [];
  const sessionState = {};   // platform → {valid, reason} (플랫폼당 1회 실검증)
  const expired = [];        // 세션 만료 감지된 플랫폼(알림용)
  try {
    for (const { platform, file } of work) {
      // 플랫폼당 세션 1회 실검증(쿠키 유무 아닌 실제 페이지 로드) — false positive 차단.
      // 일시적 네트워크 실패의 오탐을 막기 위해 만료 판정 시 1회 재시도(둘 다 실패해야 만료 확정).
      if (!(platform in sessionState)) {
        const host = cfg.platforms[platform]?.blog_host;
        let res = await verifySession(ctx, platform, host);
        if (!res.valid) res = await verifySession(ctx, platform, host); // 재시도
        sessionState[platform] = res;
        if (!res.valid) {
          expired.push({ platform, reason: res.reason });
          log.warn(`[${platform}] 세션 만료 감지(${res.reason}, 재시도 후 확정) — npm run crosspub:login ${platform} 필요`);
        }
      }
      if (!sessionState[platform].valid) {
        skipped.push({ platform, file, reason: 'session expired' });
        continue;
      }
      const pcfg = cfg.platforms[platform];
      const raw = readFileSync(join(platformDirs(platform).pending, file), 'utf8');
      const { fm } = parseDoc(raw);
      const slug = fm.slug || file.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(new RegExp(`\\.${platform}\\.md$`), '');
      const doc = toDoc(raw, fm.title, pcfg.lang === 'en' ? tags.en : tags.ko);

      const page = await ctx.newPage();
      try {
        const captchaGated = assist && PREPARE[platform];
        let url;
        if (captchaGated) {
          // 하이브리드: 자동으로 내용 채우고 → 사람이 캡차+발행 (캡차 우회 아님)
          log.info(`[${platform}] 내용 자동 입력 중: ${slug}`);
          await PREPARE[platform](page, ctx, doc);
          log.warn(`[${platform}] ▶ 창에서 캡차 체크 + 최종 발행을 눌러주세요 (최대 5분 대기)`);
          url = await waitForHumanPublish(page, platform);
          if (!url) throw new Error('사람 발행 대기 시간 초과(5분) — pending 유지');
        } else {
          log.info(`[${platform}] 자동 게시 시작: ${slug}`);
          url = await DRIVERS[platform](page, ctx, doc, pcfg);
        }
        const rec = recordPosted(platform, file, slug, url);
        appendAudit({ actor: 'crosspub', action: ACTIONS.PUBLISH, reason: `crosspub ${captchaGated ? 'assist' : 'auto'}-posted: ${platform}/${slug} → ${url}` });
        posted.push({ platform, slug, url });
        log.info(`[${platform}] 게시 완료: ${url}`);
      } catch (e) {
        const shot = await snapError(page, platform, slug);
        log.error(`[${platform}] 게시 실패(pending 유지): ${e.message}${shot ? ' — 스크린샷 ' + shot : ''}`);
        failed.push({ platform, slug, error: e.message.slice(0, 200), screenshot: shot });
      } finally {
        await page.close().catch(() => {});
      }
    }
    // 게시 성공 시 세션 스냅샷 갱신 (쿠키 회전 반영 → 세션 수명 연장)
    if (posted.length > 0) await saveSessionState(ctx).catch(() => {});
  } finally {
    await ctx.close().catch(() => {});
  }

  if (posted.length > 0) {
    await notify('CROSSPUB_PENDING', {
      reason: `자동 게시 완료 ${posted.length}건${failed.length ? ` / 실패 ${failed.length}건(pending 유지)` : ''}`,
      details: posted.map(p => `${p.platform}: ${p.url}`).join(' | '),
    }).catch(() => {});
  }

  // 세션 만료 알림 — 조용한 실패를 명확한 액션 알림으로. 대기 건수 + 복구 명령 포함.
  // ⚠ 운영 경보라 RUN_MODE 게이트를 넘겨야 한다. 이 박스는 크리덴셜 누락으로 항상 mock 이라
  // 이 알림이 2026-07-06~23 내내 .mock-out/notify.log 에만 적혔고, 그래서 세션이 죽은 채
  // 17일간 pending 36건이 쌓이는 동안 아무도 몰랐다(2026-07-23 수정).
  if (expired.length > 0) {
    process.env.NOTIFY_FORCE_LIVE = '1';
    for (const e of expired) {
      const pendingN = work.filter(w => w.platform === e.platform).length;
      await notify('CROSSPUB_SESSION_EXPIRED', {
        reason: `⚠ ${e.platform} 세션 만료 — 오늘 ${pendingN}건 미발행(pending 대기)`,
        details: `복구: 터미널에서  npm run crosspub:login ${e.platform}  실행(재로그인) 후 자동 재발행. 사유: ${e.reason}`,
      }).catch(() => {});
      try { appendAudit({ actor: 'crosspub', action: ACTIONS.SESSION_EXPIRED, reason: `${e.platform} (${e.reason}), pending ${pendingN}건 보류` }); }
      catch { /* 감사 실패 비차단 */ }
    }
  }

  process.stdout.write(JSON.stringify({ ok: failed.length === 0, posted, failed, skipped, expired }) + '\n');
  if (failed.length > 0 || expired.length > 0) process.exit(1);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(2); });
}
