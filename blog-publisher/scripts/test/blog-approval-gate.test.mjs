#!/usr/bin/env node
/**
 * scripts/test/blog-approval-gate.test.mjs — 발행 승인 관문(status) 계약 검증
 *
 * 배경: 2026-09-07 사람 승인 관문 도입. 새 글은 즉시 공개되지 않고 'ready'(승인대기)로
 * 들어간다. 그런데 같은 함수가 **기존 글 재적재**에도 쓰여서, 잘못 짜면 살아 있는 글을
 * 승인대기로 강등해 사이트에서 사라지게 만든다. 그 두 방향을 함께 고정한다.
 *
 * 검증:
 *   1. frontmatter 에 status 없음 → 'ready'
 *   2. frontmatter status 명시 → 그 값 존중
 *   3. 신규 slug(기존 행 없음) + ready → ready 로 upsert
 *   4. 기존 행이 published + ready 로 재적재 → **published 보존**(강등 금지)
 *   5. 기존 status 조회 실패(모름) → 쓰지 않고 물러남(ok:false, POST 0회)
 *   6. status='published' 로 올릴 때는 사전조회 없음(호출 1회 절약)
 *   7. BLOG_DB_ALLOW_UNPUBLISH=1 → 의도적 강등 허용
 *   8. status 없는 손수 만든 객체 → 페이로드에 'ready' 명시(DB 기본값 'published' 방지)
 *
 * 격리: fetch 를 스텁으로 갈아끼워 실 DB 미접촉. STATE_DIR_OVERRIDE 샌드박스.
 * exit 0 = 전체 통과 / exit 1 = 실패.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 가짜 크리덴셜 — isBlogDbEnabled() 를 true 로 만들되 fetch 는 스텁이라 네트워크 미발생.
// (config.mjs 는 process.env 에 이미 있으면 .env 로 덮지 않는다)
process.env.SUPABASE_URL = 'https://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE = 'stub-key-not-a-real-credential';
process.env.NEXT_PUBLIC_SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
process.env.RUN_MODE = 'mock';
process.env.BLOG_DB_LIVE = '1';   // mock 이어도 DB 경로를 타게 함(스텁 fetch 라 안전)
delete process.env.BLOG_DB_ALLOW_UNPUBLISH;

const SANDBOX = mkdtempSync(join(tmpdir(), 'blog-approval-'));
process.env.STATE_DIR_OVERRIDE = SANDBOX;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const ok = (c, label, d = '') => c
  ? (console.log(`  [PASS] ${label}`), pass++)
  : (console.error(`  [FAIL] ${label}${d ? ': ' + d : ''}`), fail++);

/**
 * installFetchStub({ existing, selectFails }) → calls
 * existing: 기존 행의 status(문자열) / null 이면 행 없음
 * selectFails: true 면 select 가 HTTP 500 (=조회 실패, "모름")
 */
