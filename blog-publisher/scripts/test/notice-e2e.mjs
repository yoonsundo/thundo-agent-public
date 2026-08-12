/**
 * scripts/test/notice-e2e.mjs — thundorun 공지사항 관리 E2E (tester 산출물)
 * 실행: node --env-file=.env scripts/test/notice-e2e.mjs
 * 전제: repo/thundorun/web dev 서버가 http://localhost:3123 에서
 *       NEXTAUTH_SECRET=아래 SECRET 과 동일하게 기동됨.
 * 검증: 권한(AC7) · CRUD 정상/오류 · 고정 상한 3(AC2) · 해제 후 재고정(AC3) ·
 *       정렬(AC4/D4) · 동시 고정(AC8) · 관리자 UI 전 시나리오 + 콘솔 에러 0.
 * 데이터: '[E2E]' 접두 행만 생성하고 종료 시 전량 삭제(사전/사후 행수 비교).
 */
import { createRequire } from 'module';
const requireWeb = createRequire('/home/user/th-team/repo/thundorun/web/package.json');
const requireBP  = createRequire('/home/user/th-team/blog-publisher/package.json');
const { encode }       = requireWeb('next-auth/jwt');
const { createClient } = requireWeb('@supabase/supabase-js');
const { chromium }     = requireBP('playwright');
import { randomUUID } from 'crypto';

