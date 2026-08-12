#!/usr/bin/env node
/**
 * check-ai-tells.mjs — 한국어 AI-티 탐지 게이트
 * 입력: argv[2] = 초안 .md 절대경로
 * 출력: stdout JSON 1줄
 * exit: 0=통과 / 1=실패 / 2=실행오류
 *
 * 판정 규칙:
 *   - S1 표현 1건 이상 → fail
 *   - S2급 신호 2종 이상 → fail
 *   - 그 외 → pass
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── S1: 결정적 AI 신호 표현 ────────────────────────────────────────────────
// 1회만 나와도 강한 AI 신호. 정규식 패턴.
const S1_PATTERNS = [
  // 결론 관용구
  { label: '결론적으로', re: /결론적으로/g },
  // 과장 평가
  { label: '시사하는 바가 크다', re: /시사하는\s*바가\s*크다/g },
  { label: '주목할 만하다', re: /주목할\s*만하다/g },
  // 과다 완곡 종결 (단독 문장 종결 패턴, 3회 이상 등장 시 S1)
  // 여기서는 개별 hit 카운트로 처리 — 아래 별도 로직
  // 혁신/획기적 과용 (2회 이상)
  { label: '혁신적', re: /혁신적/g, threshold: 2 },
  { label: '획기적', re: /획기적/g, threshold: 2 },
  { label: '전례 없는', re: /전례\s*없는/g, threshold: 2 },
  // ~에 있어서 (AI 특유 격식체, 3회 이상)
  { label: '~에 있어서', re: /에\s*있어서/g, threshold: 3 },
  // 것으로 보인다 (다중 완곡, 3회 이상)
  { label: '것으로 보인다', re: /것으로\s*보인다/g, threshold: 3 },
  // ~라 할 수 있다 (과다 사용, 3회 이상)
  { label: '~라 할 수 있다', re: /[이]?라\s*할\s*수\s*있다/g, threshold: 3 },
  // 번역체: ~을 통하여 (영어 "through/via" 직역, 3회 이상)
  { label: '~을 통하여', re: /을\s*통하여|를\s*통하여/g, threshold: 3 },
  // 번역체: 되어지 (이중피동, 1회부터 신호)
  { label: '되어지', re: /되어지/g, threshold: 1 },
  // 번역체: 그것은 [가-힣] (영어 대명사 "It is..." 직역, 3회 이상)
  { label: '그것은(대명사직역)', re: /그것은\s+[가-힣]/g, threshold: 3 },
];

// ─── S2: 통계적 AI 신호 ─────────────────────────────────────────────────────

// 문두 접속사 과다: 문장 시작에 빈번히 등장하는 접속사
const LEAD_CONJ_PATTERNS = [
  /^또한[\s,]/,
  /^따라서[\s,]/,
  /^즉[\s,]/,
  /^나아가[\s,]/,
  /^그러므로[\s,]/,
  /^이처럼[\s,]/,
  /^이와\s*같이[\s,]/,
];

// 이중조사 패턴
const DOUBLE_JOSA_PATTERNS = [
  { label: '에서의', re: /에서의/g },
  { label: '에로의', re: /에로의/g },
  { label: '으로의', re: /으로의/g },
  { label: '로의', re: /(?<![으])로의/g },
  { label: '에의', re: /에의/g },
];

// ─── 유틸 ────────────────────────────────────────────────────────────────────

/** YAML frontmatter 제거 후 본문 반환 */
function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return m ? m[1] : text;
}

