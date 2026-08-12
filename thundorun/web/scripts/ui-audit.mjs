/**
 * ui-audit.mjs — 앱 환경(모바일 우선) UI 전수 감사 v3
 *
 * 왜 v3 인가: v1 은 가로 오버플로만 봐서 '글자가 세로로 쌓이는' 결함을 전부 통과시켰고,
 * v2 는 세로 꺾임을 잡았지만 **정적 라우트 16개만** 돌았다. 실제 사고는 v2 가 안 본 곳에서
 * 났다 — /reports, /saju/amond, 그리고 '클릭해야 열리는' 다이얼로그.
 * v3 은 (a) 정적 라우트 전수 (b) 상호작용으로만 도달하는 상태까지 연다.
 *
 * 검출 3종:
 *   ① 가로 오버플로  — documentElement.scrollWidth > innerWidth
 *   ② 세로 꺾임      — 텍스트 줄 상자를 y 로 묶어 실제 줄 수 산출, 줄당 글자수가 과소하면 위반
 *   ③ 뷰포트 이탈    — 보이는 요소의 right 가 뷰포트를 넘음(다이얼로그가 화면 밖으로 나가는 유형)
 *
 * env: AUDIT_ID/AUDIT_PW(감사용 관리자 계정), AUDIT_BASE(기본 http://localhost:3190),
 *      SHOTS_DIR(위반 스크린샷), CHROMIUM_LIBS(시스템 chromium 라이브러리가 없는 박스에서 vendor 경로)
 */
import { chromium } from 'playwright';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BASE = process.env.AUDIT_BASE || 'http://localhost:3190';
const ID = process.env.AUDIT_ID, PW = process.env.AUDIT_PW;
const SHOTS = process.env.SHOTS_DIR || '/tmp/ui-shots';
if (!ID || !PW) { console.error('AUDIT_ID/AUDIT_PW 필요'); process.exit(2); }
mkdirSync(SHOTS, { recursive: true });

/** 정적 라우트 전수 — src/app 을 직접 훑는다.
    손으로 적은 목록은 라우트가 늘어날 때마다 조용히 어긋난다(실제로 /saju/amond/login 이 빠져 있었다).
    제외: 동적 세그먼트([param])·api. 라우트 그룹((site) 등)은 URL 에 나타나지 않으므로 접는다. */
function discoverRoutes(root) {
  const out = [];
  const walk = (dir, route) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('[') || e.name === 'api') continue;
        const seg = /^\(.*\)$/.test(e.name) ? '' : `/${e.name}`;
        walk(join(dir, e.name), route + seg);
      } else if (e.name === 'page.tsx') {
        out.push(route || '/');
      }
    }
  };
  walk(root, '');
  return [...new Set(out)].sort();
}
const ROUTES = discoverRoutes(fileURLToPath(new URL('../src/app', import.meta.url)));

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  // 430px = 아이폰 Pro Max 계열 논리폭. 390 만 보면 '390 에선 접히고 430 에선 버튼 하나만
  // 다음 줄로 떨어지는' 중간 폭 결함을 놓친다(실제로 채팅 전송 버튼이 그랬다).
  { name: 'mobile-430', width: 430, height: 932 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desk-1280', width: 1280, height: 800 },
];

