#!/usr/bin/env node
/**
 * hub-dashboard-xss.test.mjs — 허브 대시보드 타임라인 XSS 회귀 테스트(실브라우저).
 *
 * 배경(2026-08-19 감사): 타임라인은 `ul.innerHTML = list.map(...)` 로 레코드를 그대로 붙였다.
 * 레코드 본문은 에이전트 산출물·봇 메시지에서 오고 그 원재료는 Reddit/HN 수집물과 LLM 출력이다.
 * 즉 레코드 한 건으로 대시보드에서 스크립트가 실행됐고, 같은 화면의 토큰 입력값을 읽어
 * POST 명령(파이프라인 중단·주제 승인)까지 낼 수 있었다.
 *
 * 이 테스트는 **스토어에 쓰지 않는다** — /api/timeline 응답만 가로채 악성 레코드를 주입한다.
 */
import { chromium } from 'playwright';
import { startServer } from '../hub/server.mjs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 이 박스의 chromium 은 시스템 공유 라이브러리가 없어 vendor/chromium-libs 를 LD 경로에 얹어야 뜬다
// (sudo 불가 환경의 확립된 우회 — scripts/shorts/slides.mjs 와 동일).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR = join(ROOT, 'vendor', 'chromium-libs', 'root', 'usr', 'lib', 'x86_64-linux-gnu');
const launchEnv = existsSync(VENDOR)
  ? { ...process.env, LD_LIBRARY_PATH: [VENDOR, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
  : process.env;

const PORT = Number(process.env.XSS_TEST_PORT || 18795);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
};

const server = startServer(PORT, '127.0.0.1');
await new Promise(r => setTimeout(r, 600));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], env: launchEnv });
const page = await browser.newPage();
let xssFired = false;
page.on('dialog', async d => { xssFired = true; await d.dismiss(); });
await page.exposeFunction('__xssBeacon', () => { xssFired = true; });

await page.route('**/api/timeline*', route => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify([
    { ts: '2026-08-19T00:00:00Z', type: 'answer',
      answer: '<img src=x onerror="window.__xssBeacon&&window.__xssBeacon()">악성 레코드' },
    { ts: '2026-08-19T00:01:00Z', type: '<script>window.__xssBeacon&&window.__xssBeacon()</script>',
      answer: '두 번째' },
  ]),
}));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const imgCount = await page.locator('#timeline-list img').count().catch(() => -1);
const scriptCount = await page.locator('#timeline-list script').count().catch(() => -1);
const text = await page.$eval('#timeline-list', el => el.textContent).catch(() => '');

console.log('\n[대시보드 타임라인 — 악성 레코드 주입]');
ok('스크립트가 실행되지 않는다', !xssFired);
ok('주입된 <img> 가 DOM 요소로 생성되지 않는다', imgCount === 0, `img=${imgCount}`);
ok('주입된 <script> 가 DOM 요소로 생성되지 않는다', scriptCount === 0, `script=${scriptCount}`);
ok('악성 마크업이 텍스트로 표시된다', /<img src=x/.test(text), text.slice(0, 80));

// 대조군 — 같은 페이지에서 이스케이프 없이 innerHTML 에 넣으면 실제로 요소가 생성된다.
// (이 가드가 "있어도 그만"이 아니라는 근거. 실행은 하지 않고 요소 생성만 확인한다.)
const rawImgCount = await page.evaluate(() => {
  const ul = document.getElementById('timeline-list');
  ul.innerHTML = '<li><span>' + '<img src=x data-control="1">' + '</span></li>';
  return ul.querySelectorAll('img').length;
});
ok('대조군: 이스케이프 없으면 요소가 생성된다(취약성 실재 확인)', rawImgCount === 1, `img=${rawImgCount}`);

await browser.close();
server.close();

console.log(`\n대시보드 XSS: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
