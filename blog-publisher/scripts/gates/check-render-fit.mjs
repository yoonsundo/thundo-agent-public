#!/usr/bin/env node
/**
 * check-render-fit.mjs — 홈 형태 적합성 게이트 (발행물 렌더·이쁨)
 *
 * 발행 콘텐츠가 홈페이지(thundorun) HtmlView/prose-invert 가 그대로 렌더할 수 있는
 * 시맨틱 HTML 형태이고, 시각적 최소선(섹션 구성·문단 리듬)을 갖췄는지 결정론으로 판정한다.
 *
 * 입력: argv[2] = 발행 콘텐츠 경로
 *   - 이미 HTML(블록 태그 포함)이면 그대로 검사.
 *   - 마크다운(.md)이면 발행 변환과 동일하게(선두 H1 제거 후 mdToHtml) HTML 로 변환해 검사.
 * 출력: stdout JSON 1줄 (타 게이트 동일 계약 {gate,pass,reason,evidence})
 * exit: 0=적합 / 1=부적합 / 2=실행오류
 *
 * 판정 규칙(하나라도 위반 → fail):
 *   1) 허용 시맨틱 태그 외 태그 등장(<script>·<div>·<span>·h1·h5·h6 등) → 형태 이탈
 *   2) on* 이벤트 속성 등장 → DOMPurify 가 떨굴 위험 + 신뢰경계 위반
 *   3) 마크다운 누수(본문 텍스트에 리터럴 ##·**·- [ ]·]( 잔존) → 변환 실패 징후
 *   4) 구조적 이쁨 미달: h2<2(벽글) 또는 p<3(제목만) 또는 선두 H1(제목 재기술)
 *   5) 링크 href / 이미지 src 가 비어 있음 → 깨진 리치요소
 *
 * 근거(허용 태그): scripts/lib/md-to-html.mjs 출력 시맨틱 태그 +
 *   repo/thundorun/web/src/components/HtmlView.tsx (DOMPurify html 프로필 + prose-invert).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mdToHtml, isLikelyHtml } from '../lib/md-to-html.mjs';


import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
// ─── 허용 시맨틱 태그 (홈 prose-invert 가 렌더하는 집합) ──────────────────────────
const ALLOWED_TAGS = new Set([
  'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'a', 'img', 'figure', 'figcaption', 'strong', 'em', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
]);

// ─── 구조적 이쁨 최소선 ─────────────────────────────────────────────────────────
const MIN_H2 = 2; // 섹션 2개 이상 (벽글 아님)
const MIN_P = 3;  // 문단 3개 이상 (제목만 아님)

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * 입력을 발행 HTML 로 정규화.
 * HTML 이면 그대로, 마크다운이면 parsePublishedPost(hub/blog-db.mjs)와 동일하게
 * 선두 H1(제목 재기술)을 제거한 뒤 mdToHtml 로 변환한다.
 */
