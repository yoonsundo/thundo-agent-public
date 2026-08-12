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
