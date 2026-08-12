-- site_profile.sql — 랜딩 프로필 단일 행 테이블
-- Supabase SQL Editor 에서 실행하세요.
--
-- 구조:
--   id=1 고정 단일 행 (upsert 로 관리)
--   data JSONB: { name, handle, title, bio, avatar, location, available, skills, socials }
--   socials: [{ label, href, icon }]  icon = 'github' | 'mail' | 'blog' | 'link'

create table if not exists public.site_profile (
  id          int          primary key default 1,
  data        jsonb        not null,
  updated_at  timestamptz  default now()
);

-- id=1 만 허용하는 제약 (단일 행 보장)
alter table public.site_profile
  add constraint site_profile_single_row check (id = 1);

-- RLS 활성화 (anon 정책 없음 = service_role 전용)
alter table public.site_profile enable row level security;

-- 초기 기본값 삽입 (이미 있으면 무시)
insert into public.site_profile (id, data) values (
  1,
  '{
    "name": "Thundo",
    "handle": "thundo",
    "title": "백엔드 개발자 · AI 데이터 플랫폼 엔지니어",
    "bio": "Java/Spring 기반 엔터프라이즈 업무 시스템과 Python/FastAPI 기반 AI 데이터 플랫폼을 함께 구축해 왔습니다. RAG, Elasticsearch, 대규모 크롤링, 분석 API, LLM 보고서 자동화, AWS 배포·운영까지 실서비스 기준으로 설계하고 안정화한 경험을 포트폴리오에 정리했습니다.",
    "avatar": "/profile.png",
    "location": "Seoul, KR",
    "available": true,
    "skills": ["Java", "Spring Framework", "Python", "FastAPI", "Elasticsearch", "PostgreSQL", "Oracle", "AWS", "Docker", "GitLab CI/CD", "RAG", "LangGraph"],
    "socials": [
      { "label": "GitHub",  "href": "https://github.com/", "icon": "github" },
      { "label": "Email",   "href": "mailto:contact@example.com", "icon": "mail" },
      { "label": "블로그",  "href": "/blog", "icon": "blog" }
    ]
  }'::jsonb
) on conflict (id) do nothing;