function toHtml(raw) {
  if (isLikelyHtml(raw)) return { html: raw, source: 'html' };
  const body = stripFrontmatter(raw).trim().replace(/^#\s+.+\r?\n+/, '');
  return { html: mdToHtml(body), source: 'markdown' };
}

/** 태그·코드 제거 후 순수 텍스트 — 마크다운 누수 스캔용(코드블록 내 리터럴 마커 오탐 방지). */
function textForLeakage(html) {
  let t = html.replace(/<pre[\s\S]*?<\/pre>/gi, ' '); // 코드블록 제거
  t = t.replace(/<code[\s\S]*?<\/code>/gi, ' ');       // 인라인 코드 제거
  t = t.replace(/<[^>]+>/g, ' ');                       // 잔여 태그 제거
  return t;
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────

function analyze(html) {
  const failures = [];
  const disallowed = new Set();
  const onAttrTags = new Set();
  let hasScript = false;
  const counts = {};

  // 1) 태그 스캔 (여는 태그만 카운트)
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (tag === 'script') hasScript = true;
    if (!ALLOWED_TAGS.has(tag)) disallowed.add(tag);
    if (/\son[a-zA-Z]+\s*=/.test(attrs)) onAttrTags.add(tag);
    if (!closing) counts[tag] = (counts[tag] || 0) + 1;
  }

  const h2Count = counts.h2 || 0;
  const pCount = counts.p || 0;

  // 2) 허용 외 태그 / script / on*
  if (hasScript) failures.push('<script> 태그 — 발행물에 스크립트 금지');
  if (disallowed.size > 0) {
    failures.push(`허용 외 태그: ${[...disallowed].sort().join(', ')} (h1/h5/h6·div·span 등 형태 이탈)`);
  }
  if (onAttrTags.size > 0) {
    failures.push(`on* 이벤트 속성: ${[...onAttrTags].sort().join(', ')} 태그 — 신뢰경계 위반`);
  }

  // 3) 마크다운 누수
  const text = textForLeakage(html);
  const leaks = [];
  if (/(^|\n)\s*#{1,6}\s+\S/.test(text)) leaks.push('## 헤딩');
  if (/\*\*/.test(text)) leaks.push('** 볼드');
  if (/-\s\[[ xX]\]/.test(text)) leaks.push('- [ ] 체크박스');
  if (/\]\(/.test(text)) leaks.push('](  링크');
  if (leaks.length > 0) {
    failures.push(`마크다운 누수(변환 실패): ${leaks.join(', ')} 리터럴 잔존`);
  }

  // 4) 구조적 이쁨 최소선
  if (h2Count < MIN_H2) failures.push(`섹션 부족: h2 ${h2Count}개 (최소 ${MIN_H2}) — 벽글/제목만`);
  if (pCount < MIN_P) failures.push(`문단 부족: p ${pCount}개 (최소 ${MIN_P}) — 제목만/얇은 본문`);
  if ((counts.h1 || 0) > 0) failures.push('선두 H1(제목 재기술) 존재 — 홈은 title 컬럼을 별도 렌더');

  // 5) 빈 링크/이미지 src
  let emptyLink = 0;
  let emptyImg = 0;
  for (const a of html.matchAll(/<a\b([^>]*)>/gi)) {
    const href = a[1].match(/\shref\s*=\s*["']([^"']*)["']/i);
    if (!href || !href[1].trim()) emptyLink++;
  }
  for (const img of html.matchAll(/<img\b([^>]*)>/gi)) {
    const src = img[1].match(/\ssrc\s*=\s*["']([^"']*)["']/i);
    if (!src || !src[1].trim()) emptyImg++;
  }
  if (emptyLink > 0) failures.push(`빈 링크 href ${emptyLink}건 — 깨진 리치요소`);
  if (emptyImg > 0) failures.push(`빈 이미지 src ${emptyImg}건 — 깨진 리치요소`);

  const pass = failures.length === 0;
  const reason = pass
    ? `홈 형태 적합: h2 ${h2Count}·p ${pCount}, 허용 태그만, 마크다운 누수 없음`
    : `홈 형태 부적합: ${failures.join(' / ')}`;

  return {
    gate: 'render-fit',
    pass,
    reason,
    evidence: {
      h2_count: h2Count,
      p_count: pCount,
      disallowed_tags: [...disallowed].sort(),
      has_script: hasScript,
      on_attr_tags: [...onAttrTags].sort(),
      markdown_leaks: leaks,
      empty_link_href: emptyLink,
      empty_img_src: emptyImg,
    },
  };
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────
export function evaluate(draftPath) {
  const filePath = draftPath;

  let raw;
  try {
    raw = readFileSync(resolve(filePath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
  }

  const { html, source } = toHtml(raw);
  if (!html || !html.trim()) {
    return {
      gate: 'render-fit',
      pass: false,
      reason: '렌더 콘텐츠가 비어 있음(변환 결과 없음)',
      evidence: { source, h2_count: 0, p_count: 0 },
    };
  }

  const result = analyze(html);
  result.evidence.source = source;

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'render-fit',
    evaluate,
    usage: 'Usage: check-render-fit.mjs <published.html|draft.md>',
  });
}