/**
 * design/gemini-designer.mjs — Gemini 커버 이미지 디자이너 (gemini CLI 경유)
 *
 * 역할:
 *   - live(RUN_MODE!=mock): 설치된 gemini CLI를 헤드리스(`gemini -p`)로 돌려
 *       글에 어울리는 커버 SVG를 **모델이 직접 작성**하게 한다(별도 API 키 불필요 —
 *       CLI 자체 인증 사용). → state/images/<slug>.gemini.svg (meta.mock:false)
 *   - mock 모드 / CLI 부재·미인증·실패: mockImageRaster placeholder SVG로 폴백
 *       → state/images/<slug>.gemini.svg (meta.mock:true)
 *
 * 설계 메모: gemini CLI는 전용 이미지 서브커맨드가 없는 '에이전트형' CLI다(Claude Code류).
 *   따라서 래스터 렌더 대신 **모델에게 유효한 SVG 마크업을 작성시키는** 방식을 쓴다.
 *   덕분에 Claude(SVG) vs Gemini(SVG) 동일 매체 비교가 되어 judge 공정성이 향상된다.
 *   GEMINI_API_KEY/GCA 로그인 등 CLI 인증이 되면 코드 변경 없이 실모드로 동작.
 *
 * 표준계약:
 *   { by:'gemini', format:'svg', path:string, alt:string, brief:string,
 *     svg?:string, meta:{w,h,bytes,mock?,engine?,public} }
 *
 * 사용:
 *   import { designGemini } from './design/gemini-designer.mjs';
 *   const candidate = await designGemini(topic, draft);
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join }                     from 'node:path';
import { spawnSync }                from 'node:child_process';
import { mockImageRaster }          from '../lib/mock-llm.mjs';
import { paths, isMock, env }       from '../lib/config.mjs';
import { makeLogger }               from '../lib/log.mjs';

const log = makeLogger('gemini-designer');

// ─── CLI 바이너리 해석 ───────────────────────────────────────────────────────
// 우선순위: IMAGE_DESIGN_BIN 명시 > antigravity(agy, PRO 구독 인증) > gemini.
// agy(Antigravity)는 소비자 Google AI Pro 구독으로 헤드리스 인증돼 동작한다.
// (구형 gemini CLI의 GCA 무료 로그인은 종료됨 → agy 가 기본 경로)
const AGY_DEFAULT_PATH = '/home/user/.local/bin/agy';

function resolveDesignBin() {
  const explicit = env('IMAGE_DESIGN_BIN');
  if (explicit) return explicit;
  if (existsSync(AGY_DEFAULT_PATH)) return AGY_DEFAULT_PATH;
  return 'gemini';
}

const DESIGN_BIN        = resolveDesignBin();
const DESIGN_ENGINE     = /agy$/.test(DESIGN_BIN) ? 'antigravity' : 'gemini-cli';
const GEMINI_TIMEOUT_MS = parseInt(env('GEMINI_TIMEOUT_MS', '120000'), 10);

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
  // 최소 유효성: 닫힘 + 일정 길이
  return svg.includes('</svg>') && svg.length > 60 ? svg : null;
}

/**
 * gemini CLI를 헤드리스로 호출해 커버 SVG 마크업을 받는다.
 * 인증 안 됨/미설치/타임아웃이면 null 반환(호출부에서 mock 폴백). throw 금지.
 *
 * @param {string} title
 * @returns {string|null} SVG 마크업 또는 null
 */