/** 코드블록·인라인코드 제거 (분석 오염 방지) */
function stripCode(text) {
  let t = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '');
  t = t.replace(/`[^`\n]+`/g, '');
  return t;
}

/**
 * 텍스트를 한국어 문장 단위로 분리.
 * '.', '!', '?', '。' 뒤 공백/줄바꿈 기준. 빈 문장 제거.
 */
function splitSentences(text) {
  // 문장 구분자: 마침표계열 + 후속 공백/줄바꿈
  const raw = text.split(/(?<=[.!?。])\s+/);
  return raw.map(s => s.trim()).filter(s => s.length > 5);
}

/**
 * 한글 음절만 카운트 (문장 길이 측정용)
 */
function koreanLen(s) {
  return [...s].filter(c => c >= '가' && c <= '힣').length;
}

/**
 * 표준편차 계산
 */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * 종결어미 추출 (문장 끝 2~4글자)
 * 한글 종결 패턴: 습니다/입니다/었어요/요/다/죠/네/군요 등
 */
function extractEnding(sentence) {
  const s = sentence.trim().replace(/[.!?。\s]+$/, '');
  if (s.length < 2) return null;
  // 끝 3글자 반환 (종결어미 비교)
  return s.slice(-3);
}

/**
 * 연속 3문장+ 같은 종결어미 반복 체크
 * returns { monotone: boolean, max_run: number, ending: string|null }
 */
function checkEndingMonotony(sentences) {
  if (sentences.length < 3) return { monotone: false, max_run: 0, ending: null };

  let maxRun = 1;
  let maxEnding = null;
  let curRun = 1;
  let curEnding = extractEnding(sentences[0]);

  for (let i = 1; i < sentences.length; i++) {
    const e = extractEnding(sentences[i]);
    if (e && e === curEnding) {
      curRun++;
      if (curRun > maxRun) {
        maxRun = curRun;
        maxEnding = curEnding;
      }
    } else {
      curRun = 1;
      curEnding = e;
    }
  }

  // 임계: 연속 4문장+ (3문장은 자연스러운 나열에서도 가능)
  return { monotone: maxRun >= 4, max_run: maxRun, ending: maxEnding };
}

/**
 * 문장 길이(한글음절) 표준편차 체크
 * 낮을수록 AI 신호. 임계 <10 (보수적 — 짧은 글도 통과 허용)
 */
function checkSentLenStdev(sentences) {
  const lens = sentences.map(koreanLen).filter(l => l > 0);
  if (lens.length < 5) return { too_uniform: false, stdev: 99 };
  const sd = stddev(lens);
  // 임계 <10: 보수적으로 설정 (정상 블로그도 짧은 글은 균일할 수 있음)
  return { too_uniform: sd < 10, stdev: Math.round(sd * 10) / 10 };
}

/**
 * 쉼표율 체크: 쉼표 수 / 전체 한글+영문 문자 수
 * >12% 이면 AI 신호 (보수적 임계, 원래 10%에서 상향)
 */
function checkCommaRatio(body) {
  const commas = (body.match(/,|，/g) || []).length;
  const chars = [...body].filter(c =>
    (c >= '가' && c <= '힣') ||
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z')
  ).length;
  if (chars < 50) return { high: false, ratio: 0 };
  const ratio = commas / chars;
  return { high: ratio > 0.12, ratio: Math.round(ratio * 1000) / 10 };
}

/**
 * 이중조사 탐지
 */
function checkDoubleJosa(body) {
  const hits = [];
  for (const { label, re } of DOUBLE_JOSA_PATTERNS) {
    re.lastIndex = 0;
    const matches = [...body.matchAll(re)];
    if (matches.length > 0) {
      hits.push({ label, count: matches.length });
    }
  }
  // 이중조사 3건+ 이면 신호 (1~2건은 문어체 글에서 정상)
  return { excessive: hits.length >= 3 || hits.reduce((s, h) => s + h.count, 0) >= 4, hits };
}

/**
 * 문두 접속사 빈도 체크
 */
function checkLeadConj(sentences) {
  let count = 0;
  for (const s of sentences) {
    for (const re of LEAD_CONJ_PATTERNS) {
      if (re.test(s)) { count++; break; }
    }
  }
  // 전체 문장의 25%+ 이면 AI 신호 (보수적, 원래 20%에서 상향)
  const ratio = sentences.length > 0 ? count / sentences.length : 0;
  return { excessive: ratio > 0.25, count, ratio: Math.round(ratio * 100) };
}

/**
 * 키워드 스터핑 탐지: 단일 한글 명사구(2~6음절)의 최고 출현빈도 / 전체 어절수 비율
 * 임계: 5% 초과 → S2 신호
 * 캘리브레이션: good-01~22 최대 3.53%(슬라이드), bad-04 17.21%(자동화)
 */
function checkKeywordStuffing(body) {
  // 코드블록·인라인코드 이미 제거된 body 사용
  // 한글 2~6음절 토큰만 추출 (조사 포함 어절 분리)
  const cleaned = body.replace(/[^가-힣\s]/g, ' ');
  const tokens = cleaned.split(/\s+/).filter(w => w.length >= 2 && w.length <= 6);
  const total = tokens.length;
  if (total < 30) return { stuffed: false, ratio: 0, top_token: null };

  const freq = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;

  let maxCount = 0;
  let topToken = null;
  for (const [t, c] of Object.entries(freq)) {
    if (c > maxCount) { maxCount = c; topToken = t; }
  }

  const ratio = maxCount / total;
  // 임계 5% (0.05): good 최대 3.53%, bad-04 17.21%
  return { stuffed: ratio > 0.05, ratio: Math.round(ratio * 1000) / 10, top_token: topToken, top_count: maxCount, total_tokens: total };
}

/**
 * 불릿 연속 실행 체크: 5개+ 연속 불릿
 */
function checkBulletRuns(body) {
  const lines = body.split('\n');
  let maxRun = 0;
  let curRun = 0;
  const runs = [];

  for (const line of lines) {
    if (/^\s*[-*•]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      curRun++;
      if (curRun > maxRun) maxRun = curRun;
    } else {
      if (curRun >= 5) runs.push(curRun);
      curRun = 0;
    }
  }
  if (curRun >= 5) runs.push(curRun);

  return { excessive: runs.length > 0, max_run: maxRun, long_runs: runs };
}

// ─── 메인 분석 ───────────────────────────────────────────────────────────────

function analyze(body) {
  const cleaned = stripCode(body);
  const sentences = splitSentences(cleaned);

  // S1 체크
  const s1_hits = [];
  for (const { label, re, threshold = 1 } of S1_PATTERNS) {
    re.lastIndex = 0;
    const matches = [...cleaned.matchAll(re)];
    if (matches.length >= threshold) {
      s1_hits.push({ label, count: matches.length, threshold });
    }
  }

  // S2 체크
  const endingResult    = checkEndingMonotony(sentences);
  const sentLenResult   = checkSentLenStdev(sentences);
  const commaResult     = checkCommaRatio(cleaned);
  const josaResult      = checkDoubleJosa(cleaned);
  const conjResult      = checkLeadConj(sentences);
  const bulletResult    = checkBulletRuns(body); // 원문(코드블록 포함 가능)
  const stuffingResult  = checkKeywordStuffing(cleaned);

  // S2 신호 집계
  const s2_signals = [
    endingResult.monotone,   // 종결어미 단조
    sentLenResult.too_uniform, // 문장길이 균일
    commaResult.high,         // 쉼표율 초과
    josaResult.excessive,     // 이중조사 과다
    conjResult.excessive,     // 문두접속사 과다
    bulletResult.excessive,   // 불릿 과다
    stuffingResult.stuffed,   // 키워드 스터핑
  ];
  const s2_count = s2_signals.filter(Boolean).length;

  // 판정
  const fail_s1 = s1_hits.length > 0;
  const fail_s2 = s2_count >= 2;
  const pass = !fail_s1 && !fail_s2;

  // 점수 (참고용: S1=각 2점, S2=각 1점)
  const score = s1_hits.length * 2 + s2_count;

  let reason;
  if (fail_s1) {
    reason = `S1 표현 ${s1_hits.length}건: ${s1_hits.map(h => h.label).join(', ')}`;
  } else if (fail_s2) {
    const active = [];
    if (endingResult.monotone) active.push(`종결어미단조(${endingResult.max_run}연속)`);
    if (sentLenResult.too_uniform) active.push(`문장길이균일(σ=${sentLenResult.stdev})`);
    if (commaResult.high) active.push(`쉼표율${commaResult.ratio}%`);
    if (josaResult.excessive) active.push(`이중조사${josaResult.hits.length}종`);
    if (conjResult.excessive) active.push(`문두접속사${conjResult.count}건`);
    if (bulletResult.excessive) active.push(`불릿연속${bulletResult.max_run}개`);
    if (stuffingResult.stuffed) active.push(`키워드스터핑(${stuffingResult.top_token}:${stuffingResult.ratio}%)`);
    reason = `S2 신호 ${s2_count}종 동시 감지: ${active.join(', ')}`;
  } else {
    reason = 'AI-티 신호 없음';
  }

  return {
    gate: 'ai-tells',
    pass,
    reason,
    evidence: {
      s1_hits,
      ending_monotony: { ...endingResult },
      sentlen_stdev: sentLenResult.stdev,
      sentlen_too_uniform: sentLenResult.too_uniform,
      comma_ratio: commaResult.ratio,
      comma_high: commaResult.high,
      double_josa: josaResult.hits,
      double_josa_excessive: josaResult.excessive,
      lead_conj_count: conjResult.count,
      lead_conj_ratio_pct: conjResult.ratio,
      lead_conj_excessive: conjResult.excessive,
      bullet_runs: bulletResult.long_runs,
      bullet_excessive: bulletResult.excessive,
      keyword_stuffing: stuffingResult,
      s2_active_count: s2_count,
      score,
    },
  };
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

function main() {
  const draftPath = process.argv[2];
  if (!draftPath) {
    process.stderr.write('Usage: check-ai-tells.mjs <draft.md>\n');
    process.exit(2);
  }

  let raw;
  try {
    raw = readFileSync(resolve(draftPath), 'utf8');
  } catch (e) {
    process.stderr.write(`check-ai-tells: 파일 읽기 실패: ${e.message}\n`);
    process.exit(2);
  }

  const body = stripFrontmatter(raw);
  const result = analyze(body);

  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.pass ? 0 : 1);
}

main();
