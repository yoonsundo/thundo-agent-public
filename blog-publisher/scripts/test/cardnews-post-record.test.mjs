#!/usr/bin/env node
/**
 * cardnews-post-record.test.mjs — 사이트 갤러리 기록(post-record.mjs) 유닛테스트
 *
 * 네트워크 불필요 — `fetchImpl` 주입으로 Supabase 를 통째로 스텁한다.
 *
 * 여기서 지키는 성질 셋:
 *   ① 컬럼 이름이 `web/supabase/cardnews_posts.sql` 과 정확히 일치한다
 *      (다르면 PostgREST 가 400 을 내고 갤러리는 영원히 빈 채로 남는다 — 발행은 성공하므로
 *       런은 초록이고, 아무도 눈치채지 못한다)
 *   ② **퍼머링크를 지어내지 않는다** — Graph 가 준 값만 싣는다
 *   ③ 올릴 것이 없으면(슬라이드 URL 부재) 기록하지 않는다 — media_id 부재는 이제
 *      거부 사유가 아니라 status='ready'(관리자가 직접 올릴 건)를 뜻한다
 *
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

import { toRow, recordPublishedPost } from '../cardnews/post-record.mjs';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/**
 * `web/supabase/cardnews_posts.sql` 의 컬럼을 **SQL 에서 직접 뽑는다.**
 *
 * ⚠ 예전에는 이 목록을 손으로 적어 뒀다("손으로 맞춰야 한다"). 그러면 스키마가 바뀔 때마다
 *   테스트가 거짓으로 빨개지거나(2026-08-21 status 추가 때 실제로 그랬다) 더 나쁘게는
 *   **손으로 같이 고쳐서 드리프트를 덮는다.** 생산자(SQL)를 읽어야 진짜 계약이 된다.
 * create table 본문 + 나중에 붙은 `alter table ... add column` 을 모두 본다 —
 * 마이그레이션은 alter 로 들어오므로 create 만 보면 새 컬럼을 놓친다.
 */
function sqlColumns() {
  const sqlPath = resolve(__dirname, '../../../repo/thundorun/web/supabase/cardnews_posts.sql');
  const sql = readFileSync(sqlPath, 'utf8');
  const cols = new Set();
  const create = sql.match(/create table if not exists public\.cardnews_posts \(([\s\S]*?)\n\);/);
  if (create) {
    for (const line of create[1].split('\n')) {
      const m = line.match(/^\s{2}([a-z0-9_]+)\s+/);
      if (m) cols.add(m[1]);
    }
  }
  for (const m of sql.matchAll(/add column if not exists\s+([a-z0-9_]+)\s/g)) cols.add(m[1]);
  // 서버가 채우는 생성 컬럼은 파이프라인 행에 없다.
  for (const g of ['created_at', 'updated_at']) cols.delete(g);
  return [...cols];
}
const SQL_COLUMNS = sqlColumns();

const POST = {
  post_id: 'cn-2026-08-01-5e1d513487',
  backlog_id: '5e1d513487',
  subject: '남으려면 나를 버려야 할 때',
  problem: '남으려면 나를 버려야 할 때',
  book: 'Jane Eyre',
  author: 'Charlotte Brontë',
  caption: '남으려고 애쓸수록…\n#책속의문장 #cn20260801',
  public_url: ['https://cdn.example/01.jpg', 'https://cdn.example/02.jpg'],
  slide_sha256: ['aaa', 'bbb'],
  published_media_id: '18000000000000000',
  permalink: 'https://www.instagram.com/p/CxYzAbCdEfG/',
  generator: 'codex',
  generator_effective: 'codex',
  published_at: '2026-08-01T10:00:00.000Z',
};

// ── ① 컬럼 정합 ──────────────────────────────────────────────────────────────
console.log('\n[1] 행 매핑 — SQL 컬럼과 정확히 일치');
{
  const row = toRow(POST);
  const got = Object.keys(row).sort();
  const want = [...SQL_COLUMNS].sort();
  ok('🔴 컬럼 집합이 SQL 과 동일', JSON.stringify(got) === JSON.stringify(want),
    `여분=${got.filter(k => !want.includes(k))} 누락=${want.filter(k => !got.includes(k))}`);

  eq('post_id', row.post_id, POST.post_id);
  eq('media_id 는 published_media_id 에서 온다', row.media_id, POST.published_media_id);
  eq('slide_urls 는 public_url 에서 온다', row.slide_urls.length, 2);
  eq('cover_url 은 첫 슬라이드', row.cover_url, 'https://cdn.example/01.jpg');
  eq('generator', row.generator, 'codex');
  eq('active 기본 true', row.active, true);
}

