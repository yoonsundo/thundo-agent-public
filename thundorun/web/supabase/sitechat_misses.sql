-- sitechat_misses.sql — 사이트챗 미답변 질문 수집 테이블
-- Supabase SQL Editor 에서 실행하세요.
--
-- 목적: 폴백 답변으로 끝난 방문자 질문을 모아 Stage B(지식 검색) 착수 여부를
--       실측으로 판단한다. 계획: .omc/plans/ralplan-homepage-knowledge-chatbot.md §1
--       (착수 기준: 2주간 서로 다른 질문 30건 이상 ∧ 절반 이상이 Stage A 지식으로 답 불가)
--
-- 보존 정책(AC-17): 90일. 앱이 기록 시점마다 만료 행을 삭제한다
--   (src/server/sitechatMisses.ts — pg_cron 불필요한 트래픽 규모).
-- 입력 정규화(AC-16): 저장 전 제어문자 제거·공백 축약·500자 상한 (동 파일).

create table if not exists public.sitechat_misses (
  id        bigint       generated always as identity primary key,
  question  text         not null check (char_length(question) <= 500),
  asked_at  timestamptz  not null default now()
);

-- 보존 정책 삭제 경로용 인덱스 (asked_at < cutoff)
create index if not exists sitechat_misses_asked_at_idx
  on public.sitechat_misses (asked_at);

-- RLS 활성화 (anon 정책 없음 = service_role 전용 — 레포 관례: site_profile.sql 동일)
alter table public.sitechat_misses enable row level security;
