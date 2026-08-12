-- youtube_videos — 호기심 쇼츠 채널 발행 영상 카탈로그 (agents.sql 동일 패턴)
-- 사이트 /videos 탭이 service_role(서버)로 읽어 유튜브 임베드로 스트리밍(영상 파일 호스팅 X).
-- blog-publisher 의 업로드 파이프라인이 발행 성공 시 한 행씩 upsert 한다(youtube_id PK).
-- 적용: blog-publisher 의 node scripts/db/migrate.mjs
create table if not exists public.youtube_videos (
  youtube_id    text primary key,             -- 유튜브 영상 id (임베드 https://www.youtube-nocookie.com/embed/{id})
  title         text not null default '',
  subject       text not null default '',
  domain        text not null default '',
  youtube_url   text not null default '',
  thumbnail_url text,                          -- 없으면 사이트가 i.ytimg.com/vi/{id}/hqdefault.jpg 로 유도
  published_at  timestamptz not null default now(),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists youtube_videos_published_idx on public.youtube_videos (published_at desc);

-- RLS: service_role(서버) 전용. 사이트는 서버에서 읽으므로 anon 정책 없음.
alter table public.youtube_videos enable row level security;

-- updated_at 자동 갱신
create or replace function public.touch_youtube_videos_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_youtube_videos_updated_at on public.youtube_videos;
create trigger trg_youtube_videos_updated_at before update on public.youtube_videos
  for each row execute function public.touch_youtube_videos_updated_at();

-- 백필: 2026-07-14 즉시 발행한 신전략 3편 (이미 있으면 무시)
insert into public.youtube_videos (youtube_id, title, subject, domain, youtube_url) values
  ('bQkHAKl7D3Q', '아역스타 셜리 템플이 은퇴하고 통장을 열었을 때', '아역스타 셜리 템플이 은퇴하고 통장을 열었을 때', '역사', 'https://youtube.com/shorts/bQkHAKl7D3Q'),
  ('k3yAo4Bqmw8', '헬스장 러닝머신·일립티컬이 알려주는 ''소모 칼로리''', '헬스장 러닝머신·일립티컬이 알려주는 ''소모 칼로리''', '일상', 'https://youtube.com/shorts/k3yAo4Bqmw8'),
  ('PxXTXjjffok', '쾌감 버튼을 뇌에 직접 연결하면 벌어지는 일', '쾌감 버튼을 뇌에 직접 연결하면 벌어지는 일', '심리', 'https://youtube.com/shorts/PxXTXjjffok')
on conflict (youtube_id) do nothing;
