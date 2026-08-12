#!/usr/bin/env node
/**
 * scripts/test/blog-db.mjs — blog_posts DB 적재 작성기 검증
 *
 * 검증:
 *   1. parsePublishedPost 매핑(slug/title/date/tags/status/content)
 *   2. 커버 frontmatter → content 선두 ![alt](url) 임베드
 *   3. 폴백(크리덴셜 없음) upsert → state/hub/blog_posts.jsonl 기록
 *   4. 멱등(같은 slug 재적재 — 폴백은 append, 함수는 ok 유지)
 *
 * 격리: 크리덴셜 env 를 비워 강제 폴백(실 DB 미접촉) + STATE_DIR_OVERRIDE 샌드박스.
 * exit 0 = 전체 통과 / exit 1 = 실패.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// 실 DB 미접촉: 크리덴셜 강제 비움(config.mjs 는 이미 process.env 에 있으면 .env 로 안 덮음)
process.env.SUPABASE_URL = '';
process.env.NEXT_PUBLIC_SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';
const SANDBOX = mkdtempSync(join(tmpdir(), 'blogdb-test-'));
process.env.STATE_DIR_OVERRIDE = SANDBOX;

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..', '..');

let pass = 0, fail = 0;
const ok = (c, label, d = '') => c ? (console.log(`  [PASS] ${label}`), pass++) : (console.error(`  [FAIL] ${label}${d ? ': ' + d : ''}`), fail++);

async function main() {
  const m = await import(join(ROOT, 'scripts', 'hub', 'blog-db.mjs'));

  ok(m.isBlogDbEnabled() === false, '크리덴셜 비움 → isBlogDbEnabled() false(폴백)');

  // 가짜 발행 글 작성(커버 frontmatter 포함)
  const fixture = join(SANDBOX, 'sample.md');
  writeFileSync(fixture, [
    '---',
    'title: "테스트 글 — 자동분류"',
    'date: "2026-06-26"',
    'status: published',
    'slug: "post-testdb01"',
    'tags: ["ai","automation"]',
    'cover_image: "/images/blogdb-test-cover.svg"',
    'image_alt: "테스트 커버"',
    '---',
    '',
    '# 테스트 글 — 자동분류',
    '',
    '이것은 본문 첫 문단입니다. 자동분류 파이프라인을 설명합니다.',
    '',
    '## 섹션',
    '내용.',
  ].join('\n'), 'utf8');

  // 커버 SVG 를 paths.images(=SANDBOX/images) 에 임시 생성(coverToDataUri 가 여기서 읽음) — data URI 임베드 검증용.
  const coverSvg = join(SANDBOX, 'images', 'blogdb-test-cover.svg');
  mkdirSync(dirname(coverSvg), { recursive: true });
  writeFileSync(coverSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>', 'utf8');

  const post = m.parsePublishedPost(fixture);
  ok(post?.slug === 'post-testdb01', 'slug 매핑', post?.slug);
  ok(post?.title === '테스트 글 — 자동분류', 'title 매핑', post?.title);
  ok(post?.date === '2026-06-26', 'date 매핑', post?.date);
  ok(post?.status === 'published', 'status 매핑');
  ok(Array.isArray(post?.tags) && post.tags.length === 2, 'tags jsonb 매핑', JSON.stringify(post?.tags));
  ok(post?.content.startsWith('<figure><img src="data:image/svg+xml;base64,'), '커버를 data URI <figure><img> 로 자체포함 임베드');
  ok(/<h2>섹션<\/h2>/.test(post?.content || '') && /<p>이것은 본문 첫 문단/.test(post?.content || ''), 'content 가 시맨틱 HTML(h2/p) 로 변환됨');
  ok(!/^#\s|\n#\s+테스트 글|<h1>/.test(post?.content || ''), '본문 선두 중복 H1(제목) 제거됨');
  ok(typeof post?.description === 'string' && post.description.includes('본문 첫 문단'), 'description 본문 요약', post?.description);
  try { rmSync(coverSvg, { force: true }); } catch {}

  // 폴백 upsert + 멱등
  const r1 = await m.publishPostToDb(post);
  ok(r1.ok === true && r1.mode === 'fallback-jsonl', '폴백 upsert ok', JSON.stringify(r1));
  const r2 = await m.publishPostToDb(post);
  ok(r2.ok === true, '멱등 재적재 ok');
  const jsonlPath = join(SANDBOX, 'hub', 'blog_posts.jsonl');
  ok(existsSync(jsonlPath), 'JSONL 폴백 파일 기록');
  const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
  ok(lines.length === 2, '두 번 적재 → 2줄 기록', `lines=${lines.length}`);
  const rec = JSON.parse(lines[0]);
  ok(rec.slug === 'post-testdb01' && rec.content.includes('<figure><img'), '기록 레코드 형태 정확');

  // 파싱 실패(slug/title 없음) 방어
  const bad = join(SANDBOX, 'bad.md');
  writeFileSync(bad, 'no frontmatter body only', 'utf8');
  const badPost = m.parsePublishedPost(bad);
  ok(badPost === null, 'frontmatter 없는 글 → null(방어적)');

  // ── 중첩 YAML 오염 방어 (회귀) ────────────────────────────────────────────
  // source_refs 를 블록 형식으로 쓰면 그 안의 들여쓴 `title:` 이 최상위로 승격돼
  // 본문 제목을 덮어썼다 — 레딧·문서 제목이 글 제목으로 발행된 실제 사고(108편 중 31편).
  const nested = join(SANDBOX, 'nested.md');
  writeFileSync(nested, [
    '---',
    'slug: "post-nested01"',
    'title: "진짜 본문 제목 — 이게 남아야 한다"',
    'date: "2026-08-07"',
    'status: published',
    'tags: ["A","B"]',
    'source_refs:',
    '  - type: "blog"',
    '    title: "Reddit 원문 제목 (덮어쓰면 안 됨)"',
    '    url: "https://example.com/1"',
    '  - type: "official_doc"',
    '    title: "Effort parameter — Claude Developer Documentation"',
    '    url: "https://example.com/2"',
    '---',
    '',
    '본문 첫 문단입니다.',
  ].join('\n'), 'utf8');
  const nestedPost = m.parsePublishedPost(nested);
  ok(nestedPost?.title === '진짜 본문 제목 — 이게 남아야 한다',
     '중첩 source_refs 의 title 이 본문 title 을 덮지 않음', nestedPost?.title);
  ok(nestedPost?.slug === 'post-nested01' && nestedPost?.date === '2026-08-07',
     '중첩 블록이 있어도 다른 최상위 키는 정상 파싱', `${nestedPost?.slug}/${nestedPost?.date}`);
  ok(Array.isArray(nestedPost?.tags) && nestedPost.tags.length === 2,
     '중첩 블록이 있어도 tags JSON 배열 정상', JSON.stringify(nestedPost?.tags));

  // 멀티라인 YAML 리스트 tags — 이 형식을 못 읽어 6편이 tags:[] 로 발행됐다(내부링크·SEO 신호 유실).
  const ml = join(SANDBOX, 'multiline-tags.md');
  writeFileSync(ml, [
    '---', 'slug: "post-mltags01"', 'title: "멀티라인 태그 글"', 'date: "2026-08-07"', 'status: published',
    'tags:',
    '  - 퀀트트레이딩',
    '  - "백테스트"',
    '  - 데이터오염',
    'source_refs:',
    '  - type: "blog"',
    '    title: "출처 제목 (태그로 들어가면 안 됨)"',
    '---', '', '본문.',
  ].join('\n'), 'utf8');
  const mlPost = m.parsePublishedPost(ml);
  ok(Array.isArray(mlPost?.tags) && mlPost.tags.length === 3
     && mlPost.tags[0] === '퀀트트레이딩' && mlPost.tags[1] === '백테스트',
     '멀티라인 YAML 리스트 tags 파싱', JSON.stringify(mlPost?.tags));
  ok(mlPost?.title === '멀티라인 태그 글', '멀티라인 리스트가 있어도 title 보존', mlPost?.title);
  ok(!JSON.stringify(mlPost?.source_refs ?? []).includes('태그로 들어가면'),
     '객체 리스트(source_refs)는 문자열 태그로 오인되지 않음');

  // 최상위 키 중복 → 첫 값이 권위
  const dup = join(SANDBOX, 'dup.md');
  writeFileSync(dup, [
    '---', 'slug: "post-dup01"', 'title: "첫 제목"', 'status: published',
    'title: "나중 제목 — 덮어쓰면 안 됨"', '---', '', '본문.',
  ].join('\n'), 'utf8');
  ok(m.parsePublishedPost(dup)?.title === '첫 제목', '최상위 키 중복 시 첫 값 유지');

  console.log(`\n[blog-db] 결과: ${pass} 통과 / ${fail} 실패`);
  return fail === 0 ? 0 : 1;
}

main()
  .then(code => { try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} process.exit(code); })
  .catch(err => { console.error('[blog-db] 치명 오류:', err); try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {} process.exit(1); });
