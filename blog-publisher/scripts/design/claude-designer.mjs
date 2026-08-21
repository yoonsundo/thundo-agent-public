/**
 * design/claude-designer.mjs — Claude SVG 커버 이미지 디자이너
 *
 * 역할:
 *   - live(RUN_MODE!=mock 또는 IMAGE_LIVE=1): claude CLI를 헤드리스(`claude -p`)로
 *       돌려 글에 어울리는 커버 SVG를 **모델이 직접 작성**하게 한다.
 *       → state/images/<slug>.claude.svg (meta.mock:false, engine:'claude-cli')
 *   - mock 모드 / CLI 부재·실패: mockImageSVG 결정론 SVG로 폴백 (meta.mock:true)
 *
 * 표준계약:
 *   { by:'claude', format:'svg', path:string, alt:string, brief:string,
 *     svg:string, meta:{w,h,bytes,mock?,engine?,public} }
 *
 * 사용:
 *   import { designClaude } from './design/claude-designer.mjs';
 *   const candidate = await designClaude(topic, draft);
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join }                     from 'node:path';
import { spawnSync }                from 'node:child_process';
import { mockImageSVG }             from '../lib/mock-llm.mjs';
import { paths, isMock, env }       from '../lib/config.mjs';
import { makeLogger }               from '../lib/log.mjs';
import { isMainModule } from '../lib/main-module.mjs';
import '../lib/force-subscription.mjs'; // 구독 강제(claude 직접 spawn 방어)

const log = makeLogger('claude-designer');

const CLAUDE_BIN        = env('CLAUDE_BIN', 'claude');
const CLAUDE_TIMEOUT_MS = parseInt(env('CLAUDE_TIMEOUT_MS', '120000'), 10);

// ─── 내부 유틸 ───────────────────────────────────────────────────────────────

/** 파일명에 안전한 슬러그 반환. 영숫자·-·. 만 허용, 없으면 topic.id 폴백. */
function resolveSlug(topic, draft) {
  const raw  = (draft && draft.slug) || (topic && topic.id) || '';
  const safe = raw.replace(/[^a-zA-Z0-9\-_.]/g, '');
  if (safe) return safe;
  const id = (topic && topic.id) || '';
  return id.replace(/[^a-zA-Z0-9\-_.]/g, '') || 'unknown';
}

/** 출력 텍스트에서 첫 유효 SVG 블록 추출. 없으면 null. */
function extractSVG(text) {
  if (!text) return null;
  const m = text.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  const svg = m[0];
  return svg.includes('</svg>') && svg.length > 60 ? svg : null;
}

/**
 * claude CLI를 헤드리스로 호출해 커버 SVG 마크업을 받는다.
 * 미설치/타임아웃/SVG 없음이면 null 반환(호출부 mock 폴백). throw 금지.
 */
function runClaudeCliSVG(title) {
  const prompt = [
    `다음 블로그 글의 커버 일러스트를 SVG 마크업 하나로만 만들어라.`,
    `제목: "${title}"`,
    `요구: viewBox="0 0 1200 630", 텍스트 가독 우선, 차분한 톤, 외부 리소스/스크립트 없음.`,
    `출력은 오직 <svg>...</svg> 원본 마크업만. 코드펜스(\`\`\`)·설명·서론 금지.`,
  ].join('\n');

  let res;
  try {
    res = spawnSync(CLAUDE_BIN, ['-p', prompt], {
      encoding:  'utf8',
      timeout:   CLAUDE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    log.warn(`claude CLI 실행 예외 → 폴백: ${e.message}`);
    return null;
  }
  if (res.error) { log.warn(`claude CLI 사용 불가 → 폴백: ${res.error.message}`); return null; }
  const svg = extractSVG(res.stdout || `${res.stdout || ''}\n${res.stderr || ''}`);
  if (!svg) { log.warn('claude CLI 출력에 유효 SVG 없음 → 폴백'); return null; }
  return svg;
}

// ─── 공개 API ────────────────────────────────────────────────────────────────

/**
 * designClaude(topic, draft, opts={}) → 후보객체 또는 null
 * @param {{ title?:string, id?:string }} topic
 * @param {{ title?:string, slug?:string }} draft
 * @returns {Promise<object|null>}
 */
export async function designClaude(topic, draft, opts = {}) {
  // degenerate 입력 보호 — throw 금지, null 반환
  const title = (topic && topic.title) || (draft && draft.title) || '';
  if (!title.trim()) return null;

  const slug       = resolveSlug(topic, draft);
  const filename   = `${slug}.claude.svg`;
  const imagesDir  = paths.images;
  const publicPath = `/images/${filename}`;

  try {
    mkdirSync(imagesDir, { recursive: true });
    const absPath = join(imagesDir, filename);

    // ── live: claude CLI가 SVG 작성 (IMAGE_LIVE=1 또는 live, COLLECT_LIVE 패턴) ──
    const useCli = !isMock() || env('IMAGE_LIVE') === '1';
    if (useCli) {
      const svg = runClaudeCliSVG(title);
      if (svg) {
        writeFileSync(absPath, svg, 'utf8');
        // alt·brief는 mockImageSVG에서 결정론 생성(by:'claude' 기준) 재사용.
        const base = mockImageSVG(topic, draft);
        log.info(`Claude CLI SVG 기록: ${absPath} (${Buffer.byteLength(svg, 'utf8')}B)`);
        return {
          by: 'claude', format: 'svg', path: absPath, alt: base.alt, brief: base.brief, svg,
          meta: { w: 1200, h: 630, bytes: Buffer.byteLength(svg, 'utf8'), engine: 'claude-cli', public: publicPath },
        };
      }
      // SVG 못 받음 → 아래 결정론 폴백
    }

    // ── mock 모드 / CLI 실패: 결정론 SVG 베이스라인 (항상 동작) ──────────────
    const candidate = mockImageSVG(topic, draft);
    writeFileSync(absPath, candidate.svg, 'utf8');
    log.info(`SVG 기록(mock): ${absPath} (${candidate.meta.bytes}B)`);
    return {
      ...candidate,
      path: absPath,
      meta: { ...candidate.meta, public: publicPath },
    };
  } catch (err) {
    log.error('designClaude 실패 → null 반환', err);
    return null;
  }
}

// CLI 직접 실행 (디버그)
if (isMainModule(import.meta.url)) {
  const title = process.argv[2] || 'AI 자동화로 블로그 발행 파이프라인 만들기';
  designClaude({ title, id: 'cli' }, { title, slug: 'claude-cli-test' })
    .then(c => console.log(JSON.stringify({ by: c?.by, format: c?.format, bytes: c?.meta?.bytes, mock: c?.meta?.mock, engine: c?.meta?.engine }, null, 2)));
}