function runGeminiCliSVG(title) {
  const prompt = [
    `다음 블로그 글의 커버 일러스트를 SVG 마크업 하나로만 만들어라.`,
    `제목: "${title}"`,
    `요구: viewBox="0 0 1200 630", 텍스트 가독 우선, 차분한 톤, 외부 리소스/스크립트 없음.`,
    `출력은 오직 <svg>...</svg> 원본 마크업만. 코드펜스(\`\`\`)·설명·서론 금지.`,
  ].join('\n');

  // 바이너리별 헤드리스 인자: agy(Antigravity) vs gemini.
  const isAgy = /agy$/.test(DESIGN_BIN);
  const args = isAgy
    ? ['-p', prompt, '--dangerously-skip-permissions', '--print-timeout', `${Math.floor(GEMINI_TIMEOUT_MS / 1000)}s`]
    : ['-p', prompt, '-o', 'text'];

  let res;
  try {
    res = spawnSync(DESIGN_BIN, args, {
      encoding:  'utf8',
      timeout:   GEMINI_TIMEOUT_MS + 10_000, // CLI 자체 타임아웃보다 약간 길게
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    log.warn(`디자인 CLI(${DESIGN_BIN}) 실행 예외 → 폴백: ${e.message}`);
    return null;
  }

  if (res.error) { // ENOENT(미설치) 등
    log.warn(`디자인 CLI(${DESIGN_BIN}) 사용 불가 → 폴백: ${res.error.message}`);
    return null;
  }
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  // 인증 누락 등은 안내문구만 찍히고 SVG가 없음 → 아래 extractSVG가 null
  if (/set an Auth method|GEMINI_API_KEY|not trusted|IneligibleTier|not authenticated/i.test(out) && !/<svg/i.test(out)) {
    log.warn(`디자인 CLI(${DESIGN_BIN}) 미인증(SVG 없음) → mock 폴백`);
    return null;
  }
  const svg = extractSVG(res.stdout || out);
  if (!svg) { log.warn(`디자인 CLI(${DESIGN_BIN}) 출력에 유효 SVG 없음 → 폴백`); return null; }
  return svg;
}

// ─── 공개 API ────────────────────────────────────────────────────────────────

/**
 * designGemini(topic, draft, opts={}) → 후보객체 또는 null
 * @param {{ title?:string, id?:string }} topic
 * @param {{ title?:string, slug?:string }} draft
 * @returns {Promise<object|null>}
 */
export async function designGemini(topic, draft, opts = {}) {
  // degenerate 입력 보호 — throw 금지, null 반환
  const title = (topic && topic.title) || (draft && draft.title) || '';
  if (!title.trim()) return null;

  const slug      = resolveSlug(topic, draft);
  const imagesDir = paths.images;
  const filename  = `${slug}.gemini.svg`;
  const publicPath = `/images/${filename}`;

  try {
    mkdirSync(imagesDir, { recursive: true });
    const absPath = join(imagesDir, filename);

    // alt·brief는 mockImageRaster에서 결정론으로 생성(by:'gemini' 기준) — 실/모크 공통 사용.
    const base = mockImageRaster(topic, draft);

    // ── live: gemini CLI가 SVG 작성 (인증 시) ────────────────────────────
    // RUN_MODE와 독립적인 IMAGE_LIVE=1 로도 활성(COLLECT_LIVE 패턴) — mock 파이프라인에서
    // 실제 gemini CLI만 따로 검증 가능. CLI 인증/응답 실패 시 placeholder로 폴백.
    const useCli = !isMock() || env('IMAGE_LIVE') === '1';
    if (useCli) {
      const svg = runGeminiCliSVG(title);
      if (svg) {
        writeFileSync(absPath, svg, 'utf8');
        log.info(`Gemini CLI SVG 기록: ${absPath} (${Buffer.byteLength(svg, 'utf8')}B)`);
        return {
          by:     'gemini',
          format: 'svg',
          path:   absPath,
          alt:    base.alt,
          brief:  base.brief,
          svg,
          // mock:false → run-lion이 image 예산축에 charge(실제 Gemini 호출 소모).
          meta:   { w: 1200, h: 630, bytes: Buffer.byteLength(svg, 'utf8'), engine: DESIGN_ENGINE, public: publicPath },
        };
      }
      // SVG 못 받음 → 아래 placeholder 폴백
    }

    // ── mock 모드 / CLI 부재·미인증·실패: placeholder SVG ─────────────────
    writeFileSync(absPath, base.svg, 'utf8');
    log.info(`Gemini placeholder SVG 기록: ${absPath} (${base.meta.bytes}B)`);
    return {
      ...base,
      path: absPath,
      meta: { ...base.meta, public: publicPath },
    };
  } catch (err) {
    log.error('designGemini 실패 → null 반환', err);
    return null;
  }
}

// CLI 직접 실행 (디버그)
if (process.argv[1] && process.argv[1].endsWith('gemini-designer.mjs')) {
  const title = process.argv[2] || 'AI 자동화로 블로그 발행 파이프라인 만들기';
  designGemini({ title, id: 'cli' }, { title, slug: 'gemini-cli-test' })
    .then(c => console.log(JSON.stringify({ by: c?.by, format: c?.format, mock: c?.meta?.mock, engine: c?.meta?.engine, path: c?.path }, null, 2)));
}
