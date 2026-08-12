#!/usr/bin/env node
/**
 * cardnews/post-record.mjs — 발행된 카드뉴스를 사이트 DB(`cardnews_posts`)에 기록.
 *
 * 홈페이지 `/cardnews` 갤러리가 이 테이블을 읽는다. 발행 성공마다 한 행 upsert →
 * 신규 발행분이 홈페이지에 자동 반영(수동 개입·재배포 불필요).
 * `shorts-curiosity/video-record.mjs` 와 같은 패턴(Supabase REST upsert)이다.
 *
 * 🔴 **이 파일이 없으면 갤러리는 영구히 빈 채로 남는다.** 테이블 정의(`web/supabase/
 * cardnews_posts.sql`)의 "파이프라인이 upsert 한다"는 주석은 이 모듈이 실제로 불려야만
 * 사실이 된다 — 스키마만 있고 쓰는 쪽이 없는 상태는 배포하면 조용히 빈 페이지가 된다.
 *
 * 실패해도 발행 흐름을 막지 않는다(경고만 — 발행 자체는 이미 성공했고 인스타는 되돌릴 수 없다).
 */
import { getPost } from './lib.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('cardnews/post-record');

// 🔴 `.env` 를 여기서 읽지 않는다. 위 `./lib.mjs` 가 `../lib/config.mjs` 를 끌어오고, 그
// 모듈이 **import 시점에** `.env` 를 파싱해 `process.env` 를 채운다(덮어쓰지 않고 보완).
// 실측으로 확인했다 — `--env-file` 없이 lib.mjs 만 import 해도 SUPABASE_* 가 들어온다.
// 그래서 채널마다 `envVar()` 를 복제하면 도달하지 않는 파일 읽기와 모듈 전역 캐시만 늘어난다.

/** 문자열 배열만 남긴다(형식이상 방어 — jsonb 컬럼에 쓰레기를 넣지 않는다). */
function urlList(v) {
  return Array.isArray(v) ? v.filter(u => typeof u === 'string' && u.length > 0) : [];
}

/**
 * 포스트 상태 → `cardnews_posts` 행.
 *
 * 순수 함수로 분리해 둔다 — 네트워크 없이 매핑만 테스트할 수 있어야 한다.
 * ⚠ `permalink` 는 **Graph API 가 준 값만** 넣는다. `media_id` 로 URL 을 조립하면
 * 그럴듯하지만 열리지 않는 링크가 갤러리에 박힌다.
 */
export function toRow(post) {
  if (!post?.post_id) return null;
  const slides = urlList(post.public_url);
  return {
    post_id: post.post_id,
    backlog_id: post.backlog_id ?? '',
    subject: post.subject ?? '',
    problem: post.problem ?? '',
    book: post.book ?? '',
    author: post.author ?? '',
    caption: post.caption ?? null,
    cover_url: slides[0] ?? null,
    slide_urls: slides,
    slide_sha256: Array.isArray(post.slide_sha256) ? post.slide_sha256 : [],
    media_id: post.published_media_id ?? null,
    permalink: post.permalink ?? null,
    generator: post.generator ?? '',
    generator_effective: post.generator_effective ?? post.generator ?? '',
    published_at: post.published_at ?? new Date().toISOString(),
    active: true,
  };
}

/**
 * 발행된 카드뉴스 1건을 `cardnews_posts` 에 upsert.
 *
 * @param {string} postId
 * @param {object} [opt]
 * @param {function} [opt.fetchImpl] 테스트 주입점
 * @returns {Promise<{ok:boolean, skipped?:string, error?:string, row?:object}>}
 */
export async function recordPublishedPost(postId, { fetchImpl = fetch, post = null } = {}) {
  const p = post || getPost(postId);
  const row = toRow(p);
  if (!row) return { ok: false, error: `포스트를 찾을 수 없다: ${postId}` };
  if (!row.media_id) return { ok: false, error: 'media_id 없음 — 발행 확정 전에는 기록하지 않는다' };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  // 크리덴셜 없음 = 이 박스가 아직 연동 전이라는 뜻이다. 발행은 이미 끝났으므로 실패로
  // 취급하되 흐름은 막지 않는다(호출자가 warn 만 남긴다).
  if (!url || !key) return { ok: false, skipped: 'no-credentials', row };

  try {
    const res = await fetchImpl(`${url}/rest/v1/cardnews_posts`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (res.status >= 300) {
      return { ok: false, error: `HTTP ${res.status}: ${String(await res.text()).slice(0, 150)}`, row };
    }
    log.info(`카드뉴스 DB 기록: ${row.post_id} (${row.book || row.subject})`);
    return { ok: true, row };
  } catch (e) {
    return { ok: false, error: `네트워크: ${e.message}`, row };
  }
}
