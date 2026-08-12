/**
 * server/siteProfile.ts — 랜딩 프로필 서버 유틸 (서버 전용)
 *
 * - getProfile(): service_role 로 site_profile id=1 읽기.
 *   테이블 없거나 행 없으면 하드코딩 기본값 반환 (폴백).
 * - saveProfile(data): service_role upsert id=1.
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */
import { getSupabase } from '@/lib/supabase';
import careerDefaults from './career.default.json';

// ─── 타입 ─────────────────────────────────────────────────────────────────────
export interface SocialLink {
  label: string;
  href:  string;
  icon:  'github' | 'mail' | 'blog' | 'link';
}

/** 경력 연혁 한 줄 — projects.default.json 기반, 최신순. */
export interface CareerItem {
  period:  string;
  title:   string;
  summary: string;
}

export interface SiteProfileData {
  name:      string;
  handle:    string;
  title:     string;
  bio:       string;
  avatar:    string;
  location?: string;
  available?: boolean;
  skills:    string[];
  socials:   SocialLink[];
  /** 경력 연혁(최신순). 사이트챗 '경력은 뭐야?' 답변 근거. */
  career?:   CareerItem[];
}

// ─── 기본값 (Supabase 미연결·테이블 없음·행 없음 폴백) ────────────────────────
const DEFAULT_PROFILE: SiteProfileData = {
  name:      'Thundo',
  handle:    'thundo',
  title:     '백엔드 개발자 · AI 데이터 플랫폼 엔지니어',
  bio:       'Java/Spring 기반 엔터프라이즈 업무 시스템과 Python/FastAPI 기반 AI 데이터 플랫폼을 함께 구축해 왔습니다. RAG, Elasticsearch, 대규모 크롤링, 분석 API, LLM 보고서 자동화, AWS 배포·운영까지 실서비스 기준으로 설계하고 안정화한 경험을 포트폴리오에 정리했습니다.',
  avatar:    '/profile.png',
  location:  'Seoul, KR',
  available: true,
  skills:    ['Java', 'Spring Framework', 'Python', 'FastAPI', 'Elasticsearch', 'PostgreSQL', 'Oracle', 'AWS', 'Docker', 'GitLab CI/CD', 'RAG', 'LangGraph'],
  socials: [
    { label: 'GitHub', href: 'https://github.com/', icon: 'github' },
    { label: 'Email',  href: 'mailto:contact@example.com', icon: 'mail' },
    { label: '블로그', href: '/blog', icon: 'blog' },
  ],
  career: careerDefaults as CareerItem[],
};

// ─── getProfile ───────────────────────────────────────────────────────────────
export async function getProfile(): Promise<SiteProfileData> {
  const db = getSupabase();
  if (!db) return DEFAULT_PROFILE;

  try {
    const { data, error } = await db
      .from('site_profile')
      .select('data')
      .eq('id', 1)
      .maybeSingle();

    if (error || !data?.data) return DEFAULT_PROFILE;

    const raw = data.data as Partial<SiteProfileData>;
    // 부분 데이터 → 기본값 병합으로 안전하게 반환
    return {
      ...DEFAULT_PROFILE,
      ...raw,
      skills:  Array.isArray(raw.skills)  ? raw.skills  : DEFAULT_PROFILE.skills,
      socials: Array.isArray(raw.socials) ? raw.socials : DEFAULT_PROFILE.socials,
      career:  Array.isArray(raw.career)  ? raw.career  : DEFAULT_PROFILE.career,
    };
  } catch {
    return DEFAULT_PROFILE;
  }
}

// ─── saveProfile ──────────────────────────────────────────────────────────────
export async function saveProfile(data: SiteProfileData): Promise<{ ok: boolean; error?: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결 — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 확인' };

  try {
    const { error } = await db
      .from('site_profile')
      .upsert({ id: 1, data, updated_at: new Date().toISOString() });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
