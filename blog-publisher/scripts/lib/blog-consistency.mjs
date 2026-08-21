#!/usr/bin/env node
/**
 * lib/blog-consistency.mjs — 블로그 발행물이 세 저장소에 제대로 들어갔는지 점검 (F-16 블로그편)
 *
 * 블로그는 쇼츠·카드뉴스와 달리 **상태 모델이 없었다.** 그럴 만한 이유가 있다 —
 * 이 채널은 한 아이템이 세 곳에 나뉘어 산다:
 *
 *   ① `published/`            발행 원장(아카이브). 파일 자체가 사실이다
 *   ② `blog_posts` (Supabase) 홈페이지가 실제로 읽는 곳. 여기 없으면 독자에게 안 보인다
 *   ③ `published-index.json`  중복 회피용 원장(dedup_key → 발행 기록)
 *
 * 그래서 "상태" 하나로 표현할 수 없고, **세 곳의 정합**을 따로 봐야 한다. 이 모듈이 그 축이다.
 * (초안 한 편의 런 내 생애는 `kernel/lifecycle.mjs` 의 `blogLifecycle` 이 본다.)
 *
 * 🔴 **보고만 한다. 아무것도 고치지 않고 아무것도 막지 않는다.**
 *    불일치의 정당한 사유가 많다 — 수동 발행, 이관 이전 글, DB 크리덴셜 부재 등.
 *    근거 없이 자동 수정하면 발행물을 잃는다.
 *
 * ⚠ Supabase 크리덴셜이 없으면 **로컬 폴백 로그**(`state/hub/blog_posts.jsonl`)를 본다.
 *    그건 DB 가 아니다 — 결과에 `db_source` 로 무엇을 봤는지 반드시 밝힌다.
 *    (조용히 폴백을 DB 로 취급하면 "다 들어가 있다" 는 거짓 안심을 준다.)
 *
 * CLI: node scripts/lib/blog-consistency.mjs [--json]   (npm run blog:check)
 * exit: 0 = 점검 완료(불일치가 있어도 0 — 보고 도구다) / 2 = 실행오류
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './main-module.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

/** `2026-08-21-my-slug.md` → `my-slug` */
export function slugFromFilename(filename) {
  return String(filename).replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
}

/** 발행물 마크다운의 frontmatter 에서 slug 를 읽는다(파일명과 다를 수 있다). */
export function slugFromFrontmatter(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const s = m[1].match(/^slug:\s*["']?([^"'\n]+)["']?\s*$/m);
  return s ? s[1].trim() : null;
}

/**
 * `published/` 목록. 파일명 slug 와 frontmatter slug 를 **둘 다** 돌려준다 —
 * 둘이 어긋나는 것 자체가 찾아야 할 불일치다.
 */
export function readPublished(dir = join(REPO_ROOT, 'published')) {
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  return files.map(filename => {
    let raw = '';
    try { raw = readFileSync(join(dir, filename), 'utf8'); } catch { /* 읽기 실패는 아래서 드러난다 */ }
    return {
      filename,
      fileSlug: slugFromFilename(filename),
      fmSlug: slugFromFrontmatter(raw),
      bytes: raw.length,
      date: (filename.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] ?? null,
    };
  });
}

/**
 * DB 쪽 슬러그 집합. 크리덴셜이 없으면 로컬 폴백 로그를 읽고 그 사실을 밝힌다.
 * @returns {{ slugs: Set<string>, db_source: 'supabase'|'local-fallback'|'none', rows: number }}
 */
export function readDbSlugs({ jsonlPath = join(REPO_ROOT, 'state', 'hub', 'blog_posts.jsonl') } = {}) {
  if (!existsSync(jsonlPath)) return { slugs: new Set(), db_source: 'none', rows: 0 };
  let rows = [];
  try {
    rows = readFileSync(jsonlPath, 'utf8').split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return { slugs: new Set(), db_source: 'none', rows: 0 }; }
  return { slugs: new Set(rows.map(r => r.slug).filter(Boolean)), db_source: 'local-fallback', rows: rows.length };
}

/** run-lion 의 중복 회피 원장. dedup_key → 발행 기록. */
export function readPublishedIndex({ path = join(REPO_ROOT, 'state', 'published-index.json') } = {}) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(j) ? {} : j;
  } catch { return {}; }
}

/**
 * 세 저장소를 대조한다. **판정하지 않고 목록만 만든다.**
 * @returns {{summary: object, findings: object}}
 */
export function checkConsistency(opts = {}) {
  const published = opts.published ?? readPublished(opts.publishedDir);
  const db = opts.db ?? readDbSlugs(opts);
  const index = opts.index ?? readPublishedIndex(opts);

  const indexSlugs = new Set(Object.values(index).map(v => v?.slug).filter(Boolean));

  const slugMismatch = published
    .filter(p => p.fmSlug && p.fmSlug !== p.fileSlug)
    .map(p => ({ filename: p.filename, file_slug: p.fileSlug, frontmatter_slug: p.fmSlug }));

  const emptyFiles = published.filter(p => p.bytes === 0).map(p => p.filename);
  const noFrontmatter = published.filter(p => !p.fmSlug).map(p => p.filename);

  const pubSlugs = new Set(published.map(p => p.fmSlug ?? p.fileSlug));
  const missingInDb = [...pubSlugs].filter(s => !db.slugs.has(s));
  const missingInIndex = [...pubSlugs].filter(s => !indexSlugs.has(s));
  const orphanInDb = [...db.slugs].filter(s => !pubSlugs.has(s));

  return {
    summary: {
      published_files: published.length,
      db_source: db.db_source,
      db_rows: db.rows,
      db_slugs: db.slugs.size,
      index_entries: Object.keys(index).length,
    },
    findings: {
      empty_files: emptyFiles,
      no_frontmatter: noFrontmatter,
      slug_mismatch: slugMismatch,
      missing_in_db: missingInDb,
      missing_in_index: missingInIndex,
      orphan_in_db: orphanInDb,
    },
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (isMainModule(import.meta.url)) {
  const asJson = process.argv.includes('--json');
  let r;
  try { r = checkConsistency(); }
  catch (e) { process.stderr.write(`blog-consistency: ${e.message}\n`); process.exit(2); }

  if (asJson) { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); }

  const { summary: s, findings: f } = r;
  const out = [];
  out.push(`발행물 ${s.published_files}편 · 원장 ${s.index_entries}건 · DB(${s.db_source}) ${s.db_slugs}슬러그/${s.db_rows}행`);
  if (s.db_source === 'local-fallback') {
    out.push('⚠ Supabase 를 보지 않았다 — 로컬 폴백 로그를 읽었다. "DB 에 없음" 은 실제 DB 상태가 아니다.');
  }
  const line = (label, arr, sample = 3) =>
    out.push(`  ${label.padEnd(22)} ${String(arr.length).padStart(4)}건` +
      (arr.length ? `  예: ${arr.slice(0, sample).map(x => typeof x === 'string' ? x : x.filename).join(', ')}` : ''));
  line('빈 파일', f.empty_files);
  line('frontmatter 없음', f.no_frontmatter);
  line('slug 불일치', f.slug_mismatch);
  line('DB 에 없음', f.missing_in_db);
  line('원장에 없음', f.missing_in_index);
  line('DB 에만 있음', f.orphan_in_db);
  out.push('※ 이 도구는 보고만 한다 — 고치거나 막지 않는다.');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}
