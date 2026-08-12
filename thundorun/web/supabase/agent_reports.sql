-- agent_reports — 에이전트 일일 업무보고(육하원칙) DB 저장. 날짜당 1행, upsert.
-- 사이트는 service_role(서버)로 읽어 /reports 페이지에 렌더.
create table if not exists public.agent_reports (
  date        date primary key,
  summary     jsonb not null default '{}'::jsonb,
  agents      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.agent_reports enable row level security;
create or replace function public.touch_agent_reports_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_agent_reports_updated_at on public.agent_reports;
create trigger trg_agent_reports_updated_at before update on public.agent_reports
  for each row execute function public.touch_agent_reports_updated_at();
