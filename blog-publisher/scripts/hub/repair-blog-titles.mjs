#!/usr/bin/env node
/**
 * scripts/hub/repair-blog-titles.mjs — blog_posts.title 오염 복구.
 *
 * 왜 필요한가: splitFrontmatter 가 들여쓴 줄을 최상위 키로 승격시켜, `source_refs` 블록 안의
 * `title:` 이 본문 제목을 덮어쓴 채 발행됐다(레딧·앤트로픽 문서·arXiv 제목이 글 제목으로 나감).
 * 파서는 고쳤지만 이미 DB 에 들어간 행은 그대로라, 이 스크립트가 published/*.md 를 권위로 되돌린다.
 *
 * 안전장치:
 *   - 기본은 dry-run. 실제 반영은 `--apply` 를 붙여야 한다.
 *   - title 컬럼만 UPDATE 한다(description·content·tags·date 무변경).
 *   - 원본 md 의 **들여쓰기 없는 최상위** title 만 권위로 인정한다.
 *
 * 사용:
 *   node --env-file=.env scripts/hub/repair-blog-titles.mjs           # dry-run
 *   node --env-file=.env scripts/hub/repair-blog-titles.mjs --apply   # 반영
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
// 파서는 적재 경로와 **같은 것**을 쓴다. 규칙을 두 벌로 두면 한쪽만 고쳐졌을 때
// 복구 스크립트가 오염된 값을 '정상'으로 판정해 사고가 조용히 되돌아온다.
import { splitFrontmatter } from './blog-db.mjs';

const log = makeLogger('hub/repair-titles');
const APPLY = process.argv.includes('--apply');

function creds() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
  return { url, key };
}

async function main() {
  const { url, key } = creds();
  if (!url || !key) { log.error('Supabase 크리덴셜 없음 — node --env-file=.env 로 실행하세요.'); process.exit(2); }
  const H = { apikey: key, Authorization: `Bearer ${key}` };

  const res = await fetch(`${url}/rest/v1/blog_posts?select=slug,title&limit=1000`, { headers: H });
  if (!res.ok) { log.error(`blog_posts 조회 실패: ${res.status}`); process.exit(2); }
  const db = new Map((await res.json()).map((r) => [r.slug, r.title]));
  log.info(`DB 글 ${db.size}편 조회`);

  const dir = join(paths.root, 'published');
  const targets = [];
  let checked = 0, notInDb = 0;

  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const { fm } = splitFrontmatter(readFileSync(join(dir, f), 'utf8'));
    if (!fm.slug || !fm.title) continue;
    if (!db.has(fm.slug)) { notInDb++; continue; }
    checked++;
    if (db.get(fm.slug) !== fm.title) targets.push({ slug: fm.slug, from: db.get(fm.slug), to: fm.title });
  }

  log.info(`대조 ${checked}편 · DB 미등재 ${notInDb}편 · 교정 대상 ${targets.length}편`);
  for (const t of targets) log.info(`  ${t.slug}\n     현재: ${t.from}\n     복구: ${t.to}`);

  if (!targets.length) { log.info('교정할 항목 없음.'); return; }
  if (!APPLY) { log.warn(`dry-run 입니다. 반영하려면 --apply 를 붙이세요.`); return; }

  let ok = 0, fail = 0;
  for (const t of targets) {
    const r = await fetch(`${url}/rest/v1/blog_posts?slug=eq.${encodeURIComponent(t.slug)}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ title: t.to }),      // title 만 — 다른 컬럼 무변경
    });
    if (r.ok) ok++; else { fail++; log.warn(`실패 ${t.slug}: ${r.status} ${await r.text()}`); }
  }
  log.info(`복구 완료: ${ok}편 성공 / ${fail}편 실패`);
  if (fail) process.exit(1);
}

main().catch((e) => { log.error(`치명 오류: ${e.message}`); process.exit(2); });