/** 페이지 안에서 실행 — 세로 꺾임 + 뷰포트 이탈을 함께 수집. */
const DETECT = () => {
  const stacked = [];
  const escaped = [];
  const vw = window.innerWidth;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;

    // ③ 뷰포트 이탈 — 스크롤 컨테이너 안(정상적인 가로 스크롤)은 제외한다.
    if (r.right > vw + 1) {
      let inScroller = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX === 'auto' || ps.overflowX === 'scroll' || ps.overflowX === 'hidden') { inScroller = true; break; }
      }
      if (!inScroller && el.children.length === 0) {
        escaped.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40),
          text: (el.textContent || '').trim().slice(0, 20), right: Math.round(r.right) });
      }
    }

    // ② 세로 꺾임 — 텍스트 leaf 만
    if (el.children.length > 0) continue;
    const text = (el.textContent || '').trim();
    if (text.length < 2) continue;
    if (cs.writingMode && cs.writingMode !== 'horizontal-tb') continue;
    const fs = parseFloat(cs.fontSize) || 14;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
    // getClientRects 는 '줄'이 아니라 '텍스트 런'을 준다(숫자+한글이면 한 줄인데 2개).
    // y 로 묶어야 진짜 줄 수가 나온다.
    const byLine = new Map();
    for (const b of rects) byLine.set(Math.round(b.top), (byLine.get(Math.round(b.top)) || 0) + b.width);
    if (byLine.size < 2) continue;
    const widest = Math.max(...byLine.values());
    // 문단 안 인라인(<strong> 등)이 줄 끝에서 어절 경계로 접히는 것은 정상 흐름이지 결함이 아니다.
    // 판별: 요소 자신의 박스가 넓은데(=여러 줄에 걸친 인라인) 줄만 짧으면 흐름,
    // 박스 자체가 좁으면 컨테이너에 눌린 진짜 세로쌓임이다.
    if (r.width > widest + 4) continue;
    if (widest / fs <= 3.2) {
      stacked.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40),
        text: text.slice(0, 20), lines: byLine.size, perLine: +(widest / fs).toFixed(2) });
    }
  }
  return { stacked, escaped, overflow: document.documentElement.scrollWidth - vw };
};

