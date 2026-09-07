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

-- ── 사람 승인 관문 (2026-09-07) ───────────────────────────────────────────────
-- 왜: 발행물 203편 중 147편(72%)이 68일간 어떤 검색어에도 걸리지 않았고, 구글 8월 스팸
-- 업데이트가 표적으로 삼은 "편집 감독 없는 대량 생산 AI 생성물"과 우리 프로필이 일치했다.
-- 발행량을 줄이고(하루 3편 → 주 3편) **사람이 승인한 글만 공개**하는 관문을 둔다.
--
-- 상태는 셋이다:
--   draft     — 사람이 쓰다 만 것(관리자 에디터가 만드는 초기 상태)
--   ready     — 파이프라인이 만들어 놓고 사람 승인을 기다리는 것  ← 새 상태
--   published — 사람이 승인해 공개된 것 (공개 경계는 오직 이 값)
--
-- ⚠ ready 를 새로 두는 이유는 카드뉴스와 같다 — draft 를 재활용하면 "사람이 쓰다 만 글"과
--   "기계가 만들어 승인을 기다리는 글"이 한 칸에 눌려, 관리자가 무엇을 검수해야 하는지
--   화면에서 구분할 수 없게 된다.

alter table public.blog_posts
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

comment on column public.blog_posts.approved_by is
  '이 글을 published 로 올린 관리자 식별자(세션 name/email). 승인되지 않았거나 기록 이전 글은 null — "승인자 없음"과 "측정 못 함"을 구분하려고 빈 문자열을 쓰지 않는다.';
comment on column public.blog_posts.approved_at is
  '승인 시각. published 를 벗어나면 approved_by 와 함께 지운다 — 공개되지 않은 글에 검수자를 표시하면 거짓이 된다.';

-- ⚠ 백필하지 않는다. 기존 207편은 사람 승인 관문이 생기기 **전에** 자동 발행된 것이라
--   승인자가 실제로 없다. 여기에 아무 이름이나 채우면 "누가 검수했나"가 영구히 거짓이 된다
--   (0 과 null 을 구분하라 — 없는 사실은 null 로 둔다).

-- 기본값을 published → ready 로 내린다(fail-closed).
-- status 를 빠뜨린 writer 가 생기면 예전엔 그대로 공개됐다. 이제는 승인 대기로 떨어진다.
-- ⚠ 기존 행에는 영향이 없다(default 는 새 INSERT 에만 적용). 현재 writer 3종
--   (hub/blog-db.mjs · /api/publish · /api/admin/blog)은 모두 status 를 명시해서 보낸다.
alter table public.blog_posts alter column status set default 'ready';

-- 제약을 걸기 전에 정규화 — 셋 밖의 값은 draft 로 내린다.
-- ⚠ 이 UPDATE 는 공개 여부를 바꾸지 않는다. 공개 경계는 status='published' 하나뿐이라
--   셋 밖의 값은 이미 비공개였다(2026-09-07 실측: draft 3 · published 207 뿐).
update public.blog_posts
   set status = 'draft'
 where status not in ('draft', 'ready', 'published');

alter table public.blog_posts drop constraint if exists blog_posts_status_chk;
alter table public.blog_posts
  add constraint blog_posts_status_chk check (status in ('draft', 'ready', 'published'));

comment on column public.blog_posts.status is
  'draft=사람이 쓰다 만 글 / ready=파이프라인 산출·사람 승인 대기(관리자 화면에만 보임) / published=승인돼 공개. 공개 경계는 이 값 하나다.';

-- 관리자 화면이 승인 대기(ready)를 먼저 긁는다 · 공개 목록은 published 를 date 순으로 긁는다.
create index if not exists blog_posts_status_date_idx on public.blog_posts (status, date desc);
