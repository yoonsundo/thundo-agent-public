-- traffic.sql — 홈페이지 트래픽 모니터링(서버 PV + 클라/서버 UV) 집계 저장.
-- 원시 이벤트 로그 없음(행 폭증 회피) → 쓸 때 집계(counter upsert) + 시간 버킷(감사성).
-- 사이트는 service_role(서버)로만 접근. anon grant 없음. 멱등(2회 적용 안전).

-- ── 페이지뷰(PV): 일자·시간·경로별 카운터. Edge 미들웨어가 원자적 증분. ──────────
create table if not exists public.traffic_pv (
  date       date     not null,
  hour       smallint not null,            -- 0~23 (UTC), 감사용 시간 버킷
  path       text     not null,
  views      bigint   not null default 0,
  updated_at timestamptz not null default now(),
  primary key (date, hour, path)
);

-- ── 순방문(UV): source='client'(비콘 cid) | 'server'(미들웨어 HMAC). 양쪽 재조정. ──
create table if not exists public.traffic_visitors (
  date       date not null,
  visitor_id text not null,                -- client=cid / server=HMAC(secret, ip+ua+date) — 원본 IP 비가역
  source     text not null,
  first_seen timestamptz not null default now(),
  primary key (date, visitor_id, source)
);

-- ── 리퍼러(host only, best-effort): 미들웨어 Referer + 비콘. ──────────────────────
create table if not exists public.traffic_referrers (
  date     date not null,
  referrer text not null,
  count    bigint not null default 0,
  primary key (date, referrer)
);

alter table public.traffic_pv        enable row level security;
alter table public.traffic_visitors  enable row level security;
alter table public.traffic_referrers enable row level security;
-- RLS 정책 없음 + anon grant 없음 → service_role(서버)만 접근. (agent_reports.sql 동일 패턴)

-- ── RPC: 원자적 PV 증분 (병렬 waitUntil 안전: upsert + views=views+inc) ──────────
create or replace function public.bump_pv(p_date date, p_hour smallint, p_path text, p_inc int default 1)
returns void language sql as $$
  insert into public.traffic_pv(date, hour, path, views, updated_at)
  values (p_date, p_hour, p_path, p_inc, now())
  on conflict (date, hour, path)
  do update set views = traffic_pv.views + p_inc, updated_at = now();
$$;

-- ── PV 방문자 dedup 세션(같은 방문자가 같은 경로를 쿨다운 내 반복해도 1회만 집계). ──
create table if not exists public.traffic_pv_seen (
  date       date        not null,
  path       text        not null,
  visitor    text        not null,
  last_seen  timestamptz not null default now(),
  primary key (date, path, visitor)
);
alter table public.traffic_pv_seen enable row level security;

-- ── RPC: dedup PV 증분. 같은 (date,path,visitor)가 쿨다운(기본 30분) 내면 no-op. 신규/쿨다운경과면 +1. 집계됐으면 true. ──
create or replace function public.bump_pv_guarded(
  p_date date, p_hour smallint, p_path text, p_visitor text,
  p_cooldown_min int default 30, p_cap int default 200000)
returns boolean language plpgsql as $$
declare cnt int; prev timestamptz;
begin
  if p_visitor is null or p_visitor = '' then          -- 방문자 식별 불가 → 보수적으로 집계 제외
    return false;
  end if;
  select count(*) into cnt from public.traffic_pv_seen where date = p_date;
  if cnt >= p_cap then return false; end if;            -- 일자 하드캡(행 폭증 차단)
  select last_seen into prev from public.traffic_pv_seen
    where date = p_date and path = p_path and visitor = p_visitor;
  if prev is not null and prev > now() - make_interval(mins => p_cooldown_min) then
    return false;                                        -- 쿨다운 내 재조회 — 미집계
  end if;
  insert into public.traffic_pv_seen(date, path, visitor, last_seen)
  values (p_date, p_path, p_visitor, now())
  on conflict (date, path, visitor) do update set last_seen = now();
  insert into public.traffic_pv(date, hour, path, views, updated_at)
  values (p_date, p_hour, p_path, 1, now())
  on conflict (date, hour, path)
  do update set views = traffic_pv.views + 1, updated_at = now();
  return true;