// 이 박스엔 chromium 시스템 라이브러리(libnspr4 등)가 없어 vendor .deb 를 LD 로 주입해 쓴다.
// Playwright 는 브라우저를 자식 프로세스로 띄우므로 launch 전에 세팅하면 그대로 상속된다.
// (sudo 없이 헤드리스를 돌리기 위한 이 저장소의 기존 우회 — crosspub·shorts 와 같은 방식)
if (process.env.CHROMIUM_LIBS) {
  process.env.LD_LIBRARY_PATH = [process.env.CHROMIUM_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const browser = await chromium.launch();
const fails = [];
// 실제로 검사에 성공한 라우트 수. 서버가 죽어 전부 건너뛰면 위반 0 으로 통과해 버리므로
// 커버리지 자체를 결과에 포함한다.
let checked = 0;

async function check(page, label, vp) {
  await page.waitForTimeout(350);
  const r = await page.evaluate(DETECT);
  const bad = r.overflow > 1 || r.stacked.length || r.escaped.length;
  if (r.overflow > 1) fails.push(`${vp.name} ${label}: 가로 오버플로 ${r.overflow}px`);
  for (const s of r.stacked) fails.push(`${vp.name} ${label}: 세로꺾임 <${s.tag} class="${s.cls}"> "${s.text}" ${s.lines}줄 줄당${s.perLine}자`);
  for (const s of r.escaped.slice(0, 5)) fails.push(`${vp.name} ${label}: 뷰포트이탈 <${s.tag} class="${s.cls}"> "${s.text}" right=${s.right}`);
  checked += 1;
  console.log(`${bad ? '  ✗ ' : '  ok '}${vp.name.padEnd(11)} ${label.padEnd(26)} 넘침${r.overflow} 꺾임${r.stacked.length} 이탈${r.escaped.length}`);
  if (bad) await page.screenshot({ path: join(SHOTS, `bad-${vp.name}-${label.replace(/[^\w가-힣]+/g, '_')}.png`) });
  return !bad;
}

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const lp = await ctx.newPage();
  await lp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await lp.fill('#login-id', ID); await lp.fill('#login-pw', PW);
  await Promise.all([lp.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 }), lp.click('button[type="submit"]')]);
  await lp.close();

  const page = await ctx.newPage();
  for (const route of ROUTES) {
    try { await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 30000 }); }
    catch { await page.waitForTimeout(1500); }
    // 인증이 깨지면 모든 보호 라우트가 '로그인 화면'으로 바뀐다 — 그 화면은 당연히 결함이 없어
    // 감사가 전부 통과로 나온다(거짓 green). /admin 뿐 아니라 모든 라우트에서 이탈을 잡는다.
    // 인증이 깨지면 보호 라우트가 전부 '로그인 화면'으로 바뀐다 — 그 화면엔 당연히 결함이 없어
    // 감사가 통과로 나온다(거짓 green). 반면 결과 페이지가 선행 입력이 없어 부모로 돌아가는 것은
    // 정상 동작이다. 둘을 구분한다: 로그인/인증오류로 튕기면 실패, 그 외 리다이렉트는 건너뜀.
    const landed = page.url().replace(BASE, '') || '/';
    const onRoute = landed === route || landed.startsWith(route + '?') || landed.startsWith(route + '/');
    if (!onRoute) {
      if (landed.startsWith('/login') || landed.startsWith('/api/auth/error')) {
        fails.push(`${vp.name} ${route}: 인증 실패 → ${landed} (세션이 죽으면 전 라우트가 거짓 통과한다)`);
      } else {
        console.log(`  -- ${vp.name.padEnd(11)} ${route.padEnd(26)} 선행 상태 필요 → ${landed}, 건너뜀`);
      }
      continue;
    }
    await check(page, route, vp);
  }

  // ── 상호작용으로만 도달하는 상태 ────────────────────────────────────────────
  // 1) 오케스트레이션 상세 다이얼로그 — '상세' 링크 클릭
  try {
    await page.goto(`${BASE}/admin/orchestrator`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);
    const detail = page.locator('button, a').filter({ hasText: /^상세$/ }).first();
    if (await detail.count()) {
      await detail.click({ timeout: 8000 });
      await page.waitForSelector('.dialog', { timeout: 8000 });
      await page.waitForTimeout(900);
      await check(page, '/admin/orchestrator[상세다이얼로그]', vp);
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      console.log(`  -- ${vp.name} 상세 링크 없음(데이터 없음) — 건너뜀`);
    }
  } catch (e) { fails.push(`${vp.name} 상세 다이얼로그 열기 실패: ${String(e).slice(0, 80)}`); }

  // 2) 새 요청 다이얼로그
  try {
    // networkidle 은 폴링이 돌면 영영 안 온다 — 로드 후 정착 대기로 바꾼다.
    await page.goto(`${BASE}/admin/orchestrator`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    const nw = page.locator('button').filter({ hasText: /새 ?요청/ }).first();
    if (await nw.count()) {
      await nw.click({ timeout: 8000 });
      await page.waitForSelector('.dialog', { timeout: 8000 });
      await check(page, '/admin/orchestrator[새요청]', vp);
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (e) { fails.push(`${vp.name} 새요청 다이얼로그 실패: ${String(e).slice(0, 80)}`); }

  // 3) 채팅 입력 상태 — placeholder 잘림은 정적 렌더에도 보이지만, 입력 후 높이 변화도 본다
  try {
    await page.goto(`${BASE}/admin/chat`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    const ta = page.locator('textarea').first();
    if (await ta.count()) {
      await ta.fill('테스트 메시지입니다. 입력창이 잘리지 않는지 확인합니다.');
      await check(page, '/admin/chat[입력]', vp);
    }
  } catch (e) { fails.push(`${vp.name} 채팅 입력 실패: ${String(e).slice(0, 80)}`); }

  await ctx.close();
}
await browser.close();
// 커버리지 게이트 — 선행 상태가 필요한 결과 페이지 몇 개는 정상적으로 건너뛰므로 80% 를 임계로 둔다.
const expected = ROUTES.length * VIEWPORTS.length;
if (checked < expected * 0.8) {
  fails.push(`검사된 라우트 ${checked}/${expected}건 — 서버 미기동·네비 실패 의심(거짓 green 방지)`);
}
console.log(`검사 커버리지 ${checked}/${expected} (라우트 ${ROUTES.length}개 × 뷰포트 ${VIEWPORTS.length})`);
console.log(fails.length ? `\n위반 ${fails.length}건:\n- ${fails.join('\n- ')}` : '\n전 라우트·상호작용 상태 — 넘침·꺾임·이탈 0');
process.exit(fails.length ? 1 : 0);
