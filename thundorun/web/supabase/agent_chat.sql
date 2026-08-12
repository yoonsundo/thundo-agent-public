-- agent_chat — 관리자 웹 에이전트 채팅 (웹 Claude 터미널) 전용 테이블.
-- 웹(Vercel)이 읽는 트랜스포트 + 러너 sqlite 진실원본의 미러.
-- 기존 frozen 허브 RECORD_TYPES 는 건드리지 않고 별도 테이블로 분리.
-- projects.sql 패턴: text pk · RLS service_role 전용 · updated_at 트리거.
-- 적용: blog-publisher 의 node scripts/db/migrate.mjs 또는 Supabase SQL Editor.

create table if not exists public.agent_chat_sessions (
  id          text primary key,              -- 'sess_xxx'
  title       text not null default '새 대화',
  created_by  text not null default '',       -- admin user id
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.agent_chat_messages (
  id          text primary key,              -- 'msg_xxx'
  session_id  text not null,
  role        text not null,                 -- 'user' | 'assistant' | 'system'
  agent_id    text,                          -- 라우팅된 에이전트 (없으면 일반 대화)
  content     text not null default '',      -- 스트리밍 중 델타 누적, 완료 시 최종본
  streaming   boolean not null default false,
  status      text not null default 'ok',    -- 'ok' | 'error'
  error       text,
  tool_state  jsonb not null default '[]'::jsonb,  -- [{tool,status}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists agent_chat_messages_session_idx
  on public.agent_chat_messages (session_id, created_at);

create table if not exists public.agent_chat_jobs (
  id          text primary key,              -- 'job_xxx'
  session_id  text not null,
  message_id  text not null,                 -- 답변이 들어갈 assistant 메시지
  agent_id    text,
  prompt      text not null,
  status      text not null default 'pending', -- pending|running|done|error
  error       text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  finished_at timestamptz
);
create index if not exists agent_chat_jobs_pending_idx
  on public.agent_chat_jobs (status, created_at);

-- RLS: service_role(서버) 전용. 웹은 서버에서만 읽고 씀. anon 정책 없음.
alter table public.agent_chat_sessions enable row level security;
alter table public.agent_chat_messages enable row level security;
alter table public.agent_chat_jobs     enable row level security;

-- updated_at 자동 갱신 (sessions/messages)
create or replace function public.touch_agent_chat_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_agent_chat_sessions_updated_at on public.agent_chat_sessions;
create trigger trg_agent_chat_sessions_updated_at before update on public.agent_chat_sessions
  for each row execute function public.touch_agent_chat_updated_at();

drop trigger if exists trg_agent_chat_messages_updated_at on public.agent_chat_messages;
create trigger trg_agent_chat_messages_updated_at before update on public.agent_chat_messages
  for each row execute function public.touch_agent_chat_updated_at();
