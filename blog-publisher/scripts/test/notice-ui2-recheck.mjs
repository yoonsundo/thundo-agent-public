// UI-2 재검증 — PinnedCapCallout 을 텍스트 앵커로 정확히 조준 (route-announcer 오탐 배제)
import { createRequire } from 'module';
const requireWeb = createRequire('/home/user/th-team/repo/thundorun/web/package.json');
const requireBP  = createRequire('/home/user/th-team/blog-publisher/package.json');
const { encode }       = requireWeb('next-auth/jwt');
const { createClient } = requireWeb('@supabase/supabase-js');
const { chromium }     = requireBP('playwright');
const BASE = 'http://localhost:3123';
const SECRET = 'notice-mgmt-e2e-test-secret-0123456789abcdef';  // secret-scan: allow 로컬 E2E 더미(실 시크릿 아님 — 사람이 읽는 하이픈 문자열)
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const adminTok = await encode({ token: { name: 'e2e-admin', email: 'e2e-admin@test.local', sub: 'e2e-admin', role: 'admin' }, secret: SECRET });

// 데이터 셋업: 4건 생성, 3건 고정 (API)
const mk = async (t, pinned) => fetch(BASE + '/api/admin/notices', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `next-auth.session-token=${adminTok}` }, body: JSON.stringify({ title: t, body: 'ui2 재검증', pinned }) });
await mk('[E2E-UI2] P1', true); await mk('[E2E-UI2] P2', true); await mk('[E2E-UI2] P3', true); await mk('[E2E-UI2] U4', false);

process.env.LD_LIBRARY_PATH = ['/home/user/th-team/blog-publisher/vendor/chromium-libs/root/usr/lib/x86_64-linux-gnu', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const browser = await chromium.launch({ headless: true, env: process.env });
const errs = [];
try {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'next-auth.session-token', value: adminTok, url: BASE }]);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  await page.goto(BASE + '/admin/notices', { waitUntil: 'networkidle', timeout: 60000 });
  const row = page.locator('table tbody tr', { hasText: '[E2E-UI2] U4' });
  await row.locator('button[role="switch"]').click();
  const anchor = page.getByText('고정은 최대 3개입니다', { exact: false });
  await anchor.waitFor({ state: 'visible', timeout: 15000 });
  // 콜아웃 컨테이너( role=alert 중 해당 텍스트를 포함하는 것 ) 안의 li 3개 확인
  const callout = page.locator('[role="alert"]', { hasText: '최대 3개' });
  const li = await callout.locator('li').count();
  const titles = await callout.locator('li').allTextContents();
  console.log('callout visible: true, li:', li, 'titles:', JSON.stringify(titles));
  await page.screenshot({ path: '/home/user/th-team/blog-publisher/runs/2026-07-07/notice-ui2-callout.png', fullPage: false });
  // 닫기 버튼 동작
  await callout.getByRole('button', { name: '안내 닫기' }).click();
  await page.waitForTimeout(500);
  const gone = await page.locator('[role="alert"]', { hasText: '최대 3개' }).count();
  console.log('dismiss 후 callout count:', gone);
  console.log('console errors:', JSON.stringify(errs));
  console.log('RESULT:', li === 3 && gone === 0 ? 'PASS' : 'FAIL');
} finally { await browser.close(); }
// 정리
const { data } = await db.from('notices').select('id').like('title', '[E2E-UI2]%');
for (const r of data ?? []) await db.from('notices').delete().eq('id', r.id);
const { data: left } = await db.from('notices').select('id');
console.log('cleanup 후 rows:', (left ?? []).length);