end; $$;

-- ── RPC: UV 증분 + per-day·per-source 하드캡(봇/스팸 행 폭증 차단). 새 UV면 true. ──
create or replace function public.bump_uv(p_date date, p_visitor text, p_source text, p_cap int default 200000)
returns boolean language plpgsql as $$
declare cnt int; ins int;
begin
  select count(*) into cnt from public.traffic_visitors where date = p_date and source = p_source;
  if cnt >= p_cap then return false; end if;          -- DB 하드캡(서버리스 in-memory throttle 대체)
  insert into public.traffic_visitors(date, visitor_id, source)
  values (p_date, p_visitor, p_source)
  on conflict do nothing;
  get diagnostics ins = row_count;
  return ins > 0;                                       -- true = 새 UV
end; $$;

-- ── RPC: 클라 UV 증분 + per-IP 캡(한 IP가 cid 무한 회전으로 행 폭증시키는 것 차단). ──
-- visitor_id = '<ip_bucket>:<cid>' (ip_bucket=HMAC(ip+ua+date), 원본 IP 비가역).
-- 같은 IP 일자별 distinct cid 가 p_per_ip_cap 초과하면 no-op. 새 UV면 true.
create or replace function public.bump_uv_client(
  p_date date, p_ip_bucket text, p_cid text,
  p_per_ip_cap int default 30, p_global_cap int default 200000)
returns boolean language plpgsql as $$
declare gcnt int; icnt int; ins int; vid text;
begin
  select count(*) into gcnt from public.traffic_visitors where date = p_date and source = 'client';
  if gcnt >= p_global_cap then return false; end if;                 -- 전역 하드캡
  vid := p_ip_bucket || ':' || p_cid;
  -- 이미 있는 (재방문)이면 캡과 무관하게 통과(dedup)
  if exists (select 1 from public.traffic_visitors
             where date = p_date and source = 'client' and visitor_id = vid) then
    return false;                                                    -- 기존 방문자 — 새 UV 아님
  end if;
  select count(*) into icnt from public.traffic_visitors
    where date = p_date and source = 'client' and visitor_id like p_ip_bucket || ':%';
  if icnt >= p_per_ip_cap then return false; end if;                 -- per-IP 캡
  insert into public.traffic_visitors(date, visitor_id, source)
    values (p_date, vid, 'client') on conflict do nothing;
  get diagnostics ins = row_count;
  return ins > 0;
end; $$;

-- ── RPC: 리퍼러 증분 ──────────────────────────────────────────────────────────
create or replace function public.bump_ref(p_date date, p_ref text)
returns void language sql as $$
  insert into public.traffic_referrers(date, referrer, count)
  values (p_date, p_ref, 1)
  on conflict (date, referrer)
  do update set count = traffic_referrers.count + 1;
$$;

-- ── RPC: 대시보드 집계(서버사이드, 단일 호출 → jsonb) ──────────────────────────
create or replace function public.traffic_summary(p_from date, p_to date)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'total_pv',  (select coalesce(sum(views), 0) from public.traffic_pv
                    where date between p_from and p_to),
    'client_uv', (select count(*) from public.traffic_visitors
                    where source = 'client' and date between p_from and p_to),
    'server_uv', (select count(*) from public.traffic_visitors
                    where source = 'server' and date between p_from and p_to),
    'by_day',    (select coalesce(jsonb_agg(x.d order by x.d->>'date'), '[]'::jsonb) from (
                    select jsonb_build_object('date', date, 'pv', sum(views)) d
                    from public.traffic_pv where date between p_from and p_to group by date) x),
    'top_paths', (select coalesce(jsonb_agg(y.p), '[]'::jsonb) from (
                    select jsonb_build_object('path', path, 'pv', sum(views)) p
                    from public.traffic_pv where date between p_from and p_to
                    group by path order by sum(views) desc limit 20) y),
    'top_referrers', (select coalesce(jsonb_agg(z.r), '[]'::jsonb) from (
                    select jsonb_build_object('referrer', referrer, 'count', count) r
                    from public.traffic_referrers where date between p_from and p_to
                    order by count desc limit 20) z)
  );
$$;
