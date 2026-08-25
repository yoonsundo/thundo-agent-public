-- cardnews_posts — 인스타 카드뉴스 발행물 카탈로그 (youtube_videos.sql 동일 패턴)
-- 사이트 /cardnews 탭이 service_role(서버)로 읽어 표지 슬라이드 + 인스타 원문 링크를 보여준다.
-- blog-publisher 의 카드뉴스 파이프라인(state/cardnews/index.json)이 발행 확정 시 한 행씩 upsert 한다(post_id PK).
-- 적용: blog-publisher 의 node scripts/db/migrate.mjs
create table if not exists public.cardnews_posts (
  post_id             text primary key,                    -- 예: cn-2026-07-31-5e1d513487
  backlog_id          text not null default '',
  subject             text not null default '',            -- 소재 한 줄(= 문제 지목)
  problem             text not null default '',            -- 표지 카드가 지목하는 문제 한 줄
  book                text not null default '',            -- 인용 출처 작품
  author              text not null default '',            -- 인용 출처 저자
  caption             text,                                -- 인스타 캡션 원문
  cover_url           text,                                -- 표지 슬라이드 URL(없으면 사이트가 slide_urls[0] 사용)
  slide_urls          jsonb not null default '[]'::jsonb,  -- 호스팅된 슬라이드 공개 URL 배열(state 의 public_url)
  slide_sha256        jsonb not null default '[]'::jsonb,  -- 슬라이드 해시(원본 대조용)
  media_id            text,                                -- 인스타 게시물 id(published_media_id)
  permalink           text,                                -- 인스타 퍼머링크. Graph API 가 준 값만 넣는다(추론 금지)
  generator           text not null default '',            -- 대본을 맡았던 생성기(claude | codex)
  generator_effective text not null default '',            -- 폴백까지 반영한 실제 생성기
  published_at        timestamptz not null default now(),
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists cardnews_posts_published_idx on public.cardnews_posts (published_at desc);

-- RLS: service_role(서버) 전용. 사이트는 서버에서 읽으므로 anon 정책 없음.
alter table public.cardnews_posts enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_cardnews_posts_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_cardnews_posts_updated_at on public.cardnews_posts;
create trigger trg_cardnews_posts_updated_at before update on public.cardnews_posts
  for each row execute function public.touch_cardnews_posts_updated_at();

-- 백필 없음 — 2026-07-31 기준 발행 확정된 카드뉴스가 0건이라 넣을 사실이 없다.
-- 첫 발행분부터 파이프라인이 upsert 한다. 그때까지 /cardnews 는 빈 상태를 렌더한다.

-- ── 반자동 발행 전환 (2026-08-21) ────────────────────────────────────────────
-- 음악을 넣을 수 없어 완전 자동 발행을 포기했다. 파이프라인은 **제작·호스팅까지만** 하고,
-- 관리자가 /admin/cardnews 에서 확인한 뒤 인스타에 직접 올리고 공개로 전환한다.
--
-- 왜 active 를 재활용하지 않고 status 를 새로 두나: active 는 "발행한 뒤 숨김"(소프트 삭제)
-- 스위치다. 여기에 "아직 안 올림"까지 얹으면 두 상태가 한 칸에 눌려 구분이 사라진다 —
-- 나중에 "왜 안 보이지?"의 답이 '숨김'인지 '미발행'인지 알 수 없게 된다.
alter table public.cardnews_posts
  add column if not exists status text not null default 'ready';

-- ⚠ 백필은 **컬럼 추가 직후, 제약 걸기 전**에 한다. 기존 행은 구 자동발행 경로로 들어온 것이라
--    이미 인스타에 올라가 있다 — 기본값 'ready' 로 두면 공개돼 있던 글이 갑자기 사라진다.
update public.cardnews_posts
   set status = 'published'
 where status = 'ready'
   and media_id is not null;      -- 인스타 media_id 가 있으면 실제로 올라간 것이다

alter table public.cardnews_posts
  drop constraint if exists cardnews_posts_status_chk;
alter table public.cardnews_posts
  add constraint cardnews_posts_status_chk check (status in ('ready', 'published'));

-- 관리자 화면이 status 로 목록을 가른다.
create index if not exists cardnews_posts_status_idx on public.cardnews_posts (status, published_at desc);

comment on column public.cardnews_posts.status is
  'ready=제작 완료·인스타 미게시(관리자 화면에만 보임) / published=관리자가 인스타에 올림(공개 /cardnews 노출). active 는 발행 뒤 숨김 스위치라 역할이 다르다.';

-- ── BGM 추천 (2026-08-24 반자동 발행 보강) ─────────────────────────────────────
-- 인스타 음악은 앱 안에서만 붙일 수 있어, 파이프라인이 카드 감정에 맞는 곡 3개를
-- 대본 단계에서 함께 생성해 저장한다. 관리자 화면이 이걸 보여주고 복사 버튼을 단다.
-- 기존 행 backfill 불필요(반자동 전환 시점 행 0건) · 부재는 '[]' 로 균일하다.
alter table public.cardnews_posts
  add column if not exists bgm_suggestions jsonb not null default '[]'::jsonb;

comment on column public.cardnews_posts.bgm_suggestions is
  '관리자용 BGM 추천 3곡 [{title, artist, mood}] — 대본(script) 단계에서 LLM 이 캡션과 같은 호출로 생성. 공개 페이지는 쓰지 않는다.';
