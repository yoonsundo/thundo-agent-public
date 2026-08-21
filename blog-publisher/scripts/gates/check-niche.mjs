#!/usr/bin/env node
/**
 * check-niche.mjs — 니치 적합성 게이트
 *
 * 본문을 문단(paragraph) 단위로 분리한 뒤, 각 문단에 니치 키워드(AI·자동화·LLM 등)
 * 포함 여부를 확인한다. 니치 키워드 포함 문단의 어절 수를 전체 어절 수로 나눈
 * niche_keyword_ratio가 임계 미만이면 주제이탈(오프토픽 패딩)로 판정해 FAIL.
 *
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   niche_keyword_ratio < NICHE_THRESHOLD → fail (주제이탈)
 *   그 외 → pass
 *
 * 캘리브레이션 (good-01~30 전수 + bad-11):
 *   - good-26 (니치 비율 최저 양품): niche_keyword_ratio=0.5554 → pass
 *   - bad-11 (오프토픽 패딩): niche_keyword_ratio=0.3213 → fail
 *   - 임계 good_min × 0.7 = 0.5554 × 0.7 ≈ 0.3888 → 0.40
 *     good 전수(min=0.5554) 통과, bad-11(0.3213) 확실한 FAIL
 *
 * niche_keyword_ratio 계산:
 *   1. 본문을 빈 줄 기준 문단으로 분리 (코드 블록 → [CODE] 치환 후)
 *   2. 각 문단에 니치 키워드(부분매칭) 포함 여부 판정
 *   3. ratio = (니치 키워드 포함 문단의 어절 합) / (전체 어절 합)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


import { runGateCli, GateError } from './lib/gate-cli.mjs';
import { isMainModule } from '../lib/main-module.mjs';
// ─── 임계값 ────────────────────────────────────────────────────────────────────

/** niche_keyword_ratio 임계. 이 미만이면 주제이탈 판정. */
const NICHE_THRESHOLD = 0.40;

// ─── 니치 키워드 목록 ────────────────────────────────────────────────────────
// config/niche.json 카테고리 기반: AI·자동화·LLM·워크플로우·생산성·에이전트·
// 도구·프롬프트·챗봇 등 + 부분매칭 적용

const NICHE_KEYWORDS = [
  'AI', 'LLM', '자동화', '워크플로우', '생산성', '에이전트', '프롬프트',
  '챗봇', '도구', '툴', '모델', '언어모델', '머신러닝', '딥러닝',
  'ChatGPT', 'GPT', 'Claude', 'Gemini', 'Copilot', 'Zapier', 'Make', 'Notion',
  '노션', '자피어', '코딩', '코드', '개발', '파이프라인', '인공지능',
  '자동', '봇', '스크립트', '플로우', '통합', '연동', '크롤링', '수집',
  '분류', '요약', '번역', '생성', 'API', 'webhook', '웹훅',
  '노코드', '로우코드', '어시스턴트', '업무', '효율', '최적화',
  '음성', '이미지', '검색', 'RAG', '파인튜닝', '임베딩',
  // AI 코딩 도구 니치 확장 (US-003)
  'claude code', 'cursor', 'windsurf', 'ai 코딩', '코딩 에이전트',
  'ai coding', 'llm 코딩', 'vibe coding', '바이브 코딩',
  'mcp', '코딩 자동화', 'ai 코드리뷰',
  // AI 퀀트·트레이딩 니치 확장 (2026-07-02, owl v3 도메인 전환 — config/niche.json categories 병존)
  '퀀트', '트레이딩', '백테스트', '백테스팅', '매매', '주식', '증권',
  '알고리즘 트레이딩', '매매 알고리즘', '전략', '시계열', '포트폴리오', '수익률', '리스크', '지표',
  '차트', '시그널', '팩터', '슬리피지', '과최적화', '강화학습',
  'backtrader', 'freqtrade', 'ccxt', 'zipline', 'quantconnect', 'finrl', 'qlib',
  '키움', '한국투자증권', 'kis', 'krx', '호가', '체결',
];

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/**
 * 코드 블록을 [CODE] 플레이스홀더로 치환.
 * 코드 내 비니치 어절이 전체 어절 수를 부풀려 오탐을 유발하지 않도록.
 */
function replaceCodeBlocks(text) {
  let t = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '[CODE]');
  t = t.replace(/`[^`\n]+`/g, '[INLINE]');
  return t;
}

/** 어절(whitespace/구두점 구분 토큰) 목록 반환 */
function splitWords(text) {
  return text
    .split(/[\s\n\r,。.!?:;()\[\]"'""''—–\-\/\\|`#*>]+/)
    .filter(w => w.length > 0);
}

/** 문단에 니치 키워드 포함 여부 (부분매칭) */
function hasNicheKeyword(paragraph) {
  const lower = paragraph.toLowerCase();
  return NICHE_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// ─── 분석 ─────────────────────────────────────────────────────────────────────

function analyze(body) {
  const cleaned = replaceCodeBlocks(body);

  // 빈 줄 기준 문단 분리, 10자 미만 제거
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length >= 10);

  if (paragraphs.length === 0) {
    return {
      gate: 'niche',
      pass: false,
      reason: '문단을 추출할 수 없음',
      evidence: { niche_keyword_ratio: 0, total_words: 0, niche_words: 0 },
    };
  }

  let totalWords = 0;
  let nicheWords = 0;

  for (const para of paragraphs) {
    const words = splitWords(para);
    totalWords += words.length;
    if (hasNicheKeyword(para)) {
      nicheWords += words.length;
    }
  }

  const ratio = totalWords === 0 ? 0 : nicheWords / totalWords;
  const ratioRounded = parseFloat(ratio.toFixed(4));

  const pass = ratio >= NICHE_THRESHOLD;

  let reason;
  if (pass) {
    reason = `니치 적합: 키워드 포함 문단 어절 비율 ${Math.round(ratio * 100)}% ≥ 임계 ${Math.round(NICHE_THRESHOLD * 100)}%`;
  } else {
    reason = `주제 이탈: 니치 키워드 포함 문단 어절 비율 ${Math.round(ratio * 100)}% (임계 ${Math.round(NICHE_THRESHOLD * 100)}% 미달) — 오프토픽 패딩 의심`;
  }

  return {
    gate: 'niche',
    pass,
    reason,
    evidence: {
      niche_keyword_ratio: ratioRounded,
      total_words: totalWords,
      niche_words: nicheWords,
      threshold: NICHE_THRESHOLD,
    },
  };
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

export function evaluate(draftPath) {

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    throw new GateError(`파일 읽기 실패: ${e.message}`, { cause: e });
  }

  const body = stripFrontmatter(raw);
  const result = analyze(body);

  return result;
}

// CLI 로 직접 실행될 때만 돈다. 가드가 없으면 run-all-gates 가 import 하는 순간
// 이 게이트가 stdout 을 쓰고 process.exit 해 버린다(2026-08-21 실측).
if (isMainModule(import.meta.url)) {
  await runGateCli({
    gate: 'niche',
    evaluate,
    usage: 'Usage: check-niche.mjs <draft.md>',
  });
}