function installFetchStub({ existing = null, selectFails = false } = {}) {
  const calls = { select: [], upsert: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if ((opts.method || 'GET') === 'GET' && u.includes('select=status')) {
      calls.select.push(u);
      if (selectFails) return new Response('boom', { status: 500 });
      const rows = existing === null ? [] : [{ status: existing }];
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    calls.upsert.push({ url: u, body: JSON.parse(opts.body || '[]') });
    return new Response('', { status: 201 });
  };
  return calls;
}

function writeFixture(name, lines) {
  const p = join(SANDBOX, name);
  writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

async function main() {
  const m = await import(join(ROOT, 'scripts', 'hub', 'blog-db.mjs'));
  const realFetch = globalThis.fetch;

  ok(m.DEFAULT_POST_STATUS === 'ready', "기본 공개 상태 상수 = 'ready'", m.DEFAULT_POST_STATUS);
  ok(m.isBlogDbEnabled() === true, 'BLOG_DB_LIVE=1 + 크리덴셜 → DB 경로 활성');

  // ── 1. status 없는 새 글 → ready ────────────────────────────────────────────
  const fresh = writeFixture('fresh.md', [
    '---', 'title: "새 글"', 'date: "2026-09-07"', 'slug: "post-approval01"',
    'tags: ["ai"]', '---', '', '# 새 글', '', '첫 문단입니다.', '', '## 섹션', '내용.',
  ]);
  const freshPost = m.parsePublishedPost(fresh);
  ok(freshPost?.status === 'ready', 'frontmatter status 없음 → ready(승인대기)', freshPost?.status);

  // ── 2. frontmatter 명시 존중 ────────────────────────────────────────────────
  const explicit = writeFixture('explicit.md', [
    '---', 'title: "명시 글"', 'slug: "post-approval02"', 'status: published', '---', '', '본문.',
  ]);
  ok(m.parsePublishedPost(explicit)?.status === 'published', 'frontmatter status 명시 → 그 값 존중');

  // ── 3. 신규 slug + ready → ready 로 upsert ──────────────────────────────────
  {
    const calls = installFetchStub({ existing: null });
    const r = await m.publishPostToDb(freshPost);
    ok(r.ok === true && r.status === 'ready', '신규 글 → ready 로 upsert', JSON.stringify(r));
    ok(calls.select.length === 1, '강등 방향이라 기존 status 를 1회 조회', String(calls.select.length));
    ok(calls.upsert[0]?.body?.[0]?.status === 'ready', '페이로드 status=ready', JSON.stringify(calls.upsert[0]?.body?.[0]?.status));
  }

  // ── 4. 기존 published 재적재 → 강등 금지 ────────────────────────────────────
  {
    const calls = installFetchStub({ existing: 'published' });
    const r = await m.publishPostToDb(freshPost);
    ok(r.ok === true && r.status === 'published', '이미 공개된 글 재적재 → published 보존', JSON.stringify(r));
    ok(calls.upsert[0]?.body?.[0]?.status === 'published', '페이로드도 published(살아 있는 글 유지)');
  }

  // ── 5. 조회 실패(모름) → 쓰지 않는다 ────────────────────────────────────────
  {
    const calls = installFetchStub({ selectFails: true });
    const r = await m.publishPostToDb(freshPost);
    ok(r.ok === false && /precheck/.test(r.reason || ''), '기존 status 조회 실패 → upsert 보류', JSON.stringify(r));
    ok(calls.upsert.length === 0, '보류 시 쓰기 0회(강등 사고 방지)', String(calls.upsert.length));
  }

  // ── 6. 승격 방향은 사전조회 없음 ────────────────────────────────────────────
  {
    const calls = installFetchStub({ existing: 'ready' });
    const r = await m.publishPostToDb({ ...freshPost, status: 'published' });
    ok(r.ok === true && calls.select.length === 0, 'status=published 는 사전조회 없이 upsert', String(calls.select.length));
    ok(calls.upsert[0]?.body?.[0]?.status === 'published', '페이로드 status=published');
  }

  // ── 7. 의도적 강등 탈출구 ───────────────────────────────────────────────────
  {
    process.env.BLOG_DB_ALLOW_UNPUBLISH = '1';
    const calls = installFetchStub({ existing: 'published' });
    const r = await m.publishPostToDb(freshPost);
    ok(r.ok === true && r.status === 'ready', 'BLOG_DB_ALLOW_UNPUBLISH=1 → 의도적 강등 허용', JSON.stringify(r));
    ok(calls.select.length === 0, '탈출구에서는 사전조회 생략');
    delete process.env.BLOG_DB_ALLOW_UNPUBLISH;
  }

  // ── 8. status 없는 손수 만든 객체 → 컬럼 누락 금지 ──────────────────────────
  // 페이로드에서 status 가 빠지면 DB 컬럼 기본값('published')이 먹어 그대로 공개된다.
  {
    const calls = installFetchStub({ existing: null });
    const r = await m.publishPostToDb({ slug: 'post-approval03', title: '무status', content: '<p>x</p>' });
    ok(r.ok === true && calls.upsert[0]?.body?.[0]?.status === 'ready',
       'status 없는 객체도 페이로드에 ready 명시', JSON.stringify(calls.upsert[0]?.body?.[0]?.status));
  }

  /**
   * 🔴 **관문에 두 번째 문이 없어야 한다.**
   *
   * 승인 관문은 `blog-db.mjs` 하나만 막아서 성립하지 않는다. frontmatter 에
   * `status: published` 를 박아 넣는 경로가 따로 있으면 그 문으로 그냥 빠져나간다.
   * 실제로 셋이 있었고, 그중 `publish-pending-drafts.mjs` 는 **매일 cron 에서 도는
   * 안전망**이다 — 에이전트가 이탈한 날 이 스크립트가 발행하면 사람 검토 없이 즉시
   * 공개된다(2026-09-07, 1차 조치 직후 리뷰에서 발견).
   *
   * 소스를 읽어 고정한다 — 동작 테스트로는 "다른 파일에 같은 짓을 하는 새 경로가
   * 생겼는지"를 잡을 수 없다.
   */
  {
    const { readFileSync, existsSync } = await import('node:fs');
    for (const f of ['scripts/publish-pending-drafts.mjs',
                     'scripts/daily-real-publish.mjs',
                     'scripts/run-lion.mjs']) {
      if (!existsSync(f)) { console.log(`  SKIP ${f} 없음`); continue; }
      const bad = /['"`]status: published['"`]/.test(readFileSync(f, 'utf8'));
      ok(!bad, `${f.split('/').pop()} 가 frontmatter 에 published 를 박지 않는다`);

    /**
     * ⚠ **`node --check` 가 통과시키는 함정이 있다.** 관문 도입 중에 실제로 밟았다 —
     *    `` `status: ready`  // 주석, `` 처럼 주석을 뒤에 붙이면 **배열 구분 쉼표가 주석에
     *    먹혀** 다음 줄과 태그드 템플릿이 된다. 문법은 유효해서 `node --check` 는 통과하고,
     *    런타임에 frontmatter 가 깨져 **발행 0건**이 된다(smoke 가 잡았다).
     *    같은 실수가 다시 나면 여기서 먼저 죽는다.
     */
    for (const f of ['scripts/publish-pending-drafts.mjs',
                     'scripts/daily-real-publish.mjs',
                     'scripts/run-lion.mjs']) {
      if (!existsSync(f)) continue;
      const src = readFileSync(f, 'utf8');
      const swallowed = /`status: ready`\s*\/\/[^\n]*,\s*$/m.test(src);
      ok(!swallowed, `${f.split('/').pop()} 의 status 줄에서 쉼표가 주석에 먹히지 않았다`);
    }

    }
  }


  globalThis.fetch = realFetch;
  console.log(`\n[blog-approval-gate] 결과: ${pass} 통과 / ${fail} 실패`);
  return fail === 0 ? 0 : 1;
}

main()
  .then(code => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} process.exit(code); })
  .catch(err => {
    console.error('[blog-approval-gate] 치명 오류:', err);
    try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
    process.exit(1);
  });