const BASE   = 'http://localhost:3123';
const SECRET = 'notice-mgmt-e2e-test-secret-0123456789abcdef';  // secret-scan: allow 로컬 E2E 더미(실 시크릿 아님 — 사람이 읽는 하이픈 문자열)
const LD     = '/home/user/th-team/blog-publisher/vendor/chromium-libs/root/usr/lib/x86_64-linux-gnu';
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const results = [];
function check(id, desc, cond, detail = '') {
  results.push({ id, desc, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}  ${desc}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { cookie, body, rawBody } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `next-auth.session-token=${cookie}`;
  const res = await fetch(BASE + path, {
    method, headers, redirect: 'manual',
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.clone().json(); } catch { /* non-json */ }
  return { status: res.status, json, location: res.headers.get('location') };
}

async function dbPinned() {
  const { data } = await db.from('notices').select('id, title, pinned, pinned_at').eq('pinned', true);
  return data ?? [];
}
async function dbRow(id) {
  const { data } = await db.from('notices').select('*').eq('id', id).maybeSingle();
  return data;
}

const adminTok = await encode({ token: { name: 'e2e-admin', email: 'e2e-admin@test.local', sub: 'e2e-admin', role: 'admin' }, secret: SECRET });
const userTok  = await encode({ token: { name: 'e2e-user',  email: 'e2e-user@test.local',  sub: 'e2e-user',  role: 'user'  }, secret: SECRET });

// ── 사전 상태: 테이블이 비어있는지 확인 (E2E 잔재 방지) ─────────────────
const { data: pre } = await db.from('notices').select('id, title');
console.log('사전 rows:', (pre ?? []).length, JSON.stringify(pre ?? []));

// ═══ 1. 권한 (AC7) ═══════════════════════════════════════════════════
{
  let r = await api('GET', '/api/admin/notices');
  check('AUTH-1', 'API GET 비로그인 → 401', r.status === 401, `status=${r.status}`);
  r = await api('GET', '/api/admin/notices', { cookie: userTok });
  check('AUTH-2', 'API GET 일반 user role → 401', r.status === 401, `status=${r.status}`);
  r = await api('POST', '/api/admin/notices', { body: { title: 'x', body: 'y' } });
  check('AUTH-3', 'API POST 비로그인 → 401', r.status === 401, `status=${r.status}`);
  r = await api('PUT', '/api/admin/notices', { cookie: userTok, body: { id: 'x', pinned: true } });
  check('AUTH-4', 'API PUT 일반 user role → 401', r.status === 401, `status=${r.status}`);
  r = await api('DELETE', '/api/admin/notices?id=x', { cookie: userTok });
  check('AUTH-5', 'API DELETE 일반 user role → 401', r.status === 401, `status=${r.status}`);
  r = await api('GET', '/admin/notices');
  check('AUTH-6', '페이지 비로그인 → /login 리다이렉트', r.status >= 300 && r.status < 400 && (r.location ?? '').includes('/login'), `status=${r.status} loc=${r.location}`);
  r = await api('GET', '/admin/notices', { cookie: userTok });
  check('AUTH-7', '페이지 일반 user role → /login 리다이렉트', r.status >= 300 && r.status < 400 && (r.location ?? '').includes('/login'), `status=${r.status} loc=${r.location}`);
  r = await api('GET', '/api/admin/notices', { cookie: adminTok });
  check('AUTH-8', 'API GET admin → 200 배열', r.status === 200 && Array.isArray(r.json), `status=${r.status}`);
}

// ═══ 2. CRUD 정상/오류 ═══════════════════════════════════════════════
const ids = {};
async function createNotice(key, title, body, pinned = false) {
  const r = await api('POST', '/api/admin/notices', { cookie: adminTok, body: { title, body, pinned } });
  if (r.status === 200) {
    const { data } = await db.from('notices').select('id').eq('title', title).maybeSingle();
    ids[key] = data?.id;
  }
  return r;
}
{
  let r = await createNotice('N1', '[E2E] 공지 N1', '본문 N1');
  check('CREATE-1', 'POST 정상 생성 N1', r.status === 200 && r.json?.ok === true && !!ids.N1, `status=${r.status}`);
  await sleep(300);
  await createNotice('N2', '[E2E] 공지 N2', '본문 N2');
  await sleep(300);
  await createNotice('N3', '[E2E] 공지 N3', '본문 N3');
  await sleep(300);
  await createNotice('N4', '[E2E] 공지 N4', '본문 N4');
  check('CREATE-1b', 'N2~N4 생성', !!ids.N2 && !!ids.N3 && !!ids.N4);

  r = await api('POST', '/api/admin/notices', { cookie: adminTok, body: { title: '   ', body: 'y' } });
  check('CREATE-2', 'POST 빈 제목 → 400', r.status === 400, `status=${r.status}`);
  r = await api('POST', '/api/admin/notices', { cookie: adminTok, body: { title: 'x'.repeat(121), body: 'y' } });
  check('CREATE-3', 'POST 제목 121자 → 400', r.status === 400, `status=${r.status}`);
  r = await api('POST', '/api/admin/notices', { cookie: adminTok, body: { title: '[E2E] 경계 120자 ' + 'x'.repeat(103), body: '경계 본문' } });
  check('CREATE-4', 'POST 제목 120자 경계 → 200', r.status === 200, `status=${r.status}`);
  if (r.status === 200) {
    const { data } = await db.from('notices').select('id').like('title', '[E2E] 경계 120자%');
    for (const d of data ?? []) await api('DELETE', `/api/admin/notices?id=${d.id}`, { cookie: adminTok });
  }
  r = await api('POST', '/api/admin/notices', { cookie: adminTok, body: { title: 'x', body: '  ' } });
  check('CREATE-5', 'POST 빈 본문 → 400', r.status === 400, `status=${r.status}`);
  r = await api('POST', '/api/admin/notices', { cookie: adminTok, rawBody: '{invalid' });
  check('CREATE-6', 'POST 깨진 JSON → 400', r.status === 400, `status=${r.status}`);

  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N1, title: '[E2E] 공지 N1 수정', body: '본문 N1 수정' } });
  const row = await dbRow(ids.N1);
  check('UPDATE-1', 'PUT 제목/본문 수정 → 200 + DB 반영 (AC5)', r.status === 200 && row?.title === '[E2E] 공지 N1 수정' && row?.body === '본문 N1 수정', `status=${r.status} title=${row?.title}`);
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { title: 'x' } });
  check('UPDATE-2', 'PUT id 없음 → 400', r.status === 400, `status=${r.status}`);
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: randomUUID(), title: 'x' } });
  check('UPDATE-3', 'PUT 미존재 id → 404', r.status === 404, `status=${r.status}`);
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N1 } });
  check('UPDATE-4', 'PUT 변경 필드 없음 → 400', r.status === 400, `status=${r.status}`);
  r = await api('DELETE', '/api/admin/notices', { cookie: adminTok });
  check('DELETE-1', 'DELETE id 없음 → 400', r.status === 400, `status=${r.status}`);
}

