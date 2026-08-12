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
 *   ③ 발행 확정 전(media_id 없음)에는 기록하지 않는다
 *
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import { toRow, recordPublishedPost } from '../cardnews/post-record.mjs';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/** `web/supabase/cardnews_posts.sql` 의 컬럼(생성 컬럼 3개 제외). 손으로 맞춰야 한다. */
const SQL_COLUMNS = [
  'post_id', 'backlog_id', 'subject', 'problem', 'book', 'author', 'caption',
  'cover_url', 'slide_urls', 'slide_sha256', 'media_id', 'permalink',
  'generator', 'generator_effective', 'published_at', 'active',
];

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

  // 발행 확정 전에는 기록하지 않는다.
  const early = await recordPublishedPost('cn-early', {
    post: { post_id: 'cn-early' },
    fetchImpl: async () => { throw new Error('media_id 없는데 네트워크를 열었다'); },
  });
  eq('media_id 없으면 기록하지 않는다', early.ok, false);
  ok('사유가 media_id', /media_id/.test(early.error || ''), early.error);

  if (prevUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = prevUrl;
  if (prevKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
}

console.log(`\ncardnews post-record(사이트 갤러리 기록): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
