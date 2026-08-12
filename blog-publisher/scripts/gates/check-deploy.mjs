#!/usr/bin/env node
/**
 * check-deploy.mjs — 배포 URL GET 2xx 확인 (3회 재시도, 30s timeout)
 * 입력: argv[2] = URL (없거나 mock이면 graceful skip)
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 */

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 3_000;

function isMockOrEmpty(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower === 'mock' || lower === 'skip' || lower === 'none' || lower === '-';
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300 };
  } catch (e) {
    return { status: null, ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const url = process.argv[2];

  if (isMockOrEmpty(url)) {
    const result = {
      gate: 'deploy',
      pass: true,
      reason: 'URL 없음 또는 mock — graceful skip',
      evidence: { url: url ?? null, status: null, note: 'skipped' },
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  }

  // URL 유효성 기본 체크
  try {
    new URL(url);
  } catch {
    process.stderr.write(`check-deploy: 유효하지 않은 URL: ${url}\n`);
    process.exit(2);
  }

  let lastResult = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    process.stderr.write(`check-deploy: 시도 ${attempt}/${MAX_RETRIES} — ${url}\n`);
    lastResult = await fetchWithTimeout(url, TIMEOUT_MS);
    if (lastResult.ok) break;
    if (attempt < MAX_RETRIES) {
      process.stderr.write(`check-deploy: ${lastResult.status ?? 'timeout/error'} — ${RETRY_DELAY_MS}ms 후 재시도\n`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  const pass = lastResult.ok;
  const result = {
    gate: 'deploy',
    pass,
    reason: pass
      ? `URL 응답 ${lastResult.status} OK`
      : `URL 응답 실패: ${lastResult.status ?? 'timeout/error'} (${lastResult.error ?? ''})`,
    evidence: {
      url,
      status: lastResult.status,
    },
  };

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(pass ? 0 : 1);
}

main();