// ═══ 3. 고정 상한 (AC2·AC3·AC4·D4·AC8) ═══════════════════════════════
{
  let r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N1, pinned: true } });
  check('PIN-1', 'N1 고정(1/3) → 200', r.status === 200, `status=${r.status}`);
  await sleep(300);
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N2, pinned: true } });
  check('PIN-2', 'N2 고정(2/3) → 200', r.status === 200, `status=${r.status}`);
  await sleep(300);
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N3, pinned: true } });
  check('PIN-3', 'N3 고정(3/3) → 200', r.status === 200, `status=${r.status}`);

  // AC2: 4개째 고정(수정 경로) → 409 + 고정 3건 안내 + DB 3 유지
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N4, pinned: true } });
  const pinnedNow = await dbPinned();
  const n4 = await dbRow(ids.N4);
  check('PIN-CAP-1', '4개째 고정(PUT) → 409 + code=PINNED_CAP (AC2)', r.status === 409 && r.json?.code === 'PINNED_CAP', `status=${r.status} code=${r.json?.code}`);
  check('PIN-CAP-2', '409 응답에 현재 고정 3건 제목 포함 (AC2)', Array.isArray(r.json?.pinned) && r.json.pinned.length === 3, `pinned=${JSON.stringify(r.json?.pinned?.map((p) => p.title))}`);
  check('PIN-CAP-3', 'DB 고정 수 3 유지 + N4 비고정 (AC2)', pinnedNow.length === 3 && n4?.pinned === false && n4?.pinned_at === null, `count=${pinnedNow.length}`);

  // 작성 경로에서도 차단 (R5: 작성·수정 어느 경로든)
  r = await api('POST', '/api/admin/notices', { cookie: adminTok, body: { title: '[E2E] 고정 신규', body: 'x', pinned: true } });
  const ghost = await db.from('notices').select('id').eq('title', '[E2E] 고정 신규');
  check('PIN-CAP-4', '고정 3 상태에서 POST pinned:true → 409 + 행 미생성 (R5)', r.status === 409 && (ghost.data ?? []).length === 0, `status=${r.status} rows=${(ghost.data ?? []).length}`);

  // AC4: 정렬 — 고정 pinned_at↓(N3,N2,N1) → 일반 created_at↓(N4)
  r = await api('GET', '/api/admin/notices', { cookie: adminTok });
  const order = (r.json ?? []).map((n) => n.id);
  const expected = [ids.N3, ids.N2, ids.N1, ids.N4];
  check('SORT-1', '목록 정렬: 고정(pinned_at↓) N3→N2→N1 → 일반 N4 (AC4)', JSON.stringify(order) === JSON.stringify(expected), `got=${JSON.stringify((r.json ?? []).map((n) => n.title))}`);

  // D4: 고정 유지 채 제목 수정 → pinned_at 불변(순서 불변)
  const before = (await dbRow(ids.N2)).pinned_at;
  await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N2, title: '[E2E] 공지 N2 수정', pinned: true } });
  const after = (await dbRow(ids.N2)).pinned_at;
  check('PIN-KEEP', '고정 유지 수정 시 pinned_at 불변 (D4)', before === after, `before=${before} after=${after}`);

  // AC3: 해제 후 재고정
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N1, pinned: false } });
  const n1 = await dbRow(ids.N1);
  check('UNPIN-1', 'N1 해제 → 200 + pinned_at null', r.status === 200 && n1?.pinned === false && n1?.pinned_at === null, `status=${r.status}`);
  r = await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N4, pinned: true } });
  check('REPIN-1', '해제 후 N4 재고정 → 200 성공 (AC3)', r.status === 200, `status=${r.status}`);

  // AC8: 동시 고정 2건 → 최대 1건 성공
  await api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N4, pinned: false } }); // 2개(N2,N3)로 리셋
  const [c1, c2] = await Promise.all([
    api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N1, pinned: true } }),
    api('PUT', '/api/admin/notices', { cookie: adminTok, body: { id: ids.N4, pinned: true } }),
  ]);
  const okCount = [c1, c2].filter((x) => x.status === 200).length;
  const cap409  = [c1, c2].filter((x) => x.status === 409).length;
  const finalPinned = await dbPinned();
  check('CONC-1', '동시 고정 2건(고정 2 상태) → 1 성공 + 1 409, DB=3 (AC8)', okCount === 1 && cap409 === 1 && finalPinned.length === 3, `ok=${okCount} 409=${cap409} db=${finalPinned.length}`);
}

