-- projects.detail — 포트폴리오 상세(관리자 미리보기 /admin/portfolio 용)
-- 구조: { "summary": string,                       -- 1~2줄 임팩트 요약
--         "flow":    [{ "label": string, "desc": string }, ...],  -- 순차 다이어그램 + 번호 설명
--         "personas": { "hr": string, "field": string, "ceo": string } }  -- 관점별 문단
-- 널 허용(기존 행 무영향). 기존 admin CRUD 는 detail 을 전송하지 않으므로
-- PostgREST upsert(제공 컬럼만 SET)가 이 컬럼을 덮지 않는다.
alter table public.projects add column if not exists detail jsonb;
