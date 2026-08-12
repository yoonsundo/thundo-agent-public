/**
 * crosspub/lib.mjs — 외부 교차발행 공용 유틸
 *
 * 경로·설정·인덱스 I/O를 한곳에 모은다. scripts/naver/ 는 휴면 보존(무수정) —
 * 여기는 그 기계의 플랫폼-일반화 복제다.
 *
 * 테스트 격리: STATE_DIR_OVERRIDE(lib/config.mjs paths.state 경유),
 * PUBLISHED_DIR_OVERRIDE, CROSSPUB_CONFIG_OVERRIDE 지원.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../lib/config.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dir, '../../');

export function crosspubConfigPath() {
  return process.env.CROSSPUB_CONFIG_OVERRIDE || join(REPO_ROOT, 'config', 'crosspub.json');
}

export function publishedDir() {
  return process.env.PUBLISHED_DIR_OVERRIDE || join(REPO_ROOT, 'published');
}

export function queueRoot() {
  return join(paths.state, 'crosspub-queue');
}

export function platformDirs(platform) {
  const root = join(queueRoot(), platform);
  return { root, pending: join(root, 'pending'), posted: join(root, 'posted'), postedLog: join(root, 'posted.jsonl') };
}

export function indexPath() {
  return join(paths.state, 'crosspub-index.json');
}

export function tokensLogPath() {
  return join(queueRoot(), 'tokens.jsonl');
}

export function seoMetricsPath() {
  return join(paths.state, 'seo-metrics.jsonl');
}

export function loadCrosspubConfig() {
  const raw = readFileSync(crosspubConfigPath(), 'utf8');
  const cfg = JSON.parse(raw);
  if (!cfg.platforms || typeof cfg.platforms !== 'object') throw new Error('crosspub.json: platforms 필수');
  return cfg;
}

/** 활성 플랫폼 id 목록 */
export function enabledPlatforms(cfg) {
  return Object.entries(cfg.platforms || {})
    .filter(([, p]) => p && p.enabled)
    .map(([id]) => id);
}

/**
 * crosspub-index.json — per-target 발행 상태의 단일 진실.
 * 스키마: { <slug>: { selected_at?, source_file?, platforms: { <platform>:
 *   { status: 'queued'|'posted', queued_at, posted_at?, url?, pending_file? } } } }
 */
export function loadIndex() {
  const p = indexPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) || {}; }
  catch { return {}; }
}

export function saveIndex(idx) {
  const p = indexPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

/** 간이 frontmatter 파서 (naver 기계와 동일 규칙: 단순 key: value 만) */
export function parseDoc(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fm, body: m[2] };
}

/**
 * published/ 전체 목록 → [{slug, date, file}] (파일명 <YYYY-MM-DD>-<slug>.md 규약).
 * 날짜 내림차순(최신 먼저). 날짜 파싱 안 되는 파일은 제외.
 */
export function listPublishedSlugs() {
  const dir = publishedDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const m = f.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
    if (!m) continue;
    out.push({ date: m[1], slug: m[2], file: join(dir, f) });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** site_base_url 하위 페이지 URL → slug (블로그 글 아니면 null) */
export function urlToSlug(url, siteBaseUrl) {
  const base = (siteBaseUrl || '').replace(/\/$/, '');
  if (!base || !url || !url.startsWith(base + '/')) return null;
  const rest = url.slice(base.length + 1).replace(/[?#].*$/, '').replace(/\/$/, '');
  if (!rest || rest.includes('/')) return null;
  return rest;
}

export function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** 브라우저 자동게시용 영속 프로필 (세션 쿠키만 — 비밀번호 저장 안 함, git 제외) */
export function browserProfileDir() {
  return join(paths.state, 'crosspub-browser-profile');
}

/**
 * storageState 스냅샷 경로. 영속 프로필은 "세션 쿠키"(만료시간 없는 쿠키,
 * 예: 티스토리 TSSESSION)를 디스크에 안 남긴다. 로그인 직후 storageState 를
 * 파일로 떠서 재실행 때 복원하면 세션이 유지된다("로그인 유지"와 동일 원리).
 * 쿠키 포함 → git 제외.
 */
export function sessionStatePath() {
  return join(paths.state, 'crosspub-browser-profile', 'session-state.json');
}

/**
 * recordPosted — pending→posted 전이의 단일 구현.
 * 파일 이동 + posted.jsonl append + crosspub-index 갱신. 감사로그는 호출자 몫
 * (CLI/auto-post 가 각자 actor 문맥으로 append).
 * @param pendingFile pending 디렉토리 안의 파일명(basename)
 */
export function recordPosted(platform, pendingFile, slug, url) {
  const dirs = platformDirs(platform);
  const from = join(dirs.pending, pendingFile);
  if (!existsSync(from)) throw new Error(`pending 파일 없음: ${from}`);
  mkdirSync(dirs.posted, { recursive: true });
  renameSync(from, join(dirs.posted, basename(pendingFile)));
  const rec = { ts: new Date().toISOString(), platform, slug, url: url || null };
  appendFileSync(dirs.postedLog, JSON.stringify(rec) + '\n', 'utf8');

  const idx = loadIndex();
  idx[slug] = idx[slug] || { platforms: {} };
  idx[slug].platforms = idx[slug].platforms || {};
  idx[slug].platforms[platform] = {
    ...(idx[slug].platforms[platform] || {}),
    status: 'posted', posted_at: rec.ts, ...(url ? { url } : {}),
  };
  saveIndex(idx);
  return rec;
}
