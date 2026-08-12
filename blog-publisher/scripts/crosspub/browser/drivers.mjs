/**
 * crosspub/browser/drivers.mjs — 플랫폼별 자동 게시 드라이버
 *
 * 각 드라이버: (page, ctx, doc, platformCfg) → 게시된 글 URL 반환.
 * doc: { title, bodyMd, bodyHtml, tags }
 *
 * 플랫폼 에디터 DOM 은 예고 없이 바뀐다 — 실패 시 스크린샷을 남기고 throw,
 * 호출자(auto-post)는 pending 을 그대로 두어 반자동 폴백이 되게 한다.
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { platformDirs } from '../lib.mjs';

const NAV_TIMEOUT = 60_000;

/** 티스토리 발행 레이어의 태그 입력란(#tagText)에 태그를 하나씩 추가 */
async function fillTistoryTags(page, tags) {
  if (!tags || !tags.length) return 0;
  const input = page.locator('#tagText, input[placeholder="태그입력"]').first();
  if (!(await input.isVisible({ timeout: 3000 }).catch(() => false))) return 0;
  let added = 0;
  for (const tag of tags.slice(0, 10)) {
    const t = String(tag).trim();
    if (!t) continue;
    await input.click().catch(() => {});
    await input.fill(t).catch(() => {});
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    added++;
  }
  return added;
}

/**
 * 티스토리 카테고리 드롭다운(제목 위 `카테고리 ⌄`)을 연다.
 * TinyMCE listbox 라 클릭하면 `.mce-menu-item` 목록이 뜬다.
 */
async function openTistoryCategoryMenu(page) {
  const box = page.locator('.btn-category .mce-listbox, .btn-category .mce-btn').first();
  if (await box.isVisible({ timeout: 2000 }).catch(() => false)) {
    await box.click().catch(() => {});
  } else {
    await page.mouse.click(374, 132); // 폴백: 제목 위 카테고리 박스 좌표
  }
  await page.waitForTimeout(800);
}

/** 티스토리 카테고리 선택 — config 지정값과 일치하는 항목 선택(없으면 graceful 스킵) */
async function selectTistoryCategory(page, category) {
  if (!category) return { selected: false, reason: 'category 미지정' };
  await openTistoryCategoryMenu(page);
  const item = page.locator(`.mce-menu-item:has-text("${category}")`).first();
  if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
    await item.click().catch(() => {});
    await page.waitForTimeout(300);
    return { selected: true };
  }
  await page.keyboard.press('Escape').catch(() => {}); // 미발견 시 메뉴 닫아 간섭 방지
  return { selected: false, reason: `카테고리 '${category}' 목록에 없음` };
}

/** 선택 가능한 카테고리 목록(운영자 config 참고용 로그) */
async function listTistoryCategories(page) {
  await openTistoryCategoryMenu(page);
  const cats = await page.evaluate(() =>
    [...document.querySelectorAll('.mce-menu-item .mce-text')]
      .map(e => (e.textContent || '').trim())
      .filter(t => t && t !== '카테고리 없음').slice(0, 20)
  ).catch(() => []);
  await page.keyboard.press('Escape').catch(() => {});
  return cats;
}