// ── ② 결측·형식이상 방어 ─────────────────────────────────────────────────────
console.log('\n[2] 결측·형식이상');
{
  const bare = toRow({ post_id: 'cn-x', published_media_id: 'm1' });
  eq('슬라이드가 없으면 cover_url 은 null', bare.cover_url, null);
  eq('slide_urls 는 빈 배열', bare.slide_urls.length, 0);
  eq('빈 문자열 기본값(not null 컬럼)', bare.subject, '');
  eq('caption 은 null 허용', bare.caption, null);

  const junk = toRow({ post_id: 'cn-y', public_url: ['ok', 42, null, ''], slide_sha256: 'not-an-array' });
  eq('URL 배열에서 비문자열은 걸러진다', junk.slide_urls.length, 1);
  eq('slide_sha256 이 배열이 아니면 빈 배열', junk.slide_sha256.length, 0);

  eq('post_id 없으면 행을 만들지 않는다', toRow({}), null);
  eq('post 자체가 없으면 null', toRow(null), null);

  // 🔴 폴백으로 클로드가 썼다면 generator_effective 가 그것을 드러낸다.
  const fell = toRow({ post_id: 'cn-z', published_media_id: 'm', generator: 'codex', generator_effective: 'claude' });
  eq('배정', fell.generator, 'codex');
  eq('실집필', fell.generator_effective, 'claude');
  // generator_effective 가 비면 generator 로 채운다(옛 포스트 호환).
  const legacy = toRow({ post_id: 'cn-w', published_media_id: 'm', generator: 'claude' });
  eq('generator_effective 결측이면 generator 로 채운다', legacy.generator_effective, 'claude');
}

// ── ③ 퍼머링크는 지어내지 않는다 ─────────────────────────────────────────────
console.log('\n[3] 퍼머링크');
{
  eq('Graph 가 준 값 그대로', toRow(POST).permalink, POST.permalink);
  // media_id 만 있고 퍼머링크가 없으면 **null 이어야 한다.** 인스타 퍼머링크의 shortcode 는
  // media_id 와 다른 값이라, media_id 로 조립하면 열리지 않는 링크가 갤러리에 박힌다.
  const noLink = toRow({ post_id: 'cn-n', published_media_id: '18000000000000000' });
  eq('🔴 퍼머링크가 없으면 null — 조립하지 않는다', noLink.permalink, null);
}

// ── ④ 업로드 경로 ────────────────────────────────────────────────────────────
console.log('\n[4] upsert 호출');
{
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-key';

  let seen = null;
  const r = await recordPublishedPost(POST.post_id, {
    post: POST,
    fetchImpl: async (url, init) => { seen = { url, init }; return { status: 201, text: async () => '' }; },
  });
  eq('성공', r.ok, true);
  ok('cardnews_posts 로 POST', String(seen?.url).endsWith('/rest/v1/cardnews_posts'), String(seen?.url));
  eq('메서드', seen?.init?.method, 'POST');
  ok('🔴 merge-duplicates — 같은 post_id 재발행이 중복 행을 만들지 않는다',
    String(seen?.init?.headers?.Prefer).includes('merge-duplicates'), String(seen?.init?.headers?.Prefer));
  eq('본문이 매핑된 행', JSON.parse(seen.init.body).post_id, POST.post_id);

  // HTTP 오류는 실패로 보고하되 던지지 않는다 — 발행은 이미 끝났고 되돌릴 수 없다.
  const bad = await recordPublishedPost(POST.post_id, {
    post: POST,
    fetchImpl: async () => ({ status: 400, text: async () => 'column "foo" does not exist' }),
  });
  eq('HTTP 오류는 ok=false', bad.ok, false);
  ok('사유가 남는다', /400/.test(bad.error || ''), bad.error);

  const boom = await recordPublishedPost(POST.post_id, {
    post: POST, fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  eq('네트워크 예외도 던지지 않는다', boom.ok, false);
  ok('네트워크 사유', /ECONNRESET/.test(boom.error || ''), boom.error);

  // ⚠ 계약이 바뀌었다(2026-08-21 반자동 발행 전환). 예전에는 media_id 가 없으면 기록을
  //    거부했지만, 이제 **그게 정상 경로**다 — 파이프라인은 제작·호스팅까지만 하고 인스타
  //    게시는 관리자가 한다. 대신 올릴 것이 실제로 있는지(슬라이드 URL)를 본다.
  const noSlides = await recordPublishedPost('cn-early', {
    post: { post_id: 'cn-early' },
    fetchImpl: async () => { throw new Error('슬라이드 없는데 네트워크를 열었다'); },
  });
  eq('호스팅된 슬라이드가 없으면 기록하지 않는다', noSlides.ok, false);
  ok('사유가 슬라이드 부재', /슬라이드/.test(noSlides.error || ''), noSlides.error);

  // media_id 가 없어도 슬라이드가 있으면 ready 로 기록한다 — 관리자 화면에 떠야 하기 때문.
  const readyRow = toRow({ post_id: 'cn-ready', public_url: ['https://cdn.example/01.jpg'] });
  eq('media_id 없으면 status=ready', readyRow.status, 'ready');
  eq('media_id 있으면 status=published',
    toRow({ post_id: 'cn-pub', public_url: ['https://cdn.example/01.jpg'], published_media_id: 'm1' }).status,
    'published');

  if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
  if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
}

console.log(`\ncardnews post-record(사이트 갤러리 기록): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
