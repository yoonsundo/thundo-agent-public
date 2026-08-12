-- notices.sql — 공지사항 (공개 노출 + 관리자 CRUD)
create table if not exists public.notices (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null,
  pinned     boolean not null default false,
  pinned_at  timestamptz,               -- pinned=true 전환 시각. 정렬·상한 판정 기준.
  author     text,                      -- session.user.id(email) 스냅샷. FK 없음(blog_posts와 동일 관례).
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notices enable row level security;

-- 읽기: public(anon 포함) — 공지는 비로그인 방문자에게도 노출되는 콘텐츠.
drop policy if exists notices_public_read on public.notices;
create policy notices_public_read on public.notices
  for select to anon, authenticated using (true);
-- INSERT/UPDATE/DELETE: 정책 없음 = anon/authenticated 전면 거부. service_role만 RLS 우회로 쓰기 가능.

-- 컬럼 단위 권한: RLS(using(true))는 행 단위 제어만 하므로, Supabase 기본 스키마 권한(anon/authenticated에
-- 전체 컬럼 SELECT 부여)까지 회수하지 않으면 author(관리자 이메일)가 anon 키로 PostgREST 직접 호출 시
-- 그대로 노출된다(보안리뷰 FAIL 항목, 2026-07-09). service_role은 테이블 소유자 권한이라 영향 없음.
revoke select on public.notices from anon, authenticated;
grant select (id, title, body, pinned, pinned_at, created_at, updated_at)
  on public.notices to anon, authenticated;

-- updated_at 자동 갱신 (blog_posts 관례 동일)
create or replace function public.touch_notices_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_notices_updated_at on public.notices;
create trigger trg_notices_updated_at before update on public.notices
  for each row execute function public.touch_notices_updated_at();

-- 고정 5개 상한 — advisory lock으로 동시요청 직렬화 후 카운트 검사 (트랜잭션 내부, DB가 최종 소유자).
-- ⚠️ 이 상한값(5)은 TS 코드의 리터럴(server/notices.ts .limit, UI/API 문구·임계값)과 반드시 동기화할 것.
create or replace function public.enforce_notices_pinned_limit()
returns trigger language plpgsql as $$
begin
  if new.pinned = true and (tg_op = 'INSERT' or coalesce(old.pinned, false) = false) then
    perform pg_advisory_xact_lock(hashtext('notices_pinned_limit'));
    if (select count(*) from public.notices
          where pinned = true and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)) >= 5 then
      raise exception 'PINNED_LIMIT_EXCEEDED' using errcode = 'P0001';
    end if;
    new.pinned_at = now();
  elsif new.pinned = false then
    new.pinned_at = null;
  end if;
  return new;
end; $$;
drop trigger if exists trg_notices_pinned_limit on public.notices;
create trigger trg_notices_pinned_limit before insert or update on public.notices
  for each row execute function public.enforce_notices_pinned_limit();
