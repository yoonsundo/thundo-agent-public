/**
 * AdminDashboard.tsx — CEO 관리자 대시보드 (Modernist Kit)
 *
 * 셸(사이드바·톱바)은 app/admin/layout.tsx 가 담당하고, 이 컴포넌트는 페이지 골격만 만든다:
 *   .page > .page-head > .tabs > (개요·브리핑 / 트래픽 / 프로필 / 블로그 / 프로젝트 / 에이전트)
 * 대시보드 조립은 DESIGN.md §5 — `.grid-4` 지표 → `.grid-sidebar`(차트 + 활동 로그 `.timeline`).
 *
 * 탭 전환은 언마운트가 아니라 `hidden` 으로 감춘다 — 에디터 인스턴스·SSE 구독 상태를 보존하려면
 * 섹션이 계속 마운트돼 있어야 한다(기존 동작 유지).
 */
'use client';

import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import BlogEditor from '@/components/BlogEditor';
import ProjectsAdmin from '@/components/ProjectsAdmin';
import AgentsAdmin from '@/components/AgentsAdmin';
import { AreaChartPV, DonutUV, BarList } from '@/components/TrafficCharts';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import { CardSkeleton, TableSkeleton } from '@/components/state/Skeleton';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import { ArrowLeft, ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';

// ─── 타입 ─────────────────────────────────────────────────────────────────────
interface BriefingRecord {
  id: string;
  ts: string;
  yesterday: Record<string, unknown>;
  budget: Record<string, unknown>;
  alerts: Array<{ type?: string; severity?: string; detail: string }>;
  decisions: Array<{ item: string; options: string[] }>;
}

type LiveStatus = 'connecting' | 'connected' | 'disconnected';

// ─── 블로그 타입 ───────────────────────────────────────────────────────────────
/** 블로그 관리 목록 페이지당 글 수 */
const BLOG_PAGE_SIZE = 10;

interface BlogPost {
  slug:         string;
  title:        string;
  date:         string;
  status:       'published' | 'draft';
  description?: string;
  tags?:        string[];
  views?:       number;   // traffic_pv 합산 조회수 (/api/admin/blog 목록에 부착)
}

interface BlogForm {
  slug:        string;
  title:       string;
  date:        string;
  status:      'published' | 'draft';
  description: string;
  tags:        string;   // 쉼표 구분 문자열
  content:     string;
  isNew:       boolean;
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────
/** 브리핑 값(문자열·배열·null) 을 한 줄로 정규화. */
function fmtVal(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return v == null ? '—' : String(v);
}

/** 브리핑의 키-값 묶음 → 정의 목록(§4.8). */
function BriefingDl({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <p className="text-muted">집계된 값이 없습니다.</p>;
  return (
    <dl className="dl">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{k}</dt>
          <dd>{fmtVal(v)}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** 알람·결정 목록 → 활동 로그 타임라인(§4.11). */
function BriefingTimeline({
  items,
  empty,
}: {
  items: Array<{ main: string; meta?: string }>;
  empty: string;
}) {
  if (items.length === 0) return <p className="text-muted">{empty}</p>;
  return (
    <ul className="timeline">
      {items.map((it, i) => (
        <li key={i}>
          <div>
            <div>{it.main}</div>
            {it.meta && <div className="card-meta">{it.meta}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── 트래픽 타입 ───────────────────────────────────────────────────────────────
interface TrafficSummary {
  total_pv:      number;
  client_uv:     number;
  server_uv:     number;
  by_day:        Array<{ date: string; pv: number }>;
  top_paths:     Array<{ path: string; pv: number }>;
  top_referrers: Array<{ referrer: string; count: number }>;
  // 관리자(role=admin) 테스트 트래픽 — 위 실제 통계(is_admin=false)에서 분리 집계.
  admin_pv?:        number;
  admin_client_uv?: number;
  admin_server_uv?: number;
}
interface AnalyticsResponse {
  today:  TrafficSummary | null;
  last7:  TrafficSummary | null;
  last30: TrafficSummary | null;
}

// ─── 탭 ───────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'overview', label: '개요·브리핑' },
  { key: 'traffic',  label: '트래픽' },
  { key: 'profile',  label: '프로필 관리' },
  { key: 'blog',     label: '블로그 관리' },
  { key: 'projects', label: '프로젝트 관리' },
  { key: 'agents',   label: '에이전트 관리' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/** 실시간 구독 상태 → 상태 태그(§4.5 색 매핑: 정상=success·처리중=info·대기=warning·오류=danger). */
const LIVE_TAG: Record<LiveStatus, { cls: string; label: string }> = {
  // 연결 중은 '처리중' 이라 info — warning 은 사람 조치를 기다리는 '대기' 몫이다.
  connecting:   { cls: 'tag tag-info',    label: '연결 중…' },
  connected:    { cls: 'tag tag-success', label: '라이브' },
  disconnected: { cls: 'tag tag-danger',  label: '끊김 (폴링)' },
};

const PERIODS = [
  { key: 'today',  label: '오늘' },
  { key: 'last7',  label: '7일' },
  { key: 'last30', label: '30일' },
] as const;

type BlogSortKey = 'title' | 'date' | 'views';

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export default function AdminDashboard({ adminId }: { adminId: string }) {
  const [briefing,     setBriefing]     = useState<BriefingRecord | null>(null);
  const [briefingErr,  setBriefingErr]  = useState('');
  const [profileForm,   setProfileForm]   = useState({ name: '', handle: '', title: '', bio: '', skills: '', githubUrl: '', email: '' });
  const [profileResult, setProfileResult] = useState('');
  const [profileError,  setProfileError]  = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [blogPosts,     setBlogPosts]     = useState<BlogPost[]>([]);
  const [blogLoading,   setBlogLoading]   = useState(true);
  const [blogLoadErr,   setBlogLoadErr]   = useState('');
  const [blogForm,      setBlogForm]      = useState<BlogForm | null>(null);
  const [blogSaveResult,setBlogSaveResult]= useState('');
  const [blogSaveError, setBlogSaveError] = useState(false);
  const [blogDeleting,  setBlogDeleting]  = useState<string | null>(null);
  const [blogConfirm,   setBlogConfirm]   = useState<BlogPost | null>(null);
  const [blogPage,      setBlogPage]      = useState(1);
  const [blogSort,      setBlogSort]      = useState<{ key: BlogSortKey; dir: 'asc' | 'desc' } | null>(null);
  const [tab,          setTab]          = useState<TabKey>('overview');
  const [liveStatus,   setLiveStatus]   = useState<LiveStatus>('connecting');
  const [analytics,    setAnalytics]    = useState<AnalyticsResponse | null>(null);
  const [analyticsErr, setAnalyticsErr] = useState('');
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [trafficPeriod, setTrafficPeriod] = useState<'today' | 'last7' | 'last30'>('last7');

  const sseRef        = useRef<EventSource | null>(null);
  const fallbackTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const J = { 'Content-Type': 'application/json; charset=utf-8' };

  // ── 데이터 로더 ─────────────────────────────────────────────────────────────
  const loadBriefings = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/briefings');
      if (!res.ok) { setBriefingErr(`브리핑 조회 실패 (${res.status})`); return; }
      const list = (await res.json()) as BriefingRecord[];
      setBriefingErr('');
      if (list.length > 0) setBriefing(list[0]);
    } catch (e) {
      setBriefingErr(`브리핑 조회 오류: ${String(e)}`);
    }
  }, []);

  const loadAll = useCallback(() => {
    void loadBriefings();
  }, [loadBriefings]);

  // ── SSE 실시간 구독 + 폴백 폴링 ────────────────────────────────────────────
  useEffect(() => {
    loadAll();

    const startFallback = () => {
      if (fallbackTimer.current) return;
      fallbackTimer.current = setInterval(loadAll, 10_000);
    };
    const stopFallback = () => {
      if (fallbackTimer.current) {
        clearInterval(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    };

    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connectSSE = () => {
      if (destroyed) return;
      const es = new EventSource('/api/admin/stream');
      sseRef.current = es;
      setLiveStatus('connecting');

      es.onopen = () => {
        if (destroyed) { es.close(); return; }
        setLiveStatus('connected');
        stopFallback();
      };

      es.addEventListener('record', (e: MessageEvent) => {
        if (destroyed) return;
        let rec: { type?: string };
        try { rec = JSON.parse(e.data as string) as { type?: string }; }
        catch { return; }
        if (rec.type === 'briefing') setBriefing(rec as unknown as BriefingRecord);
      });

      es.onerror = () => {
        if (destroyed) return;
        es.close();
        sseRef.current = null;
        setLiveStatus('disconnected');
        startFallback();
        reconnectTimeout = setTimeout(connectSSE, 5_000);
      };
    };

    connectSSE();

    return () => {
      destroyed = true;
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      stopFallback();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 브리핑 갱신 (개요 섹션) ──────────────────────────────────────────────────
  const refreshBriefing = useCallback(async () => {
    try {
      await fetch('/api/admin/briefings', { method: 'POST', headers: J, body: '{}' });
      void loadBriefings();
    } catch (e) {
      setBriefingErr(`브리핑 갱신 오류: ${String(e)}`);
    }
  }, [loadBriefings]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 프로필 로드 ─────────────────────────────────────────────────────────────
  const loadProfile = useCallback(async () => {
    try {
      const res  = await fetch('/api/admin/profile');
      if (!res.ok) return;
      const data = await res.json() as {
        name?: string; handle?: string; title?: string; bio?: string;
        skills?: string[]; socials?: Array<{ label: string; href: string; icon: string }>;
      };
      const githubSocial = data.socials?.find(s => s.icon === 'github');
      const emailSocial  = data.socials?.find(s => s.icon === 'mail');
      setProfileForm({
        name:     data.name     ?? '',
        handle:   data.handle   ?? '',
        title:    data.title    ?? '',
        bio:      data.bio      ?? '',
        skills:   Array.isArray(data.skills) ? data.skills.join(', ') : '',
        githubUrl: githubSocial?.href ?? '',
        email:     emailSocial?.href?.replace('mailto:', '') ?? '',
      });
      setProfileLoaded(true);
    } catch { /* 무시 */ }
  }, []);

  // ── 프로필 저장 ─────────────────────────────────────────────────────────────
  const saveProfile = useCallback(async () => {
    setProfileSaving(true);
    setProfileResult('');
    setProfileError(false);
    try {
      const skills  = profileForm.skills.split(',').map(s => s.trim()).filter(Boolean);
      const socials = [
        ...(profileForm.githubUrl ? [{ label: 'GitHub', href: profileForm.githubUrl, icon: 'github' as const }] : []),
        ...(profileForm.email     ? [{ label: 'Email',  href: `mailto:${profileForm.email}`, icon: 'mail' as const }] : []),
        { label: '블로그', href: '/blog', icon: 'blog' as const },
      ];
      const body = { name: profileForm.name, handle: profileForm.handle, title: profileForm.title, bio: profileForm.bio, skills, socials };
      const res  = await fetch('/api/admin/profile', { method: 'POST', headers: J, body: JSON.stringify(body) });
      const data = await res.json();
      setProfileResult(res.ok ? '저장 완료' : (data as { error?: string }).error ?? '저장 실패');
      setProfileError(!res.ok);
    } catch (e) {
      setProfileResult(`오류: ${(e as Error).message}`);
      setProfileError(true);
    } finally {
      setProfileSaving(false);
    }
  }, [profileForm, J]); // eslint-disable-line react-hooks/exhaustive-deps

  // 프로필 초기 로드 (마운트 시 1회 — loadProfile 선언 이후에 배치)
  useEffect(() => { void loadProfile(); }, [loadProfile]);

  // ── 블로그 관리 ─────────────────────────────────────────────────────────────
  const loadBlogPosts = useCallback(async () => {
    setBlogLoading(true);
    setBlogLoadErr('');
    try {
      const res = await fetch('/api/admin/blog');
      if (!res.ok) { setBlogLoadErr(`목록 조회 실패 (${res.status})`); return; }
      setBlogPosts((await res.json()) as BlogPost[]);
    } catch (e) {
      setBlogLoadErr(`목록 조회 오류: ${String(e)}`);
    } finally {
      setBlogLoading(false);
    }
  }, []);

  const openEditBlog = useCallback(async (slug: string) => {
    setBlogSaveResult('');
    setBlogSaveError(false);
    try {
      const res  = await fetch(`/api/admin/blog?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        slug: string; title: string; date: string; status: 'published' | 'draft';
        description?: string; tags?: string[]; content?: string;
      };
      setBlogForm({
        slug:        data.slug,
        title:       data.title       ?? '',
        date:        String(data.date ?? '').slice(0, 10),
        status:      data.status      ?? 'draft',
        description: data.description ?? '',
        tags:        Array.isArray(data.tags) ? data.tags.join(', ') : '',
        content:     data.content     ?? '',
        isNew:       false,
      });
    } catch { /* 무시 */ }
  }, []);

  const openNewBlog = useCallback(() => {
    setBlogSaveResult('');
    setBlogSaveError(false);
    setBlogForm({
      slug:        '',
      title:       '',
      date:        new Date().toISOString().slice(0, 10),
      status:      'draft',
      description: '',
      tags:        '',
      content:     '',
      isNew:       true,
    });
  }, []);

  const saveBlogPost = useCallback(async () => {
    if (!blogForm) return;
    setBlogSaveResult('저장 중…');
    setBlogSaveError(false);
    try {
      const body = {
        slug:        blogForm.slug.trim(),
        title:       blogForm.title.trim(),
        date:        blogForm.date,
        status:      blogForm.status,
        description: blogForm.description,
        tags:        blogForm.tags.split(',').map(t => t.trim()).filter(Boolean),
        content:     blogForm.content,
      };
      const res  = await fetch('/api/admin/blog', { method: 'POST', headers: J, body: JSON.stringify(body) });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok) {
        setBlogSaveResult('저장 완료');
        setBlogForm(null);
        void loadBlogPosts();
      } else {
        setBlogSaveResult(data.error ?? '저장 실패');
        setBlogSaveError(true);
      }
    } catch (e) {
      setBlogSaveResult(`오류: ${(e as Error).message}`);
      setBlogSaveError(true);
    }
  }, [blogForm, loadBlogPosts, J]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteBlogPost = useCallback(async (slug: string) => {
    setBlogConfirm(null);
    setBlogDeleting(slug);
    try {
      await fetch(`/api/admin/blog?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      void loadBlogPosts();
    } finally {
      setBlogDeleting(null);
    }
  }, [loadBlogPosts]);

  // 블로그 목록 초기 로드
  useEffect(() => { void loadBlogPosts(); }, [loadBlogPosts]);

  // 블로그 목록 정렬(클라이언트 — 기본은 API 순서 유지)
  const blogSorted = useMemo(() => {
    if (!blogSort) return blogPosts;
    const out = [...blogPosts].sort((a, b) => {
      if (blogSort.key === 'title') return a.title.localeCompare(b.title, 'ko');
      if (blogSort.key === 'views') return (a.views ?? 0) - (b.views ?? 0);
      return a.date.localeCompare(b.date);
    });
    return blogSort.dir === 'desc' ? out.reverse() : out;
  }, [blogPosts, blogSort]);

  const blogAriaSort = (key: BlogSortKey) =>
    blogSort?.key === key ? (blogSort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const toggleBlogSort = (key: BlogSortKey) =>
    setBlogSort((cur) => (cur?.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // 빈 상태(Empty)가 렌더되는 조건 — 이때만 주 액션이 빈 상태로 넘어간다(§4.4·§4.14).
  const blogIsEmpty = !blogLoadErr && !blogLoading && blogPosts.length === 0;

  // 블로그 목록 페이지네이션 (클라이언트 슬라이스 — 삭제로 페이지가 사라지면 마지막 페이지로 클램프)
  const blogTotalPages = Math.max(1, Math.ceil(blogSorted.length / BLOG_PAGE_SIZE));
  const blogPageSafe   = Math.min(blogPage, blogTotalPages);
  const blogFrom       = (blogPageSafe - 1) * BLOG_PAGE_SIZE;
  const blogPagePosts  = blogSorted.slice(blogFrom, blogFrom + BLOG_PAGE_SIZE);
  // 페이지 번호 표시: 7페이지 이하 전부, 초과 시 처음·끝·현재±1 창(사이 공백은 '…')
  const blogPageNums: (number | '…')[] = (() => {
    if (blogTotalPages <= 7) return Array.from({ length: blogTotalPages }, (_, idx) => idx + 1);
    const keep = new Set([1, 2, blogPageSafe - 1, blogPageSafe, blogPageSafe + 1, blogTotalPages - 1, blogTotalPages]);
    const out: (number | '…')[] = [];
    for (let p = 1; p <= blogTotalPages; p++) {
      if (keep.has(p)) out.push(p);
      else if (out[out.length - 1] !== '…') out.push('…');
    }
    return out;
  })();

  // ── 트래픽 집계 로드 (/api/admin/analytics) ──────────────────────────────────
  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setAnalyticsErr('');
    try {
      const res = await fetch('/api/admin/analytics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAnalytics(await res.json());
    } catch (e) {
      setAnalyticsErr((e as Error).message || '불러오기 실패');
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  // 트래픽 탭 진입 시 로드(처음 한 번)
  useEffect(() => {
    if (tab === 'traffic' && !analytics && !analyticsLoading) void loadAnalytics();
  }, [tab, analytics, analyticsLoading, loadAnalytics]);

  const live = LIVE_TAG[liveStatus];

  // 개요 타임라인 데이터
  const alertItems = (briefing?.alerts ?? []).map((a) => ({
    main: a.detail,
    meta: [a.type, a.severity].filter(Boolean).join(' · ') || undefined,
  }));
  const decisionItems = (briefing?.decisions ?? []).map((d) => ({
    main: d.item,
    meta: Array.isArray(d.options) && d.options.length ? d.options.join(' / ') : undefined,
  }));

  // ── 렌더 ────────────────────────────────────────────────────────────────────
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">CEO 대시보드</h1>
          <p className="page-sub">로그인: {adminId}</p>
        </div>
        <div className="page-actions">
          <span className={live.cls}>{live.label}</span>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="대시보드 섹션">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            id={`admin-tab-${t.key}`}
            className="tab"
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={`admin-panel-${t.key}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ① 개요·브리핑 */}
      <section
        id="admin-panel-overview"
        role="tabpanel"
        aria-labelledby="admin-tab-overview"
        hidden={tab !== 'overview'}
      >
        <div className="section-head">
          <h4>어제 요약</h4>
          <span className="text-muted">{briefing ? new Date(briefing.ts).toLocaleString('ko-KR') : '—'}</span>
          <div className="spacer" />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshBriefing()}>
            <RefreshCw size={16} aria-hidden />
            갱신
          </button>
        </div>

        {briefingErr ? (
          <ErrorState detail={briefingErr} onRetry={() => void refreshBriefing()} />
        ) : !briefing ? (
          <div className="stack"><CardSkeleton count={2} /></div>
        ) : (
          <div className="grid-sidebar">
            <div className="stack">
              <div className="card">
                <span className="card-kicker">성과</span>
                <span className="card-title">어제 발행 성과</span>
                <BriefingDl data={briefing.yesterday} />
              </div>
              <div className="card">
                <span className="card-kicker">비용</span>
                <span className="card-title">예산 현황</span>
                <BriefingDl data={briefing.budget} />
              </div>
            </div>
            <div className="stack">
              <div className="card">
                <span className="card-kicker">활동 로그</span>
                <span className="card-title">주의 · 이상 알람</span>
                <BriefingTimeline items={alertItems} empty="이상 없음" />
              </div>
              <div className="card">
                <span className="card-kicker">할 일</span>
                <span className="card-title">결정 필요 건</span>
                <BriefingTimeline items={decisionItems} empty="결정 대기 없음" />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ② 트래픽 */}
      <section
        id="admin-panel-traffic"
        role="tabpanel"
        aria-labelledby="admin-tab-traffic"
        hidden={tab !== 'traffic'}
      >
        <div className="toolbar">
          <div className="seg">
            {PERIODS.map((p) => (
              <label className="seg-opt" key={p.key}>
                <input
                  type="radio"
                  name="traffic-period"
                  checked={trafficPeriod === p.key}
                  onChange={() => setTrafficPeriod(p.key)}
                />
                {p.label}
              </label>
            ))}
          </div>
          <div className="spacer" />
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void loadAnalytics()}
            disabled={analyticsLoading}
          >
            {analyticsLoading ? <span className="spinner" /> : <RefreshCw size={16} aria-hidden />}
            새로고침
          </button>
        </div>

        {analyticsErr ? (
          <ErrorState title="집계를 불러오지 못했습니다" detail={analyticsErr} onRetry={() => void loadAnalytics()} />
        ) : !analytics ? (
          analyticsLoading
            ? <div className="grid-4"><CardSkeleton count={4} /></div>
            : <Empty title="집계 데이터가 없습니다" body="방문이 기록되면 조회수·방문자 지표가 집계됩니다." />
        ) : (() => {
          const cur = analytics[trafficPeriod];
          const pv = cur?.total_pv ?? 0;
          const cuv = cur?.client_uv ?? 0;
          const suv = cur?.server_uv ?? 0;
          // 관리자(role=admin) 테스트 트래픽 — 위 실제 통계에서 제외돼 별도 표시.
          const adminPv = cur?.admin_pv ?? 0;
          const adminCuv = cur?.admin_client_uv ?? 0;
          const adminSuv = cur?.admin_server_uv ?? 0;
          const hasAdminTraffic = adminPv > 0 || adminCuv > 0 || adminSuv > 0;
          const trend = analytics.last30?.by_day ?? [];
          const periodLabel = PERIODS.find((p) => p.key === trafficPeriod)?.label ?? '';
          const stats = [
            { label: '조회수 (PV)',   value: pv,  note: '서버 집계 · 광고차단 무관' },
            { label: '방문자 (UV)',   value: cuv, note: '실측 · 사람 방문 하한값' },
            { label: '페이지/방문',   value: cuv ? Math.round((pv / cuv) * 10) / 10 : 0, note: 'PV ÷ UV(실측)' },
            { label: 'UV (서버추정)', value: suv, note: '차단 불가 · NAT 은 1명으로 셈' },
          ];
          return (
            <div className="stack-6">
              {hasAdminTraffic && (
                <div className="banner" data-tone="warning">
                  <span>
                    <b>관리자 테스트 트래픽 — 아래 실제 통계에서 제외됨</b><br />
                    {periodLabel} · PV {adminPv.toLocaleString()} · UV {adminCuv.toLocaleString()}
                    {' '}(+서버추정 {adminSuv.toLocaleString()})
                  </span>
                </div>
              )}

              <div className="grid-4">
                {stats.map((s) => (
                  <div className="stat" key={s.label}>
                    <span className="stat-label">{s.label}</span>
                    <span className="stat-value">{s.value.toLocaleString()}</span>
                    <span className="card-meta">{s.note}</span>
                  </div>
                ))}
              </div>

              <div className="grid-sidebar">
                <div className="card">
                  <div className="section-head">
                    <h5>일자별 조회수 추세</h5>
                    <span className="text-muted">최근 30일</span>
                  </div>
                  <AreaChartPV data={trend} />
                </div>
                <div className="card">
                  <div className="section-head">
                    <h5>UV 구성</h5>
                    <span className="text-muted">{periodLabel}</span>
                  </div>
                  <DonutUV clientUV={cuv} serverUV={suv} />
                  <p className="card-meta">서버추정은 차단 불가하나 같은 통신망(NAT)을 한 명으로 셉니다.</p>
                </div>
              </div>

              <div className="grid-2">
                <div className="card">
                  <div className="section-head">
                    <h5>인기 경로</h5>
                    <span className="text-muted">{periodLabel}</span>
                  </div>
                  <BarList
                    items={(cur?.top_paths ?? []).map((p) => ({ label: p.path, value: p.pv }))}
                    empty="데이터 없음"
                  />
                </div>
                <div className="card">
                  <div className="section-head">
                    <h5>유입 출처</h5>
                    <span className="text-muted">{periodLabel}</span>
                  </div>
                  <BarList
                    items={(cur?.top_referrers ?? []).map((r) => ({ label: r.referrer, value: r.count }))}
                    tone="success"
                    empty="직접 유입만 (외부 리퍼러 없음)"
                  />
                </div>
              </div>

              <p className="text-muted">
                PV는 서버에서 직접 집계해 광고차단의 영향을 받지 않습니다. UV(실측)는 브라우저 신호 기반이라
                사람 방문자의 하한값이며, UV(서버추정)는 차단 불가하지만 같은 통신망(NAT) 사용자를 한 명으로 셉니다.
              </p>
            </div>
          );
        })()}
      </section>

      {/* ③ 프로필 관리 */}
      <section
        id="admin-panel-profile"
        role="tabpanel"
        aria-labelledby="admin-tab-profile"
        hidden={tab !== 'profile'}
      >
        {!profileLoaded ? (
          <div className="stack"><CardSkeleton count={1} /></div>
        ) : (
          <div className="card stack">
            <div className="section-head">
              <h4>공개 프로필</h4>
              <span className="text-muted">메인페이지 소개 영역에 노출</span>
            </div>

            {profileResult && (
              <div className="banner" data-tone={profileError ? 'danger' : 'success'} role="status">
                <span>{profileResult}</span>
              </div>
            )}

            <div className="grid-2">
              <div className="field">
                <label htmlFor="pf-name">이름</label>
                <input
                  id="pf-name"
                  className="input"
                  value={profileForm.name}
                  onChange={e => setProfileForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="Thundo"
                />
              </div>
              <div className="field">
                <label htmlFor="pf-handle">핸들 (@)</label>
                <input
                  id="pf-handle"
                  className="input"
                  value={profileForm.handle}
                  onChange={e => setProfileForm(p => ({ ...p, handle: e.target.value }))}
                  placeholder="thundo"
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="pf-title">타이틀</label>
              <input
                id="pf-title"
                className="input"
                value={profileForm.title}
                onChange={e => setProfileForm(p => ({ ...p, title: e.target.value }))}
                placeholder="백엔드 · 자동화 엔지니어"
              />
            </div>

            <div className="field">
              <label htmlFor="pf-bio">소개</label>
              <textarea
                id="pf-bio"
                className="input"
                rows={3}
                value={profileForm.bio}
                onChange={e => setProfileForm(p => ({ ...p, bio: e.target.value }))}
                placeholder="한두 줄 소개…"
              />
            </div>

            <div className="field">
              <label htmlFor="pf-skills">기술 스택 (쉼표 구분)</label>
              <input
                id="pf-skills"
                className="input"
                value={profileForm.skills}
                onChange={e => setProfileForm(p => ({ ...p, skills: e.target.value }))}
                placeholder="TypeScript, Node.js, Next.js, …"
              />
            </div>

            <div className="grid-2">
              <div className="field">
                <label htmlFor="pf-github">GitHub URL</label>
                <input
                  id="pf-github"
                  className="input"
                  type="url"
                  value={profileForm.githubUrl}
                  onChange={e => setProfileForm(p => ({ ...p, githubUrl: e.target.value }))}
                  placeholder="https://github.com/yourname"
                />
              </div>
              <div className="field">
                <label htmlFor="pf-email">이메일</label>
                <input
                  id="pf-email"
                  className="input"
                  type="email"
                  value={profileForm.email}
                  onChange={e => setProfileForm(p => ({ ...p, email: e.target.value }))}
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div className="row-end">
              <button type="button" className="btn btn-secondary" onClick={() => void loadProfile()} disabled={profileSaving}>
                다시 불러오기
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void saveProfile()} disabled={profileSaving}>
                {profileSaving && <span className="spinner" />}
                저장
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ④ 블로그 관리 */}
      <section
        id="admin-panel-blog"
        role="tabpanel"
        aria-labelledby="admin-tab-blog"
        hidden={tab !== 'blog'}
      >
        {blogForm === null ? (
          <>
            <div className="toolbar">
              <span className="tag tag-neutral">{blogPosts.length}편</span>
              <div className="spacer" />
              {/* 빈 상태가 뜨면 그 화면의 유일한 primary 는 빈 상태의 액션이다(§4.4·§4.14) —
                  같은 '새 글' 이 툴바에도 있으므로 이때는 툴바 쪽을 secondary 로 내린다. */}
              <button
                type="button"
                className={blogIsEmpty ? 'btn btn-secondary' : 'btn btn-primary'}
                onClick={openNewBlog}
              >
                <Plus size={16} aria-hidden />
                새 글
              </button>
            </div>

            {blogSaveResult && (
              <div className="banner" data-tone={blogSaveError ? 'danger' : 'success'} role="status">
                <span>{blogSaveResult}</span>
              </div>
            )}

            {blogLoadErr ? (
              <ErrorState detail={blogLoadErr} onRetry={() => void loadBlogPosts()} />
            ) : !blogLoading && blogPosts.length === 0 ? (
              <Empty
                title="아직 작성된 글이 없습니다"
                body="새 글을 작성하면 목록과 공개 블로그에 노출됩니다."
                action={
                  <button type="button" className="btn btn-primary" onClick={openNewBlog}>
                    <Plus size={16} aria-hidden />
                    새 글 작성
                  </button>
                }
              />
            ) : (
              <>
                <div className="table-scroll">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>상태</th>
                        <th aria-sort={blogAriaSort('title')} onClick={() => toggleBlogSort('title')}>제목</th>
                        <th>슬러그</th>
                        <th aria-sort={blogAriaSort('date')} onClick={() => toggleBlogSort('date')}>날짜</th>
                        <th className="num" aria-sort={blogAriaSort('views')} onClick={() => toggleBlogSort('views')}>조회수</th>
                        <th />
                      </tr>
                    </thead>
                    {blogLoading ? (
                      <TableSkeleton cols={6} />
                    ) : (
                      <tbody>
                        {blogPagePosts.map((post) => (
                          <tr key={post.slug}>
                            <td>
                              <span className={post.status === 'published' ? 'tag tag-success' : 'tag tag-warning'}>
                                {post.status === 'published' ? '발행됨' : '초안'}
                              </span>
                            </td>
                            <td>{post.title || '(제목 없음)'}</td>
                            <td className="text-mono">{post.slug}</td>
                            <td>{post.date}</td>
                            <td className="num">
                              {typeof post.views === 'number' ? post.views.toLocaleString() : '—'}
                            </td>
                            <td className="num">
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => void openEditBlog(post.slug)}
                              >
                                <Pencil size={16} aria-hidden />
                                편집
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={blogDeleting === post.slug}
                                onClick={() => setBlogConfirm(post)}
                              >
                                <Trash2 size={16} aria-hidden />
                                삭제
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    )}
                  </table>
                </div>

                {blogTotalPages > 1 && (
                  <div className="pagination">
                    <button
                      type="button"
                      className="page-btn"
                      disabled={blogPageSafe <= 1}
                      onClick={() => setBlogPage(blogPageSafe - 1)}
                    >
                      <ChevronLeft size={16} aria-hidden />
                      이전
                    </button>
                    {blogPageNums.map((p, idx) =>
                      p === '…' ? (
                        <span className="text-muted" key={`gap-${idx}`}>…</span>
                      ) : (
                        <button
                          type="button"
                          className="page-btn"
                          key={p}
                          aria-current={p === blogPageSafe ? 'page' : undefined}
                          onClick={() => setBlogPage(p)}
                        >
                          {p}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      className="page-btn"
                      disabled={blogPageSafe >= blogTotalPages}
                      onClick={() => setBlogPage(blogPageSafe + 1)}
                    >
                      다음
                      <ChevronRight size={16} aria-hidden />
                    </button>
                    <div className="spacer" />
                    <span className="text-muted">
                      {blogFrom + 1}–{blogFrom + blogPagePosts.length} / {blogSorted.length}건
                    </span>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          /* ── 편집 뷰 ── */
          <div className="stack-6">
            <div className="row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setBlogForm(null)}>
                <ArrowLeft size={16} aria-hidden />
                목록으로
              </button>
              <span className="text-muted">
                {blogForm.isNew ? '새 글 작성' : (blogForm.title || blogForm.slug || '글 편집')}
              </span>
              {blogForm.isNew && <span className="tag tag-accent">새 글</span>}
            </div>

            {blogSaveResult && blogSaveResult !== '저장 중…' && (
              <div className="banner" data-tone={blogSaveError ? 'danger' : 'success'} role="status">
                <span>{blogSaveResult}</span>
              </div>
            )}

            <div className="card stack">
              <div className="section-head">
                <h4>메타 정보</h4>
              </div>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="bg-slug">슬러그 (URL)</label>
                  <input
                    id="bg-slug"
                    className="input"
                    value={blogForm.slug}
                    onChange={e => setBlogForm(p => p ? { ...p, slug: e.target.value } : p)}
                    disabled={!blogForm.isNew}
                    placeholder="my-post-slug"
                  />
                  {!blogForm.isNew && <span className="field-hint">발행 후에는 바꿀 수 없습니다.</span>}
                </div>
                <div className="field">
                  <label htmlFor="bg-title">제목</label>
                  <input
                    id="bg-title"
                    className="input"
                    value={blogForm.title}
                    onChange={e => setBlogForm(p => p ? { ...p, title: e.target.value } : p)}
                    placeholder="글 제목을 입력하세요"
                  />
                </div>
                <div className="field">
                  <label htmlFor="bg-date">날짜</label>
                  <input
                    id="bg-date"
                    className="input"
                    type="date"
                    value={blogForm.date}
                    onChange={e => setBlogForm(p => p ? { ...p, date: e.target.value } : p)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="bg-status">상태</label>
                  <select
                    id="bg-status"
                    className="input"
                    value={blogForm.status}
                    onChange={e => setBlogForm(p => p ? { ...p, status: e.target.value as 'published' | 'draft' } : p)}
                  >
                    <option value="draft">초안 (draft)</option>
                    <option value="published">발행 (published)</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="bg-desc">설명</label>
                <input
                  id="bg-desc"
                  className="input"
                  value={blogForm.description}
                  onChange={e => setBlogForm(p => p ? { ...p, description: e.target.value } : p)}
                  placeholder="검색 결과에 표시될 한 줄 설명"
                />
                <span className="field-hint">SEO meta description</span>
              </div>

              <div className="field">
                <label htmlFor="bg-tags">태그</label>
                <input
                  id="bg-tags"
                  className="input"
                  value={blogForm.tags}
                  onChange={e => setBlogForm(p => p ? { ...p, tags: e.target.value } : p)}
                  placeholder="AI, 자동화, 생산성"
                />
                <span className="field-hint">쉼표로 구분</span>
              </div>
            </div>

            {/* 마크다운 에디터 (client-only) */}
            <BlogEditor
              key={blogForm.slug || '__new__'}
              initialValue={blogForm.content}
              onChangeContent={c => setBlogForm(p => p ? { ...p, content: c } : p)}
            />

            <div className="row-end">
              <button type="button" className="btn btn-secondary" onClick={() => setBlogForm(null)}>
                취소
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveBlogPost()}
                disabled={blogSaveResult === '저장 중…'}
              >
                {blogSaveResult === '저장 중…' && <span className="spinner" />}
                저장
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ⑤ 프로젝트 관리 — projects 테이블 CRUD */}
      <section
        id="admin-panel-projects"
        role="tabpanel"
        aria-labelledby="admin-tab-projects"
        hidden={tab !== 'projects'}
      >
        <ProjectsAdmin embedded />
      </section>

      {/* ⑥ 에이전트 관리 — agents 테이블 CRUD */}
      <section
        id="admin-panel-agents"
        role="tabpanel"
        aria-labelledby="admin-tab-agents"
        hidden={tab !== 'agents'}
      >
        <AgentsAdmin embedded />
      </section>

      {blogConfirm && (
        <ConfirmDialog
          title="글을 삭제할까요?"
          body={`'${blogConfirm.title || blogConfirm.slug}' 을(를) 삭제하면 공개 블로그에서 즉시 사라집니다. 복구할 수 없습니다.`}
          confirmLabel="삭제"
          busy={blogDeleting === blogConfirm.slug}
          onConfirm={() => void deleteBlogPost(blogConfirm.slug)}
          onClose={() => setBlogConfirm(null)}
        />
      )}
    </main>
  );
}
