-- projects 상단 고정 — 최대 6개.
-- notices 의 고정 패턴(supabase/notices.sql)과 동일한 계약을 따른다:
--   상한은 앱이 아니라 DB 트리거가 최종 소유자다. 동시 요청이 들어와도 advisory lock 으로
--   직렬화한 뒤 세므로 "둘 다 통과해서 7개가 되는" 경합이 생기지 않는다.
-- ⚠️ 이 상한값(6)은 TS 리터럴(components/ProjectsAdmin.tsx 의 PIN_MAX, API 문구)과 반드시 동기화할 것.

alter table public.projects add column if not exists pinned    boolean     not null default false;
alter table public.projects add column if not exists pinned_at timestamptz;

-- 목록은 항상 "고정 먼저 → 최근 고정 순 → 기존 정렬" 로 읽는다.
create index if not exists idx_projects_pinned
  on public.projects (pinned desc, pinned_at desc nulls last, sort_order asc);

create or replace function public.enforce_projects_pinned_limit()
returns trigger language plpgsql as $$
begin
  if new.pinned = true and (tg_op = 'INSERT' or coalesce(old.pinned, false) = false) then
    perform pg_advisory_xact_lock(hashtext('projects_pinned_limit'));
    if (select count(*) from public.projects
          where pinned = true and id <> coalesce(new.id, '')) >= 6 then
      raise exception 'PINNED_LIMIT_EXCEEDED' using errcode = 'P0001';
    end if;
    new.pinned_at = now();
  elsif new.pinned = false then
    new.pinned_at = null;
  end if;
  return new;
end; $$;

drop trigger if exists trg_projects_pinned_limit on public.projects;
create trigger trg_projects_pinned_limit before insert or update on public.projects
  for each row execute function public.enforce_projects_pinned_limit();
