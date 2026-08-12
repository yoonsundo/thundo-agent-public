#!/usr/bin/env node
/**
 * crosspub/keepalive.mjs — 티스토리 세션 keep-alive (재로그인 빈도 최소화)
 *
 * 주기 cron(예: 4시간마다)이 호출. 각 auto_post 플랫폼의 세션을 실검증하고,
 * 살아있으면 방문(verifySession 이 manage 페이지 로드)으로 세션을 깨워둔 뒤
 * storageState 스냅샷을 재저장한다. 티스토리가 idle-timeout 방식이면 이 주기 방문이
 * 세션을 계속 연장 → 재로그인 빈도 급감. (hard-timeout 방식이면 연장 한계는 있음.)
 *
 * 세션이 죽었으면 여기선 알림하지 않는다(일일 auto-post 가 CROSSPUB_SESSION_EXPIRED
 * 로 이미 경보) — 다만 로그로 남겨 관찰 가능하게 한다.
 *
 * 계약: stdout JSON 1줄 {ok, results:{platform:'alive'|'expired'|'error'}}
 *       exit 0=정상(만료 포함) / 2=치명
 */
import { makeLogger } from '../lib/log.mjs';
import { openContext, saveSessionState, verifySession } from './browser/context.mjs';
import { loadCrosspubConfig, enabledPlatforms } from './lib.mjs';

const log = makeLogger('crosspub/keepalive');

async function main() {
  let cfg;
  try { cfg = loadCrosspubConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }

  const platforms = enabledPlatforms(cfg).filter(p => cfg.platforms[p]?.auto_post);
  if (platforms.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, results: {}, reason: 'auto_post 플랫폼 없음' }) + '\n');
    return;
  }

  const results = {};
  for (const platform of platforms) {
    const ctx = await openContext({ headed: false });
    try {
      const res = await verifySession(ctx, platform, cfg.platforms[platform]?.blog_host);
      if (res.valid) {
        // 방문으로 세션 갱신됨 → 회전된 쿠키까지 스냅샷 재저장(sliding session 연장)
        await saveSessionState(ctx).catch(() => {});
        results[platform] = 'alive';
        log.info(`[${platform}] 세션 살아있음 — 방문+스냅샷 갱신(세션 연장)`);
      } else {
        results[platform] = 'expired';
        log.warn(`[${platform}] 세션 만료(${res.reason}) — 재로그인 필요(일일 런이 경보). keep-alive는 갱신 불가`);
      }
    } catch (e) {
      results[platform] = 'error';
      log.error(`[${platform}] keep-alive 오류: ${e.message.slice(0, 120)}`);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  process.stdout.write(JSON.stringify({ ok: true, results }) + '\n');
}

main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(2); });
