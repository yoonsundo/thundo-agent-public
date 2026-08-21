/**
 * lib/published-doc.mjs — published/ 문서 파서·목록 유틸
 *
 * 원래 crosspub/lib.mjs 안에 있었다. 2026-08-12 외부 교차발행(티스토리) 폐지로
 * 그 파일을 지우면서, 쇼츠 파이프라인이 쓰던 두 함수만 여기로 옮겼다.
 *
 * 테스트 격리: PUBLISHED_DIR_OVERRIDE 지원(경로 규약은 원본 그대로).
 */
import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

export function publishedDir() {
  return process.env.PUBLISHED_DIR_OVERRIDE || join(REPO_ROOT, 'published');
}

/** 간이 frontmatter 파서 (단순 key: value 만) */
export function parseDoc(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fm, body: m[2] };
}

/**
 * published/ 전체 목록 → [{slug, date, file}] (파일명 <YYYY-MM-DD>-<slug>.md 규약).
 * 날짜 내림차순(최신 먼저). 날짜 파싱 안 되는 파일은 제외.
 */
export function listPublishedSlugs() {
  const dir = publishedDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (!m) continue;
    out.push({ date: m[1], slug: m[2], file: join(dir, f) });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
