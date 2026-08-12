-- projects — 홈페이지 프로젝트 카드 DB 저장 (하드코딩 대체)
-- 사이트는 service_role(서버)로 읽고, 관리자가 관리자 페이지에서 등록/수정/삭제.
-- (blog_posts.sql 과 동일 패턴: RLS service_role 전용 + updated_at 트리거)
create table if not exists public.projects (
  id          text primary key,
  title       text not null,
  period      text not null default '',
  role        text,
  stack       jsonb not null default '[]'::jsonb,
  description text not null default '',
  highlights  jsonb not null default '[]'::jsonb,
  link        text,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists projects_sort_idx on public.projects (sort_order asc);

-- RLS: service_role(서버) 전용. 사이트는 서버에서 읽으므로 anon 불필요.
alter table public.projects enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_projects_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at before update on public.projects
  for each row execute function public.touch_projects_updated_at();
