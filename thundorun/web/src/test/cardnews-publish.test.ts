/**
 * cardnews-publish — 인스타 카드뉴스 반자동 발행 계약 테스트
 *
 * 지키는 성질은 넷이다.
 *   ① **공개 경계** — 관리자가 인스타에 올리기 전(status='ready')에는 일반 사용자에게 안 보인다.
 *      이 필터가 빠지면 미게시 카드가 사이트에 새어 나간다.
 *   ② **퍼머링크를 지어내지 않는다** — 사람이 붙여넣는 값이라 형식을 강제한다. 느슨하면
 *      열리지 않는 링크가 갤러리에 영구히 박힌다(server/cardnews.ts 의 기존 계약과 같은 이유).
 *   ③ **관리자 인증** — 목록·발행·취소 모두 admin 이 아니면 거부한다.
 *   ④ **스키마 정합** — status 컬럼과 백필이 SQL 에 실제로 있다. 백필이 빠지면 이미 공개돼
 *      있던 글이 이 변경으로 사라진다.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isInstagramPermalink } from '@/server/cardnews';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('카드뉴스 반자동 발행', () => {
  describe('① 공개 경계 — ready 는 일반 사용자에게 보이지 않는다', () => {
    it("getActiveCardnews 가 status='published' 로 거른다", () => {
      const src = read('src/server/cardnews.ts');
      const fn = src.slice(src.indexOf('export async function getActiveCardnews'));
      const body = fn.slice(0, fn.indexOf('\n}'));
      expect(body).toContain("eq('status', 'published')");
      expect(body, 'active 필터도 유지돼야 한다(발행 뒤 숨김 스위치)').toContain("eq('active', true)");
    });

    // ⚠ 사이블링 체크아웃(blog-publisher)에 의존한다 — 한쪽만 클론한 환경에서는 건너뛴다.
    const RECORDER = join(ROOT, '../../../blog-publisher/scripts/cardnews/post-record.mjs');
    it.skipIf(!existsSync(RECORDER))('파이프라인은 인스타 게시 전이면 ready 로 기록한다', () => {
      const src = readFileSync(RECORDER, 'utf8');
      expect(src).toContain("status: post.published_media_id ? 'published' : 'ready'");
    });
  });

  describe('② 퍼머링크 형식 강제', () => {
    it('인스타 게시물 링크를 받는다', () => {
      for (const ok of [
        'https://www.instagram.com/p/CxyzAbc123/',
        'https://instagram.com/p/CxyzAbc123',
        'https://www.instagram.com/reel/CxyzAbc123/',
        'https://www.instagram.com/tv/CxyzAbc123/?igsh=abc',
      ]) expect(isInstagramPermalink(ok), ok).toBe(true);
    });

    it('그 밖의 값은 거부한다 — 죽은 링크가 갤러리에 박히면 안 된다', () => {
      for (const bad of [
        '', '   ',
        'instagram.com/p/CxyzAbc123/',              // 스킴 없음
        'http://www.instagram.com/p/CxyzAbc123/',   // http
        'https://www.instagram.com/thundo/',        // 프로필이지 게시물이 아니다
        'https://www.facebook.com/p/CxyzAbc123/',   // 다른 도메인
        'https://www.instagram.com/p/ab/',          // 코드가 너무 짧다
        'https://evil.com/?x=https://www.instagram.com/p/CxyzAbc123/',
      ]) expect(isInstagramPermalink(bad), bad).toBe(false);
    });

    it('앞뒤 공백은 허용한다 — 붙여넣기에 딸려 오는 흔한 경우다', () => {
      expect(isInstagramPermalink('  https://www.instagram.com/p/CxyzAbc123/  ')).toBe(true);
    });
  });

  describe('③ 관리자 인증', () => {
    it('모든 핸들러가 admin 을 확인한다', () => {
      const src = read('src/app/api/admin/cardnews/route.ts');
      expect(src).toContain("session.user?.role === 'admin'");
      // GET·POST 각각에 게이트가 있어야 한다 — 하나만 걸면 나머지가 뚫린다.
      const gates = src.match(/if \(!\(await requireAdmin\(\)\)\) return unauthorized\(\);/g) ?? [];
      expect(gates.length, 'GET·POST 양쪽 게이트').toBe(2);
    });

    it('서버가 퍼머링크를 다시 검사한다 — 클라이언트 검사만 믿지 않는다', () => {
      const src = read('src/server/cardnews.ts');
      const fn = src.slice(src.indexOf('export async function markCardnewsPublished'));
      expect(fn.slice(0, fn.indexOf('\n}'))).toContain('isInstagramPermalink');
    });

    it('발행 취소는 permalink 를 지운다 — 내린 글의 링크가 남으면 죽은 링크다', () => {
      const src = read('src/server/cardnews.ts');
      const fn = src.slice(src.indexOf('export async function unpublishCardnews'));
      const body = fn.slice(0, fn.indexOf('\n}'));
      expect(body).toContain('permalink: null');
      expect(body).toContain("status: 'ready'");
    });
  });

  describe('④ 스키마 정합', () => {
    const sql = read('supabase/cardnews_posts.sql');

    it('status 컬럼이 있다', () => {
      expect(sql).toMatch(/add column if not exists status/);
    });

    it('기존 공개분을 published 로 백필한다 — 없으면 공개돼 있던 글이 사라진다', () => {
      expect(sql).toMatch(/set status = 'published'/);
      expect(sql, '백필 기준은 media_id 존재').toMatch(/media_id is not null/);
    });

    it('허용값을 제약으로 고정한다', () => {
      expect(sql).toMatch(/check \(status in \('ready', 'published'\)\)/);
    });

    it('백필이 제약보다 먼저 온다 — 순서가 뒤집히면 마이그레이션이 실패한다', () => {
      expect(sql.indexOf("set status = 'published'")).toBeLessThan(
        sql.indexOf('cardnews_posts_status_chk check'),
      );
    });
  });

});
