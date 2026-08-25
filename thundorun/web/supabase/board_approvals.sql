-- board_approvals — 경영회의에서 사람이 정해야 하는 항목의 승인 원장.
--
-- 왜 필요한가: 이사회가 자동 처리하지 않는 항목은 화면에 "사람 승인 필요"로만 찍히고
-- 승인할 곳이 없었다(2026-08-21). 라벨만 있고 절차가 없으면 화면이 거짓말하는 것이다.
--
-- 쓰기: 관리자 화면(/admin/board) → API. 읽기·실행: blog-publisher 의 scripts/board/.
-- 적용: Supabase SQL Editor 또는 blog-publisher 의 node scripts/db/migrate.mjs
create table if not exists public.board_approvals (
  key             text primary key,          -- '<날짜>:<팀>:<제안id>' 멱등키(회의 재실행 중복 방지)
  date            date not null,
  proposal_id     text not null,
  team            text,
  target          text,
  target_type     text,
  change          text,                      -- 무엇을 어떻게 바꾸자는 것인가(요지, 사람이 읽는 본문)
  plan            text,                      -- 어떻게 바꿀 것인가(실행계획 — 화면이 요지와 나눠 보여준다)
  rationale       text,                      -- 왜
  expected_effect text,                      -- 무엇이 달라지는가
  value           jsonb,                     -- 설정 변경이면 바꿀 값
  hold_why        text,                      -- 왜 자동으로 안 됐는지(평문)
  hold_need       text,                      -- 승인하면 무슨 일이 일어나는지(평문)
  status          text not null default 'pending'
                  check (status in ('pending','approved','rejected','held')),
  comment         text,                      -- 승인·거부·보류 시 사람이 남기는 말
  decided_by      text,
  decided_at      timestamptz,
  applied_at      timestamptz,               -- 실제 반영 시각(null 이면 아직 실행 전)
  apply_result    jsonb,
  created_at      timestamptz not null default now()
);

-- ⚠ `create table if not exists` 는 **이미 있는 테이블에 컬럼을 더해 주지 않는다.**
--    plan 은 테이블을 만든 뒤에 코드로 먼저 들어왔고(1b45c06), 그래서 적재가 4일간
--    HTTP 400(PGRST204: plan 컬럼 없음)으로 조용히 실패했다. 기존 배포본을 따라잡으려면
--    이 문장이 필요하다. 앞으로 컬럼을 더할 때도 create 문 수정과 함께 여기에 한 줄 남긴다.
alter table public.board_approvals add column if not exists plan text;

create index if not exists board_approvals_status_idx on public.board_approvals (status, date desc);

-- RLS: service_role(서버) 전용. 화면은 서버 라우트를 통해서만 읽고 쓴다.
alter table public.board_approvals enable row level security;
