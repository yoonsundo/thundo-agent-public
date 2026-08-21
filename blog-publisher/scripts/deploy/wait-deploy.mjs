/**
 * deploy/wait-deploy.mjs — 배포 URL 폴링
 * §D5 발행증거: URL 200 확인 (e2).
 * mock: 즉시 skip (배포 없음).
 * live: SITE_BASE_URL 또는 인자 URL을 최대 90s 폴링.
 */

import { isMock, env } from '../lib/config.mjs';
import { makeLogger }  from '../lib/log.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('deploy/wait');

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS       = 90_000;

// ─── 단순 HTTP GET 2xx 확인 ───────────────────────────────────────────────────

async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'blog-publisher-deploy-check/1.0' },
      signal:  AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * waitDeploy(url?, opts?) → { ok, status, elapsed_ms, url, skipped? }
 * opts: { timeoutMs?, intervalMs?, slug? }
 * mock: 즉시 { ok: true, skipped: true } 반환.
 * live: 200 응답까지 폴링. timeout 초과 시 { ok: false }.
 */
export async function waitDeploy(url, opts = {}) {
  // forceLive: 데몬이 mock(GITHUB/VERCEL 토큰 누락 등)이어도, 실제로 일어난 배포(예: 오케 finalize
  // 는 git push·마이그레이션을 진짜로 수행)의 사후 검증만은 실제 HTTP GET 으로 한다 — URL 200
  // 확인은 토큰이 필요 없고, 검증을 건너뛰고 "배포 확인됨"이라 단정하던 가짜 성공보고를 막는다.
  if (isMock() && !opts.forceLive) {
    log.info('mock 모드 — 배포 폴링 스킵');
    return { ok: true, skipped: true, url: url || '(mock)', status: 200, elapsed_ms: 0 };
  }

  const targetUrl = url
    || (opts.slug ? `${env('SITE_BASE_URL', 'https://example.com')}/blog/${opts.slug}` : null)
    || env('SITE_BASE_URL', '');

  if (!targetUrl) {
    log.warn('URL 없음 — 폴링 스킵');
    return { ok: false, skipped: true, url: '', status: null, elapsed_ms: 0, error: 'URL 없음' };
  }

  const timeout  = opts.timeoutMs  || TIMEOUT_MS;
  const interval = opts.intervalMs || POLL_INTERVAL_MS;
  const start    = Date.now();

  log.info(`폴링 시작: ${targetUrl} (최대 ${timeout / 1000}s)`);

  while (Date.now() - start < timeout) {
    const { ok, status, error } = await checkUrl(targetUrl);
    const elapsed = Date.now() - start;

    if (ok) {
      log.info(`배포 확인 완료 — ${status} (${elapsed}ms)`);
      return { ok: true, status, elapsed_ms: elapsed, url: targetUrl };
    }

    log.info(`${status ?? 'ERR'} (${elapsed}ms) — ${error || '재시도'}`);

    const remaining = timeout - (Date.now() - start);
    if (remaining <= 0) break;
    await new Promise(r => setTimeout(r, Math.min(interval, remaining)));
  }

  const elapsed = Date.now() - start;
  log.error(`타임아웃 — ${elapsed}ms 후 응답 없음: ${targetUrl}`);
  return { ok: false, status: null, elapsed_ms: elapsed, url: targetUrl, error: 'TIMEOUT' };
}

// CLI
if (isMainModule(import.meta.url)) {
  const url = process.argv[2];
  waitDeploy(url).then(r => {
    log.info(JSON.stringify(r, null, 2));
    if (!r.ok && !r.skipped) process.exit(1);
  });
}