/** iframe 본문 커서 위치에 HTML 조각을 클립보드 붙여넣기 */
async function pasteHtmlAtCursor(page, html) {
  await page.evaluate(async (h) => {
    const item = new ClipboardItem({
      'text/html': new Blob([h], { type: 'text/html' }),
      'text/plain': new Blob([h.replace(/<[^>]+>/g, ' ')], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, html);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(600);
}

/** 실패 진단용 스크린샷 — state/crosspub-queue/<platform>/error-*.png */
export async function snapError(page, platform, tag) {
  try {
    const dir = platformDirs(platform).root;
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `error-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch { return null; }
}

/** 첫 셀렉터 매칭을 기다린다 (후보 목록 순회) */
async function firstVisible(page, selectors, timeout = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`셀렉터 미발견: ${selectors.join(' | ')}`);
}

/**
 * 페이지 안에서 "보이는" CodeMirror 인스턴스에 마크다운을 주입한다.
 * 티스토리·velog 모두 .CodeMirror 가 2개 이상(제목/본문·미리보기)일 수 있어
 * offsetParent(가시성)로 본문 에디터를 고르고, React/에디터가 빈 글로
 * 오인하지 않도록 input 이벤트를 발생시킨다.
 */
async function injectMarkdown(page, md, { preferClass = null, timeout = 20_000 } = {}) {
  await page.waitForFunction(() => document.querySelectorAll('.CodeMirror').length > 0, { timeout }).catch(() => {});
  const ok = await page.evaluate(({ text, preferClass }) => {
    const els = [...document.querySelectorAll('.CodeMirror')].filter(el => el.CodeMirror);
    // 1) 지정 클래스(예: 마크다운 스킨) 우선 — headless 에선 offsetParent 가 다 null 이라
    //    가시성 대신 "활성 모드에 맞는 인스턴스"를 클래스로 특정해야 정확하다.
    let target = preferClass ? els.find(el => el.className.includes(preferClass)) : null;
    // 2) 없으면 보이는 인스턴스, 3) 그래도 없으면 첫 인스턴스
    if (!target) target = els.find(el => el.offsetParent !== null) || els[0];
    if (!target) return false;
    const cm = target.CodeMirror;
    cm.setValue(text);
    cm.getInputField().dispatchEvent(new Event('input', { bubbles: true }));
    cm.save?.();  // textarea 동기화(있으면)
    return true;
  }, { text: md, preferClass });
  if (!ok) throw new Error('CodeMirror 본문 인스턴스 미발견');
}

// ─── velog ────────────────────────────────────────────────────────────────────
// 에디터: CodeMirror(마크다운) — DOM 노출 인스턴스에 setValue 로 주입(가장 견고).
export async function postVelog(page, ctx, doc) {
  await page.goto('https://velog.io/write', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

  const title = await firstVisible(page, ['textarea[placeholder*="제목"]']);
  await title.fill(doc.title);

  await injectMarkdown(page, doc.bodyMd);

  // 태그 입력 (선택)
  try {
    const tagInput = page.locator('input[placeholder*="태그"]').first();
    if (await tagInput.isVisible({ timeout: 2000 })) {
      for (const t of doc.tags.slice(0, 4)) {
        await tagInput.fill(t);
        await page.keyboard.press('Enter');
      }
    }
  } catch { /* 태그는 선택사항 */ }

  // 1차 출간하기 → 설정 패널 → 최종 출간하기
  await page.locator('button:has-text("출간하기")').first().click();
  await page.waitForTimeout(1500);
  const finalBtn = page.locator('button:has-text("출간하기")').last();
  await finalBtn.click();

  await page.waitForURL(/velog\.io\/@[^/]+\/.+/, { timeout: NAV_TIMEOUT });
  return page.url();
}

// ─── tistory ──────────────────────────────────────────────────────────────────
// 새 에디터, HTML 모드에 md-to-html 산출물 주입(마크다운 모드보다 모드전환이 단순).
export async function postTistory(page, ctx, doc, platformCfg) {
  const host = platformCfg.blog_host;
  if (!host) throw new Error('config.platforms.tistory.blog_host 필요 (예: thundo.tistory.com)');

  // 임시저장 복원/모드전환 confirm 은 전부 수락
  page.on('dialog', d => d.accept().catch(() => {}));

  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `https://${host}` });
  await page.goto(`https://${host}/manage/newpost/?type=post`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(4000);

  // 기본(리치) 에디터 유지 — 마크다운 CodeMirror 는 프로그램 주입이 저장에 반영 안 됨.
  // TinyMCE 계열 iframe 본문(editor-tistory_ifr)에 HTML 을 붙여넣으면 네이티브 저장됨.
  const title = await firstVisible(page, ['textarea[placeholder*="제목"]', '#post-title-inp', '.textarea_tit']);
  await title.fill(doc.title);

  const frame = page.frameLocator('#editor-tistory_ifr');
  const body = frame.locator('body');
  await body.click();
  await page.waitForTimeout(300);

  // 텍스트+역링크만 안정적으로 붙여넣는다. 이미지 업로드는 headless TinyMCE 에서
  // 비결정적(flaky)이라 무인 파이프라인에서 제외 — 이미지는 원문(thundo.kr, 역링크로
  // 유도)에서 보게 한다. (실측 2026-07-06: 업로드가 될 때·안 될 때가 갈리고, 실패 시
  // 본문까지 깨질 위험이 있어 텍스트 우선.)
  await pasteHtmlAtCursor(page, doc.bodyHtml);
  await page.waitForTimeout(800);

  const pastedLen = (await body.innerHTML()).length;
  if (pastedLen < 50) throw new Error('본문 붙여넣기 실패(빈 본문) — 발행 중단');

  // 카테고리는 제목 위 메인 에디터 드롭다운 — 완료(발행 레이어) 전에 설정. 실패해도 비차단.
  const wantCategory = doc.category || platformCfg.category;
  try {
    const cat = await selectTistoryCategory(page, wantCategory);
    if (cat.selected) console.log(`[tistory] 카테고리 선택: ${wantCategory}`);
    else if (wantCategory) {
      const avail = await listTistoryCategories(page);
      console.warn(`[tistory] 카테고리 미선택(${cat.reason}). 사용가능: ${avail.join(', ') || '(없음 — 티스토리에서 카테고리 생성 필요)'}`);
    }
  } catch (e) { console.warn(`[tistory] 카테고리 설정 스킵: ${e.message.slice(0, 100)}`); }

  // 완료 → 발행 레이어 열림 → (태그 설정) → 공개 → 발행
  const doneBtn = await firstVisible(page, ['#publish-layer-btn-open', 'button:has-text("완료")']);
  await doneBtn.click();
  await page.waitForTimeout(1000);

  // 태그는 발행 레이어의 #tagText — 실패해도 비차단
  try {
    const n = await fillTistoryTags(page, doc.tags);
    if (n) console.log(`[tistory] 태그 ${n}개 입력: ${doc.tags.slice(0, n).join(', ')}`);
  } catch (e) { console.warn(`[tistory] 태그 설정 스킵: ${e.message.slice(0, 100)}`); }

  const openRadio = await firstVisible(page, ['#open20', 'input[id="open20"]', 'label:has-text("공개")']);
  await openRadio.click();
  const publishBtn = await firstVisible(page, ['#publish-btn', 'button:has-text("공개 발행")', 'button:has-text("발행")']);
  await publishBtn.click();

  await page.waitForTimeout(3000);
  const permalinkRe = new RegExp(`^https?://${host.replace(/\./g, '\\.')}/(entry/[^/?#]+|\\d+)$`);
  if (permalinkRe.test(page.url())) return page.url();

  // 관리 화면으로 돌아간 경우: 글 관리 목록에서 최신 글 permalink 를 읽는다
  await page.goto(`https://${host}/manage/posts/`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(2000);
  const newest = await page.evaluate((h) => {
    const ids = [...document.querySelectorAll('a[href]')]
      .map(a => (a.getAttribute('href') || '').match(/\/manage\/post\/(\d+)/))
      .filter(Boolean).map(m => parseInt(m[1], 10));
    return ids.length ? `https://${h}/${Math.max(...ids)}` : null;
  }, host);
  return newest || `https://${host}/`;
}

// ─── medium ───────────────────────────────────────────────────────────────────
// contenteditable — 제목은 타이핑, 본문은 HTML 클립보드 붙여넣기(서식 유지).
export async function postMedium(page, ctx, doc) {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://medium.com' });
  await page.goto('https://medium.com/new-story', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(2500);

  // 제목: 첫 번째 contenteditable 필드 클릭 후 타이핑
  const editor = await firstVisible(page, ['article [contenteditable="true"]', '[data-testid="editor"]', 'div[contenteditable="true"]']);
  await editor.click();
  await page.keyboard.insertText(doc.title);
  await page.keyboard.press('Enter');

  // 본문: text/html 클립보드 → Ctrl+V (Medium 이 시맨틱 블록으로 변환)
  await page.evaluate(async (html) => {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([html.replace(/<[^>]+>/g, ' ')], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, doc.bodyHtml);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(2000);

  // Publish 플로우
  const pubBtn = await firstVisible(page, ['button[data-action="show-prepublish"]', 'button:has-text("Publish")']);
  await pubBtn.click();
  // 토픽 입력(선택)
  try {
    const topic = page.locator('[data-testid="publishTopicsInput"], input[placeholder*="topic"], .js-tagInput span[contenteditable]').first();
    if (await topic.isVisible({ timeout: 3000 })) {
      for (const t of doc.tags.slice(0, 5)) {
        await topic.click();
        await page.keyboard.insertText(t);
        await page.keyboard.press('Enter');
      }
    }
  } catch { /* 선택사항 */ }
  const confirmBtn = await firstVisible(page, ['button[data-testid="publishConfirmButton"]', 'button:has-text("Publish now")']);
  await confirmBtn.click();

  await page.waitForURL(/medium\.com\/@[^/]+\/.+|medium\.com\/p\/.+/, { timeout: NAV_TIMEOUT }).catch(() => {});
  // 발행 완료 화면에 "View story" 링크가 있는 경우
  const view = page.locator('a:has-text("View story")').first();
  if (await view.isVisible().catch(() => false)) {
    const href = await view.getAttribute('href');
    if (href) return href.startsWith('http') ? href : `https://medium.com${href}`;
  }
  return page.url();
}

export const DRIVERS = { velog: postVelog, tistory: postTistory, medium: postMedium };

// ─── 하이브리드 어시스트: 내용만 자동으로 채우고, 발행(캡차 포함)은 사람이 ───────
// 캡차(Cloudflare Turnstile/Challenge)는 우회하지 않는다 — 사람이 정당하게 통과한다.

/** velog: 제목·본문·태그·1차 출간설정까지 자동, 최종 출간+캡차는 사람 */
async function prepareVelog(page, ctx, doc) {
  await page.goto('https://velog.io/write', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  const title = await firstVisible(page, ['textarea[placeholder*="제목"]']);
  await title.fill(doc.title);
  await injectMarkdown(page, doc.bodyMd);
  try {
    const tagInput = page.locator('input[placeholder*="태그"]').first();
    if (await tagInput.isVisible({ timeout: 2000 })) {
      for (const t of doc.tags.slice(0, 4)) { await tagInput.fill(t); await page.keyboard.press('Enter'); }
    }
  } catch { /* 태그 선택 */ }
  // 1차 출간하기 → 발행 설정 패널 오픈 (여기서 멈춤: 사람이 캡차+최종출간)
  await page.locator('button:has-text("출간하기")').first().click();
  await page.waitForTimeout(1000);
}

async function prepareMedium(page, ctx, doc) {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://medium.com' });
  await page.goto('https://medium.com/new-story', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await page.waitForTimeout(2000);
  const editor = await firstVisible(page, ['article [contenteditable="true"]', 'div[contenteditable="true"]']);
  await editor.click();
  await page.keyboard.insertText(doc.title);
  await page.keyboard.press('Enter');
  await page.evaluate(async (html) => {
    const item = new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([html.replace(/<[^>]+>/g, ' ')], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([item]);
  }, doc.bodyHtml);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(1500);
  // 여기서 멈춤: 사람이 Publish → 토픽 → Publish now (챌린지 있으면 통과)
}

export const PREPARE = { velog: prepareVelog, medium: prepareMedium };

/**
 * 발행 성공 URL 패턴 (사람이 최종 발행을 마치면 여기로 이동).
 * ⚠ medium 은 초안 편집 URL 이 `/p/<hash>/edit` 형태라 발행 URL 과 헷갈린다 —
 *    /edit 로 끝나면 아직 초안이므로 발행으로 인정하지 않는다(EDIT_URL_RE 로 배제).
 */
export const PUBLISHED_URL_RE = {
  velog: /velog\.io\/@[^/]+\/(?!write)[^/]+$/,
  medium: /medium\.com\/(@[^/]+\/[^/]+-[0-9a-f]{6,}|p\/[0-9a-f]+)$/,
  tistory: /tistory\.com\/(entry\/|\d+$)/,
};

/** 초안/편집 URL — 발행으로 오인하면 안 되는 패턴 */
const EDIT_URL_RE = /\/(edit|new-story|write)(\?|#|$)/;

/** 사람이 발행을 마칠 때까지 URL 변화를 폴링 (캡차는 사람이 통과) */
export async function waitForHumanPublish(page, platform, timeoutMs = 5 * 60_000) {
  const re = PUBLISHED_URL_RE[platform];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const url = page.url();
    if (re.test(url) && !EDIT_URL_RE.test(url)) return url;
    await page.waitForTimeout(1500);
  }
  return null;
}
