/**
 * internal-links.mjs — 결정론적 내부링크 추천기 (SUGGESTION-ONLY)
 *
 * 발행된 글(published/*.md) 코퍼스를 읽어, 각 글마다 태그·제목 유사도로
 * "관련 글" 내부링크 후보를 추천한다. SEO 내부링크(tapestry) 이득을 노리되
 * 라이브 본문은 절대 건드리지 않는다.
 *
 * ⚠ APPLY 경로(미래 opt-in) 설계 메모:
 *   실제 링크 삽입은 반드시 DRAFT 단계(발행 전) 작가 컨텍스트로만 해야 한다.
 *   published/ 본문을 사후 재작성하면
 *     - 게이트 #12 internal-dup(4-gram Jaccard >0.107) 를 재유발할 위험,
 *     - enrich 재실행 트리거,
 *     - 게이트 #5 links(생존성·assertionGuard) 재검사 필요
 *   가 생긴다. 그래서 이 스크립트는 의도적으로 "제안 전용"이다.
 *   추천을 실제 링크로 쓰려면 이 산출물을 작가/beaver·fox·wolf 프롬프트
 *   컨텍스트로 주입해 발행 전 초안에 자연스럽게 녹여라. published/ 를
 *   되받아 고치는 자동적용은 하지 말 것.
 *
 * 스코어링(결정론):
 *   score = 0.7 * tagJaccard + 0.3 * titleOverlap
 *     - tagJaccard   : 두 글 태그 집합의 Jaccard (교집합/합집합), 정규화(소문자·공백제거)
 *     - titleOverlap : 제목 내용어 토큰 집합의 Jaccard (공백분리 + 구두점 제거, 1글자 토큰 제외)
 *   자기 자신 제외. 이미 본문에 /blog/<target-slug> 링크가 있으면 제외.
 *   score==0 은 드롭. 소스별 상위 N(기본 3, INTERNAL_LINKS_TOPN) 개만 emit.
 *
 * 산출물(state/internal-links/):
 *   suggestions.json — 기계용 { generated_at, posts:[{slug,title,suggestions:[...]}] }
 *   suggestions.md   — 사람용 요약 (한국어 헤더, 소스별 그룹)
 *
 * exit: 0=정상(추천 0건이어도), 1=실패, 2=실행오류
 * stdout: 한 줄 JSON 요약 {posts, pairs, out}
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('internal-links');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT     = join(__dirname, '..', '..');
const PUBLISHED_DIR = join(REPO_ROOT, 'published');
const OUT_DIR       = join(REPO_ROOT, 'state', 'internal-links');
const TOP_N = Math.max(1, parseInt(process.env.INTERNAL_LINKS_TOPN || '3', 10) || 3);

const W_TAG   = 0.7;  // 태그 Jaccard 가중치
const W_TITLE = 0.3;  // 제목 오버랩 가중치

// ── YAML-lite 프론트매터 리더 (title/date/status/tags 만) ─────────────────────
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    // 최상위(들여쓰기 0) 키만 — source_refs 등 중첩 title: 오탐 방지. 첫 매칭 우선.
    const kv = line.match(/^(title|date|status|tags)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    if (fm[key] !== undefined || (key === 'tags' && fm.tags !== undefined)) continue;
    let val = kv[2].trim();
    if (key === 'tags') {
      // ["a", "b"] 형태 → 배열. 대괄호 안 따옴표 토큰만 추출.
      const inner = val.replace(/^\[|\]$/g, '');
      fm.tags = inner
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '').trim();
    }
  }
  return fm;
}

// slug = 파일명에서 YYYY-MM-DD- 접두어와 .md 제거
function slugFromFilename(name) {
  return name.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

// 태그 정규화 (소문자 + 내부 공백 제거)
function normTag(t) {
  return t.toLowerCase().replace(/\s+/g, '');
}

// 제목 토큰화 (공백분리 + 구두점 제거, 1글자 토큰 제외)
function titleTokens(title) {
  return (title || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length >= 2);
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  for (const x of aSet) if (bSet.has(x)) inter++;
  const union = aSet.size + bSet.size - inter;
  return union === 0 ? 0 : inter / union;
}

function main() {
  if (!existsSync(PUBLISHED_DIR)) {
    log.warn(`published 디렉터리 없음: ${PUBLISHED_DIR}`);
    return emit([]);
  }

  const files = readdirSync(PUBLISHED_DIR).filter((f) => f.endsWith('.md')).sort();
  const posts = [];
  for (const f of files) {
    let raw;
    try {
      raw = readFileSync(join(PUBLISHED_DIR, f), 'utf8');
    } catch (e) {
      log.warn(`읽기 실패 스킵: ${f}`, e);
      continue;
    }
    const fm = parseFrontmatter(raw);
    // status 필드가 있고 published 가 아니면 스킵
    if (fm.status && fm.status !== 'published') {
      log.info(`status=${fm.status} 스킵: ${f}`);
      continue;
    }
    const slug = slugFromFilename(f);
    const tags = (fm.tags || []).map(normTag);
    posts.push({
      file: f,
      slug,
      title: fm.title || slug,
      tagSet: new Set(tags),
      rawTags: fm.tags || [],
      titleSet: new Set(titleTokens(fm.title)),
      body: raw,
    });
  }

  log.info(`코퍼스 로드: ${posts.length}편`);
  if (posts.length < 2) {
    return emit([]); // 단일/빈 코퍼스 → 추천 없음
  }

  const out = [];
  let pairCount = 0;
  for (const src of posts) {
    const cands = [];
    for (const tgt of posts) {
      if (tgt.slug === src.slug) continue;
      // 이미 본문에 링크가 있으면 제외
      if (src.body.includes(`/blog/${tgt.slug}`)) continue;
      const tagJ = jaccard(src.tagSet, tgt.tagSet);
      const titleJ = jaccard(src.titleSet, tgt.titleSet);
      const score = W_TAG * tagJ + W_TITLE * titleJ;
      if (score <= 0) continue;
      const shared = [...src.tagSet].filter((t) => tgt.tagSet.has(t));
      // reason 표시용: 원본 표기 태그 복원
      const sharedDisplay = tgt.rawTags.filter((rt) => shared.includes(normTag(rt)));
      cands.push({
        target_slug: tgt.slug,
        target_title: tgt.title,
        score: Math.round(score * 10000) / 10000,
        shared_tags: sharedDisplay,
        reason: `공유태그 ${sharedDisplay.length}개(tagJaccard=${tagJ.toFixed(3)}) · 제목겹침 ${titleJ.toFixed(3)}`,
      });
    }
    // 결정론 정렬: score desc, 동점은 slug 오름차순
    cands.sort((a, b) => b.score - a.score || a.target_slug.localeCompare(b.target_slug));
    const top = cands.slice(0, TOP_N);
    pairCount += top.length;
    out.push({ slug: src.slug, title: src.title, suggestions: top });
  }

  return emit(out, pairCount);
}

function emit(posts, pairCount) {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const jsonPath = join(OUT_DIR, 'suggestions.json');
  const mdPath   = join(OUT_DIR, 'suggestions.md');
  const pairs = pairCount ?? posts.reduce((n, p) => n + p.suggestions.length, 0);

  writeFileSync(
    jsonPath,
    JSON.stringify({ generated_at: new Date().toISOString(), posts }, null, 2) + '\n',
    'utf8',
  );

  // 사람용 마크다운
  const lines = ['# 내부링크 추천 (제안 전용 · published/ 무수정)', ''];
  lines.push(`생성 시각: ${new Date().toISOString()}`);
  lines.push(`대상 글: ${posts.length}편 · 추천 쌍: ${pairs}건 · 소스별 상위 ${TOP_N}개`, '');
  const withSug = posts.filter((p) => p.suggestions.length > 0);
  if (withSug.length === 0) {
    lines.push('_추천 없음 (공유 태그·제목 겹침 없음)._', '');
  }
  for (const p of withSug) {
    lines.push(`## ${p.title}`);
    lines.push(`소스: \`/blog/${p.slug}\``, '');
    for (const s of p.suggestions) {
      const tagStr = s.shared_tags.length ? ` — 공유태그: ${s.shared_tags.join(', ')}` : '';
      lines.push(`- (${s.score.toFixed(3)}) [${s.target_title}](/blog/${s.target_slug})${tagStr}`);
    }
    lines.push('');
  }
  writeFileSync(mdPath, lines.join('\n'), 'utf8');

  const summary = { posts: posts.length, pairs, out: OUT_DIR };
  process.stdout.write(JSON.stringify(summary) + '\n');
  log.info('완료', summary);
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  log.error('실행오류', e);
  process.exit(2);
}
