-- orchestration — 관리자 오케스트레이션 콘솔 (`/admin/orchestrator`) 상태보드.
-- NL 질의 1건 = orchestration_requests 카드 1건, 오케스트레이터가 분해한
-- 서브태스크는 orchestration_subtasks 에 정규화 저장(레이스 없는 원자적 PATCH).
-- 실행은 기존 agent_chat_jobs/agent_chat_messages 트랜스포트를 그대로 재사용
-- (kind 컬럼으로 'chat'|'orchestrate'|'execute' 분기, request_id/subtask_id 로 연결).
-- 패턴: agent_chat.sql/projects.sql 과 동일 — text pk · RLS service_role 전용 ·
-- updated_at 트리거. 적용: blog-publisher 의 node scripts/db/migrate.mjs 또는
-- Supabase SQL Editor. 상태 어휘는 영문 enum(requested|hold|approved|rejected|done|replanning),
-- 초기값은 'requested'(요청중) — 오케 기획 결과 불가 판정 시에만 'hold'로 전환. 한글 라벨은 UI 몫(ADR-1).
-- 상세는 카드가 아니라 스레드형 대화(agent_chat_messages.subtype 로 렌더 분기, REV 2026-07-07).

create table if not exists public.orchestration_requests (
  id                text primary key default ('req_' || replace(gen_random_uuid()::text, '-', '')),  -- 'req_xxx' (클라 mkId 우선, 미지정 시 서버 생성)
  title             text,
  nl_query          text not null,
  status            text not null default 'requested',  -- requested|hold|approved|rejected|done|replanning
  plan              jsonb,                          -- { title, summary, subtasks:[...] } (오케 산출 스냅샷)
  plan_version      int  not null default 1,
  plan_history      jsonb not null default '[]'::jsonb, -- 재기획 시 이전 plan 스냅샷 누적
  reject_reason     text,
  replan_note       text,
  feasible          boolean,                       -- 런너가 채움: 오케 기획 결과 실행 가능 여부(불가 → hold)
  feasibility_reason text,                          -- 런너가 채움: 보류 판정 근거(불가/판단불가 사유)
  worktree          text,                           -- 런너가 채움: 개발 요청의 격리 워크트리/브랜치(예: feat/notice-management)
  session_id        text,                           -- 연결된 agent_chat_sessions.id (SSE 대화 로그용)
  created_by        text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        text
);
create index if not exists orchestration_requests_status_idx
  on public.orchestration_requests (status, updated_at);

create table if not exists public.orchestration_subtasks (
  id             text primary key default ('sub_' || replace(gen_random_uuid()::text, '-', '')),  -- 'sub_xxx' (러너가 id 없이 insert → 서버 생성)
  request_id     text not null,
  ordinal        int  not null default 0,
  agent_id       text not null,
  task           text not null,
  expected       text,
  exec_status    text not null default 'pending', -- pending|queued|running|done|error
  job_id         text,                          -- 연결된 agent_chat_jobs.id (승인 시 enqueue)
  message_id     text,                          -- 연결된 agent_chat_messages.id (assistant placeholder)
  result_excerpt text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists orchestration_subtasks_request_idx
  on public.orchestration_subtasks (request_id, ordinal);

-- 기존 채팅 job 트랜스포트에 오케스트레이션 job 종류·연결 컬럼 additive 확장.
-- not null default 'chat' → 기존 enqueueJob(kind 미지정) 호출은 계속 'chat' 기본값.
alter table public.agent_chat_jobs
  add column if not exists kind       text not null default 'chat',
  add column if not exists request_id text,
  add column if not exists subtask_id text;

-- 기존 채팅 메시지 트랜스포트에 스레드 렌더 분기용 subtype additive 확장(nullable).
-- 값: request(원 요청)|status_change(상태전환 로그)|ai_plan(기획 요약)|hold_reason(보류 사유)|
--     exec(서브태스크 실행 스트림)|done_result(완료 결과). 기존 채팅 메시지는 null(일반 렌더).
alter table public.agent_chat_messages
  add column if not exists subtype text;

-- 기존 orchestration_requests 에 worktree(격리 브랜치) 컬럼 additive 확장.
alter table public.orchestration_requests
  add column if not exists worktree text;

-- RLS: service_role(서버) 전용. anon 정책 없음.
alter table public.orchestration_requests enable row level security;
alter table public.orchestration_subtasks enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_orchestration_requests_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_orchestration_requests_updated_at on public.orchestration_requests;
create trigger trg_orchestration_requests_updated_at before update on public.orchestration_requests
  for each row execute function public.touch_orchestration_requests_updated_at();

create or replace function public.touch_orchestration_subtasks_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_orchestration_subtasks_updated_at on public.orchestration_subtasks;
create trigger trg_orchestration_subtasks_updated_at before update on public.orchestration_subtasks
  for each row execute function public.touch_orchestration_subtasks_updated_at();
