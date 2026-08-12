-- blog_posts — 블로그 발행글 DB 저장 (파일시스템 대체)
-- 사이트는 service_role(서버)로 읽고, 관리자가 웹에디터로 편집.
create table if not exists public.blog_posts (
  slug        text primary key,
  title       text not null,
  date        date,
  status      text not null default 'published',   -- published | draft
  description text,
  tags        jsonb not null default '[]'::jsonb,
  content     text not null,                        -- markdown 본문
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS: service_role(서버) 전용. 사이트는 서버에서 읽으므로 anon 불필요.
alter table public.blog_posts enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_blog_posts_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_blog_posts_updated_at on public.blog_posts;
create trigger trg_blog_posts_updated_at before update on public.blog_posts
  for each row execute function public.touch_blog_posts_updated_at();