// ═══ 4. UI (Playwright) ═══════════════════════════════════════════════
process.env.LD_LIBRARY_PATH = [LD, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
const browser = await chromium.launch({ headless: true, env: process.env });
const consoleErrors = [];
async function newPage(ctx, tag) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${String(e).slice(0, 200)}`));
  return page;
}
try {
  const adminCtx = await browser.newContext();
  await adminCtx.addCookies([{ name: 'next-auth.session-token', value: adminTok, url: BASE }]);
  const page = await newPage(adminCtx, 'admin');

  // UI-1: 목록 — 고정 우선 정렬·고정 뱃지·n/3 카운터
  await page.goto(`${BASE}/admin/notices`, { waitUntil: 'networkidle', timeout: 60000 });
  const rows = page.locator('table tbody tr');
  const rowCount = await rows.count();
  let badges = 0;
  for (let i = 0; i < Math.min(3, rowCount); i++) badges += await rows.nth(i).getByText('고정', { exact: true }).count();
  const counterVisible = (await page.getByText(/\/\s*3/).count()) > 0;
  check('UI-1a', '목록 4행 렌더', rowCount === 4, `rows=${rowCount}`);
  check('UI-1b', '상위 3행에 고정 뱃지(고정 우선 정렬)', badges === 3, `badges=${badges}`);
  check('UI-1c', 'n/3 고정 카운터 표시', counterVisible);

  // UI-2: 4개째 토글 → PinnedCapCallout
  const lastRow = rows.nth(3);
  const lastTitle = (await lastRow.locator('a').first().textContent())?.trim() ?? '';
  await lastRow.locator('button[role="switch"]').click();
  const callout = page.locator('[role="alert"]');
  await callout.waitFor({ state: 'visible', timeout: 15000 });
  const calloutText = await callout.textContent();
  const liCount = await callout.locator('li').count();
  check('UI-2', '4개째 토글 → 최대3 콜아웃 + 고정 3건 제목 (AC2 UI)', (calloutText ?? '').includes('최대 3개') && liCount === 3, `li=${liCount}`);

  // UI-3: 해제 → 재고정 성공 (AC3 UI)
  await rows.nth(0).locator('button[role="switch"]').click(); // 첫 고정 해제
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: 'networkidle' });
  const targetRow = page.locator('table tbody tr', { hasText: lastTitle });
  await targetRow.locator('button[role="switch"]').click();
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: 'networkidle' });
  const repinned = await page.locator('table tbody tr', { hasText: lastTitle }).getByText('고정', { exact: true }).count();
  check('UI-3', '해제 후 재고정 성공 — 뱃지 표시 (AC3 UI)', repinned >= 1, `badge=${repinned}`);

  // UI-4: 작성 폼 — 빈 제출 검증 → 정상 작성
  await page.goto(`${BASE}/admin/notices/new`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByRole('button', { name: '저장' }).click();
  const titleErr = await page.getByText('제목을 입력하세요').count();
  const bodyErr  = await page.getByText('본문을 입력하세요').count();
  check('UI-4a', '빈 폼 제출 → 인라인 검증 오류 2건', titleErr === 1 && bodyErr === 1, `titleErr=${titleErr} bodyErr=${bodyErr}`);
  await page.getByLabel('공지 제목').fill('[E2E] UI 작성 공지');
  await page.getByLabel('공지 본문').fill('UI 로 작성한 본문입니다.');
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForURL('**/admin/notices', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const created = await page.locator('table tbody tr', { hasText: '[E2E] UI 작성 공지' }).count();
  check('UI-4b', '작성 저장 → 목록 복귀 + 새 행 표시 (AC1 관리자측)', created === 1, `rows=${created}`);

  // UI-5: 수정 폼
  await page.locator('table tbody tr', { hasText: '[E2E] UI 작성 공지' }).locator('a', { hasText: '수정' }).click();
  await page.waitForURL('**/edit', { timeout: 20000 });
  await page.getByLabel('공지 제목').fill('[E2E] UI 수정된 공지');
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForURL('**/admin/notices', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const edited = await page.locator('table tbody tr', { hasText: '[E2E] UI 수정된 공지' }).count();
  check('UI-5', '수정 저장 → 목록에 새 제목 반영 (AC5 UI)', edited === 1, `rows=${edited}`);

  // UI-6: 삭제 모달
  await page.locator('table tbody tr', { hasText: '[E2E] UI 수정된 공지' }).getByRole('button', { name: '삭제' }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await dialog.getByRole('button', { name: '삭제' }).click();
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: 'networkidle' });
  const afterDel = await page.locator('table tbody tr', { hasText: '[E2E] UI 수정된 공지' }).count();
  check('UI-6', '삭제 모달 승인 → 목록에서 제거 (AC6 관리자측)', afterDel === 0, `rows=${afterDel}`);
  await adminCtx.close();

  // UI-7: 일반 user → 리다이렉트
  const userCtx = await browser.newContext();
  await userCtx.addCookies([{ name: 'next-auth.session-token', value: userTok, url: BASE }]);
  const upage = await newPage(userCtx, 'user');
  await upage.goto(`${BASE}/admin/notices`, { waitUntil: 'networkidle', timeout: 60000 });
  check('UI-7', '일반 user 페이지 접근 → /login (AC7 UI)', upage.url().includes('/login'), `url=${upage.url()}`);
  await userCtx.close();

  // UI-8: 비로그인 → 리다이렉트
  const anonCtx = await browser.newContext();
  const apage = await newPage(anonCtx, 'anon');
  await apage.goto(`${BASE}/admin/notices`, { waitUntil: 'networkidle', timeout: 60000 });
  check('UI-8', '비로그인 페이지 접근 → /login (AC7 UI)', apage.url().includes('/login'), `url=${apage.url()}`);
  await anonCtx.close();
} finally {
  await browser.close();
}
check('CONSOLE', '브라우저 콘솔 에러 0건', consoleErrors.length === 0, `${consoleErrors.length}건${consoleErrors.length ? ': ' + consoleErrors.slice(0, 5).join(' | ') : ''}`);

// ═══ 5. 정리 — E2E 데이터 전량 삭제 ═══════════════════════════════════
const { data: leftovers } = await db.from('notices').select('id, title').like('title', '[E2E]%');
for (const row of leftovers ?? []) await db.from('notices').delete().eq('id', row.id);
const { data: post } = await db.from('notices').select('id');
check('CLEANUP', 'E2E 데이터 정리 — 사전 행수로 복원', (post ?? []).length === (pre ?? []).length, `rows=${(post ?? []).length}`);

// ═══ 요약 ═════════════════════════════════════════════════════════════
const fails = results.filter((r) => !r.pass);
console.log(`\n==== 결과: ${results.length - fails.length}/${results.length} PASS ====`);
if (fails.length) { console.log('FAILED:', JSON.stringify(fails, null, 1)); process.exit(1); }
