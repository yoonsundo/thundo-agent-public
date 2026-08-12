/**
 * server/hub/config.ts — 최소 환경 설정 shim (config.mjs 대체)
 * process.env 직접 접근. 파일 로드 없음.
 * 경로는 env 오버라이드 우선, 없으면 합리적 기본값.
 */
import path from 'path';
import { existsSync, readFileSync } from 'fs';

/** env(key, fallback) — process.env 읽기 헬퍼 */
export function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

/** Supabase 서비스롤 키 이름 통일 (web 프로젝트 관례) */
export function supabaseServiceKey(): string {
  return env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE');
}

/** 경로 — 환경변수 오버라이드 지원 */
export const paths = {
  /** state/hub JSONL 루트 (dev용 폴백, Vercel에서는 Supabase 사용) */
  state: process.env.STATE_DIR_OVERRIDE ?? path.join(process.cwd(), 'state'),
  /** blog-publisher runs/ 디렉토리 (브리핑 생성에 필요) */
  runs: process.env.RUNS_DIR_OVERRIDE ?? path.join(process.cwd(), '..', '..', '..', 'runs'),
  /** 감사로그 디렉토리 */
  audit: process.env.AUDIT_DIR_OVERRIDE ?? path.join(process.cwd(), 'state', 'audit'),
  /** blog-publisher config/ 디렉토리 (budget.json 등) */
  config: process.env.CONFIG_DIR_OVERRIDE ?? path.join(process.cwd(), '..', '..', '..', 'config'),
};

/** budget.json 로드 (없으면 null) */
export function loadBudget(): Record<string, unknown> | null {
  const p = path.join(paths.config, 'budget.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
