-- remediation_proposals — Goose 자가 조치(승인 게이트형) 제안 큐 (agents.sql 동일 패턴)
-- 흐름: goose 발동(red 즉시·yellow 2일 연속) → AI 제안 insert(pending)
--       → /admin/remediation 에서 승인/거절 → WSL executor 가 approved 처리(배포→재측정→verified/rolled_back)
-- 적용: blog-publisher 의 node --env-file=.env scripts/db/migrate.mjs web/supabase/remediation.sql
create table if not exists public.remediation_proposals (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- 발동 근거
  trigger       text not null,                 -- 'red' | 'yellow_2day' | 'manual_test'
  problem_key   text not null,                 -- 중복 방지 키 (예: 'home-slow', 'site-5xx')
  observation   jsonb,                         -- 발동 시점 goose 관측 스냅샷
  -- AI 제안 내용
  diagnosis     text not null default '',      -- 원인 분석 (사람용)
  plan          text not null default '',      -- 조치 설명 (사람용)
  diff          text not null default '',      -- unified diff (thundorun 대상, 승인 전 미적용)
  risk          text not null default '',      -- 위험도·부작용 설명
  -- 상태 기계: pending → approved|rejected → deploying → deployed → verified|rolled_back|failed
  status        text not null default 'pending',
  decision_by   text,
  decided_at    timestamptz,
  reject_reason text,
  -- 실행 결과
  commit_sha    text,
  deploy_url    text,
  verification  jsonb,                         -- {before, after, verdict}
  rolled_back_at   timestamptz,
  rollback_reason  text,
  error         text
);

create index if not exists remediation_status_idx on public.remediation_proposals (status, created_at desc);
create index if not exists remediation_problem_idx on public.remediation_proposals (problem_key, status);

-- RLS: service_role(서버) 전용 — 웹은 서버 유틸 경유, anon 정책 없음.
alter table public.remediation_proposals enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_remediation_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_remediation_updated_at on public.remediation_proposals;
create trigger trg_remediation_updated_at before update on public.remediation_proposals
  for each row execute function public.touch_remediation_updated_at();
