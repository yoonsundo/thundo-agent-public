/**
 * hub/blog-db.mjs — 발행 글을 홈페이지 Supabase `blog_posts` 테이블에 적재.
 *
 * 계약(다른 세션이 생성한 스키마, repo/thundorun/web/supabase/blog_posts.sql):
 *   blog_posts(slug PK, title, date, status, description, tags jsonb, content md, created_at, updated_at)
 *   RLS: service_role 전용. → 쓰기에 SERVICE_ROLE 키 필요.
 *
 * 환경변수(web 컨벤션 + blog-publisher 컨벤션 양쪽 허용):
 *   URL: NEXT_PUBLIC_SUPABASE_URL || SUPABASE_URL
 *   KEY: SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_ROLE
 *
 * 비활성(크리덴셜 없음/mock)이면 state/hub/blog_posts.jsonl 로 폴백 기록(mock-first).
 * 모든 함수는 비차단 — throw 대신 {ok:false} 반환. 파일 발행/런 종결에 영향 없음.
 *
 * 커버: blog_posts 에 cover 컬럼이 없으므로 content 선두에 ![alt](url) 마크다운으로 임베드.
 *
 * 공개 상태(status): 2026-09-07 사람 승인 관문 도입. 새 글은 'ready'(승인대기)로 들어가고
 * 관리자가 사이트에서 승인해야 'published' 가 된다. 자세한 계약은 DEFAULT_POST_STATUS 주석.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { paths, env, isMock } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
import { mdToHtml, figureHtml, isLikelyHtml } from '../lib/md-to-html.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('hub/blog-db');

// ─── 환경 ─────────────────────────────────────────────────────────────────────

function dbUrl()  { return env('NEXT_PUBLIC_SUPABASE_URL') || env('SUPABASE_URL'); }
function dbKey()  { return env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE'); }

/**
 * 새 글의 기본 공개 상태 — 'ready'(승인대기).
 *
 * 왜 'published' 가 아닌가: 74일간 203편을 사람 검토 없이 즉시 공개했고, 구글 8월 스팸
 * 업데이트("편집 감독 제한된 대량 생산")를 정면으로 맞았다(하루 노출 15.6회 → 1회).
 * 이제 파이프라인은 **제작까지만** 하고, 공개는 관리자가 사이트에서 승인할 때 일어난다.
 * frontmatter 가 status 를 명시하면 그 값을 쓴다(기존 published/*.md 는 전부 명시돼 있어
 * 백필이 영향받지 않는다).
 *
 * ⚠ DB 스키마의 컬럼 기본값은 아직 'published' 다(blog_posts.sql). 그래서 upsert 페이로드에서
 *   status 를 빼면 안 된다 — 빠지면 DB 기본값이 먹어 그대로 공개된다. 항상 명시해 보낸다.
 */
export const DEFAULT_POST_STATUS = 'ready';

/**
 * blog_posts DB 쓰기 가능 여부.
 * mock 모드에서는 실 DB 미접촉(프로덕션 보호) — BLOG_DB_LIVE=1 로 강제 가능(COLLECT_LIVE 패턴).
 * 비활성이면 호출부는 JSONL 폴백으로 동작.
 */
export function isBlogDbEnabled() {
  if (isMock() && env('BLOG_DB_LIVE') !== '1') return false;
  return Boolean(dbUrl() && dbKey());
}

// ─── 폴백(JSONL) ──────────────────────────────────────────────────────────────

function fallbackPath() {
  const dir = join(paths.state, 'hub');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'blog_posts.jsonl');
}

// ─── frontmatter 파서 (stdlib, yaml 의존성 없음) ─────────────────────────────

/** 발행 md 의 frontmatter 블록 + 본문 분리. */
export function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // ⚠ 들여쓴 줄은 중첩 값이다 — 최상위 키로 올리면 안 된다.
    //    source_refs 처럼 블록 형식이면 그 안의 `title:` 이 본문 title 을 덮어써서
    //    레딧·문서 제목이 글 제목으로 발행된다(실제로 108편 중 31편이 그렇게 나갔다).
    //    `- ` 로 시작하는 리스트 항목도 같은 이유로 건너뛴다.
    if (/^\s/.test(raw) || /^\s*-\s/.test(raw)) continue;
    const line = raw.trim();
    const eq = line.indexOf(':');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    // 최상위 키가 중복되면 첫 값을 권위로 둔다 — 뒤에서 덮어쓰는 사고를 막는다.
    if (Object.prototype.hasOwnProperty.call(fm, key)) continue;
    let val = line.slice(eq + 1).trim();

    // 값이 비면 YAML 블록 리스트일 수 있다 — `tags:` 다음 줄부터 `  - 항목`.
    // 이 형식을 못 읽어 태그가 통째로 빈 배열이 된 글이 6편 있었다(내부링크·SEO 신호 유실).
    if (val === '') {
      const items = [];
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s+-\s+(.*)$/);
        if (!item) break;                       // 리스트 끝(다음 최상위 키 또는 다른 형식)
        const v = item[1].trim().replace(/^["']|["']$/g, '');
        if (v && !v.includes(':')) items.push(v);   // `- type: "..."` 같은 객체 리스트는 대상 아님
      }
      if (items.length) { fm[key] = items; continue; }
    }

    // JSON 배열/객체면 파싱, 아니면 따옴표 제거
    if (val.startsWith('[') || val.startsWith('{')) {
      try { val = JSON.parse(val); } catch { /* 원문 유지 */ }
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    fm[key] = val;
  }
  return { fm, body: m[2] };
}

/** 본문에서 description 요약(첫 일반 문단, 마크다운 제거, ~160자). */
function deriveDescription(body) {
  const para = body
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('!['));
  if (!para) return null;
  const plain = para.replace(/[*_`>#\[\]()!]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 160 ? plain.slice(0, 157) + '…' : plain;
}

/**
 * coverToDataUri(coverPath) → data URI 또는 null.
 * cover_image('/images/x.svg' 등)를 paths.images(=state/images) 에서 읽어 자체포함 data URI 로 변환.
 * 홈페이지(web)는 blog-publisher 의 /images 경로를 못 푸므로, 이미지를 본문에 내장한다.
 * 파일이 없으면 null(커버 생략).
 */
function coverToDataUri(coverPath) {
  if (typeof coverPath !== 'string' || !coverPath) return null;
  if (/^data:/.test(coverPath)) return coverPath;            // 이미 data URI
  const rel = coverPath.replace(/^\/?images\//i, '');         // '/images/x.svg' → 'x.svg'
  const abs = join(paths.images, rel);
  if (!existsSync(abs)) return null;
  try {
    if (/\.svg$/i.test(abs)) {
      const svg = readFileSync(abs, 'utf8');
      return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    }
    const mime = /\.webp$/i.test(abs) ? 'image/webp'
               : /\.png$/i.test(abs)  ? 'image/png'
               : /\.jpe?g$/i.test(abs) ? 'image/jpeg' : null;
    if (!mime) return null;
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  } catch { return null; }
}

/**
 * parsePublishedPost(filepath) → blog_posts 행 객체.
 * @returns {{slug,title,date,status,description,tags,content}|null}
 */
export function parsePublishedPost(filepath) {
  let text;
  try { text = readFileSync(filepath, 'utf8'); }
  catch (e) { log.warn(`발행 글 읽기 실패: ${filepath} — ${e.message}`); return null; }

  const { fm, body } = splitFrontmatter(text);
  const slug = fm.slug || (filepath.split('/').pop() || '').replace(/\.md$/, '');
  if (!slug || !fm.title) { log.warn(`slug/title 누락 — 스킵: ${filepath}`); return null; }

  // 1) 본문 선두의 중복 H1(제목) 제거 — 홈페이지가 title 컬럼을 별도 렌더하므로 이중노출 방지.
  const md = body.trim().replace(/^#\s+.+\r?\n+/, '');

  // 2) 마크다운 → 시맨틱 HTML 변환. 사이트(thundorun)는 prose-invert 다크로 이 HTML 을 렌더한다.
  let content = mdToHtml(md);

  // 3) 커버 임베드(스키마에 cover 컬럼 없음). /images 경로는 홈페이지(web 도메인)에서 안 풀리므로
  //    SVG/이미지를 data URI 로 자체포함 <figure><img> 로 선두 임베드한다. 못 찾으면 생략.
  if (fm.cover_image) {
    const uri = coverToDataUri(fm.cover_image);
    if (uri) {
      const alt = (fm.image_alt || fm.title || '').replace(/\]/g, '');
      content = `${figureHtml(uri, alt)}\n${content}`;
    }
  }

  // 3.5) 본문 inline 이미지(/images/*.svg 등 삽화)도 data URI 로 자체포함.
  //      홈페이지는 blog-publisher 의 /images 경로를 못 푸므로 모든 inline 참조를 내장한다.
  content = content.replace(/src="(\/images\/[^"]+)"/g, (m, p) => {
    const uri = coverToDataUri(p);
    return uri ? `src="${uri}"` : m;
  });

  // 3.6) 이미지 중복 제거(안전망): 동일 data URI 가 여러 번 박힌 경우(이중 enrich 등) 첫 1개만 남긴다.
  //      커버가 본문 삽화와 같거나, enrich 가 두 번 돌아 삽화가 중복돼도 렌더 단계에서 정리.
  {
    const seen = new Set();
    content = content.replace(/<img\b[^>]*\bsrc="(data:[^"]+)"[^>]*>/g, (m, src) => {
      if (seen.has(src)) return '<!--dupimg-->';
      seen.add(src);
      return m;
    });
    // 중복 img 를 감싸던 빈 <figure> 정리
    content = content.replace(/<figure>\s*<!--dupimg-->\s*(?:<figcaption>[\s\S]*?<\/figcaption>)?\s*<\/figure>/g, '');
    content = content.replace(/<!--dupimg-->/g, '');
  }

  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  // date: "YYYY-MM-DD" 형태만 취함(없으면 null → DB default)
  const date = typeof fm.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(fm.date)
    ? fm.date.slice(0, 10) : null;

  return {
    slug,
    title:       String(fm.title),
    date,
    // frontmatter 명시값 우선, 없으면 승인대기('ready'). 예전 기본값은 'published' 였다.
    status:      fm.status || DEFAULT_POST_STATUS,
    description: deriveDescription(body),
    tags,
    content,
  };
}

// ─── upsert ───────────────────────────────────────────────────────────────────

/**
 * fetchExistingStatus(slug) → { ok, status }
 *   ok:true  — 조회 성공. status 는 문자열이거나, 행이 없으면 null.
 *   ok:false — **모른다**(네트워크·권한·HTTP 실패). reason 에 이유.
 *
 * "행 없음(null)" 과 "조회 실패(모름)" 를 절대 합치지 않는다. 둘을 같게 다루면
 * 일시적 조회 실패가 "새 글이네" 로 읽혀 살아 있는 글을 승인대기로 강등한다.
 */
async function fetchExistingStatus(slug) {
  const base = dbUrl().replace(/\/$/, '');
  const key = dbKey();
  try {
    const res = await fetch(`${base}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(slug)}&select=status`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const rows = await res.json();
    if (!Array.isArray(rows)) return { ok: false, reason: 'unexpected body' };
    const status = rows.length && typeof rows[0]?.status === 'string' ? rows[0].status : null;
    return { ok: true, status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * publishPostToDb(post) → { ok, mode, slug, reason? }
 * post: parsePublishedPost 결과(또는 동형 객체). 비차단.
 *
 * 🔴 **이미 공개된 글은 재발행으로 강등되지 않는다.** 이 함수는 신규 발행뿐 아니라
 *    수정 반영(재적재)·백필에도 쓰인다. 기본값이 'ready' 가 된 뒤로는, status 없는 글을
 *    다시 올리는 것만으로 사이트에서 살아 있는 글이 사라질 수 있었다.
 *    그래서 들어온 status 가 'published' 가 아닐 때만 기존 행을 먼저 조회해,
 *    이미 'published' 면 그대로 둔다. 조회에 실패하면(모름) 쓰지 않고 물러난다 —
 *    호출부는 비차단이라 다음 런에서 다시 시도한다(publish-pending-drafts 는 멱등).
 *    의도적 비공개는 관리자 화면에서 한다. 스크립트로 꼭 해야 하면 BLOG_DB_ALLOW_UNPUBLISH=1.
 */
export async function publishPostToDb(post) {
  if (!post || !post.slug) return { ok: false, reason: 'invalid post' };

  // status 는 여기서 한 번 더 정규화한다 — 손으로 만든 post 객체가 status 를 빠뜨리면
  // 페이로드에서 컬럼이 통째로 빠지고 DB 기본값('published')이 먹어 그대로 공개된다.
  const desired = typeof post.status === 'string' && post.status ? post.status : DEFAULT_POST_STATUS;
  let row = { ...post, status: desired };

  if (!isBlogDbEnabled()) {
    // 폴백: 로컬 JSONL 기록(mock-first, dry)
    try {
      appendFileSync(fallbackPath(), JSON.stringify({ ...row, _ts: new Date().toISOString() }) + '\n', 'utf8');
      log.info(`blog_posts DB 비활성 — JSONL 폴백 기록(dry): ${post.slug}`);
      return { ok: true, mode: 'fallback-jsonl', slug: post.slug, status: row.status };
    } catch (e) {
      return { ok: false, mode: 'fallback-jsonl', slug: post.slug, reason: e.message };
    }
  }

  // 강등 방향일 때만 기존 상태를 확인한다(승격 방향은 확인 불필요 — 호출 1회 절약).
  if (desired !== 'published' && env('BLOG_DB_ALLOW_UNPUBLISH') !== '1') {
    const found = await fetchExistingStatus(post.slug);
    if (!found.ok) {
      log.warn(`기존 status 조회 실패 — upsert 보류(강등 위험): ${post.slug} — ${found.reason}`);
      return { ok: false, mode: 'supabase', slug: post.slug, reason: `status precheck failed: ${found.reason}` };
    }
    if (found.status === 'published') {
      log.info(`이미 공개된 글 — status 보존(published): ${post.slug}`);
      row = { ...row, status: 'published' };
    }
  }

  // PostgREST upsert: on_conflict=slug + Prefer: resolution=merge-duplicates
  const url = `${dbUrl().replace(/\/$/, '')}/rest/v1/blog_posts?on_conflict=slug`;
  const key = dbKey();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        apikey:          key,
        Authorization:   `Bearer ${key}`,
        'Content-Type':  'application/json',
        Prefer:          'resolution=merge-duplicates,return=minimal',
      },
      body:   JSON.stringify([row]),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.warn(`blog_posts upsert HTTP ${res.status}: ${detail.slice(0, 200)}`);
      return { ok: false, mode: 'supabase', slug: post.slug, reason: `HTTP ${res.status}` };
    }
    log.info(`blog_posts upsert 완료: ${post.slug} (status=${row.status})`);
    return { ok: true, mode: 'supabase', slug: post.slug, status: row.status };
  } catch (e) {
    log.warn(`blog_posts upsert 예외: ${e.message}`);
    return { ok: false, mode: 'supabase', slug: post.slug, reason: e.message };
  }
}

/** publishFileToDb(filepath) — 파일 경로 → 파싱 → upsert 편의 래퍼. */
export async function publishFileToDb(filepath) {
  const post = parsePublishedPost(filepath);
  if (!post) return { ok: false, reason: 'parse failed', file: filepath };
  return publishPostToDb(post);
}

// ─── 백필 CLI ─────────────────────────────────────────────────────────────────

async function backfill() {
  const dir = join(paths.root, 'published');
  if (!existsSync(dir)) { console.log(JSON.stringify({ total: 0, ok: 0, failed: 0, note: 'published 없음' })); return 0; }
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f));
  const dry = !isBlogDbEnabled();
  let ok = 0, failed = 0;
  for (const f of files) {
    const r = await publishFileToDb(f);
    if (r.ok) ok++; else { failed++; log.warn(`백필 실패: ${f} — ${r.reason || ''}`); }
  }
  console.log(JSON.stringify({ total: files.length, ok, failed, dry }, null, 2));
  return failed === 0 ? 0 : 1;
}

// ─── 마이그레이션: 기존 DB의 마크다운 content → HTML 일괄 변환 ──────────────────

/**
 * migrateHtml() — blog_posts 의 모든 행을 service_role 로 읽어, content 가 아직
 * 마크다운이면 시맨틱 HTML 로 변환해 update 한다. 이미 HTML 인 행은 스킵(멱등).
 * @returns {Promise<number>} exit code (0=성공, 1=일부실패/비활성)
 */
export async function migrateHtml() {
  if (!isBlogDbEnabled()) {
    console.log(JSON.stringify({ ok: false, reason: 'blog_db 비활성(크리덴셜 없음/mock) — 마이그레이션 불가' }));
    return 1;
  }
  const base = dbUrl().replace(/\/$/, '');
  const key = dbKey();
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  let rows;
  try {
    const res = await fetch(`${base}/rest/v1/blog_posts?select=slug,content`, {
      headers, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.log(JSON.stringify({ ok: false, reason: `읽기 HTTP ${res.status}` }));
      return 1;
    }
    rows = await res.json();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, reason: `읽기 예외: ${e.message}` }));
    return 1;
  }

  let converted = 0, skipped = 0, failed = 0;
  for (const row of rows) {
    if (!row || !row.slug || typeof row.content !== 'string') { skipped++; continue; }
    if (isLikelyHtml(row.content)) { skipped++; continue; }

    const html = mdToHtml(row.content);
    if (!html) { skipped++; continue; }
    try {
      const res = await fetch(`${base}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(row.slug)}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ content: html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) { converted++; log.info(`HTML 변환 update: ${row.slug}`); }
      else { failed++; log.warn(`HTML update 실패 ${row.slug}: HTTP ${res.status}`); }
    } catch (e) {
      failed++; log.warn(`HTML update 예외 ${row.slug}: ${e.message}`);
    }
  }
  console.log(JSON.stringify({ ok: failed === 0, total: rows.length, converted, skipped, failed }, null, 2));
  return failed === 0 ? 0 : 1;
}

// CLI — 직접 실행될 때만(import 시 미실행). 동명 테스트 파일과 충돌 방지 위해 정확 비교.
if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2] || 'backfill';
  if (cmd === 'backfill') {
    backfill().then(code => process.exit(code));
  } else if (cmd === 'migrate-html') {
    migrateHtml().then(code => process.exit(code));
  } else if (cmd === 'enabled') {
    console.log(JSON.stringify({ enabled: isBlogDbEnabled(), url: Boolean(dbUrl()), key: Boolean(dbKey()) }));
  } else {
    console.log('사용법: node blog-db.mjs [backfill|migrate-html|enabled]');
  }
}
