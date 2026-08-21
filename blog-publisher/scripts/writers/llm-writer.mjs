// llm-writer.mjs — 실 LLM(Anthropic API) 작가. mock-llm 의 mockDraft 를 대체한다.
// stdlib only (global fetch). 작가 페르소나(beaver/fox/wolf) + 니치 + 게이트 제약을
// 시스템 프롬프트로 녹여, 13종 결정론 게이트를 통과하는 한국어 초안을 생성한다.
import { readFileSync } from 'node:fs';
import { claudeText } from '../lib/claude-cli.mjs';

// 작가별 글 유형
const PERSONAS = {
  beaver: { type: 'how-to', desc: '단계별 실습 가이드(준비물→단계1,2,3→흔한 실수→마무리)' },
  fox:    { type: 'review', desc: 'AI 도구/서비스 비교·리뷰(비교 기준→도구별 장단점→상황별 추천→결론)' },
  wolf:   { type: 'opinion', desc: '관점·주장 중심 오피니언(주장→근거·경험→반론 인정→입장 정리)' },
};

// 게이트 통과를 위한 공통 제약(실제로 게이트13 전수통과를 만들어낸 규칙)
const RULES = `
[게이트 통과 필수 규칙 — 전부 지켜야 발행됨]
1. length: 본문 한글 음절(가~힣, 공백·영문 제외) 1500~2000개. 섹션 4~6개.
2. banned/ai-tells: 금칙어 금지 — "결론적으로","시사하는 바가 크다","혁신적/획기적","~에 있어서","것으로 보인다". 이중조사(-에서의/-으로의) 금지. 같은 종결어미(~습니다/~해요) 3문장 연속 금지 — 섞어라. 문장 길이 혼합(짧은8~15·중간20~30·긴35~50음절).
3. credibility/density: 1인칭 실사용 경험 + 구체 수치/결과 필수(예: "하루 40분이 3분으로","월 20달러","2시간 걸렸다"). 추상 일반론 금지. 구체문장 비율 높게.
4. hedge: 헤징("~인 것 같다/아마") 남발 금지(35%미만). 단정적이되 과장 금지.
5. niche: 문단마다 니치 키워드(AI/자동화/생산성/에이전트/LLM/워크플로우/도구) 포함 — 주제이탈 금지.
6. sources: source_refs 는 텍스트 제목만(URL/빈url 금지). 본문에 URL 링크 절대 금지.
7. empty/internal-dup: 빈 섹션 금지. 섹션끼리 같은 내용 재진술 금지(각 섹션 다른 단계/관점).
8. lint/render-fit: 깔끔한 마크다운(## 헤딩 2개 이상, - 리스트, 문단 3개 이상). HTML/script 금지.
톤: 친근한 존댓말(~해요/~합니다 혼용), 전문적이되 쉬움. 실제 해본 사람처럼.`;

function buildPrompt({ writer, niche, avoidTitles, dateId, feedback }) {
  const p = PERSONAS[writer] || PERSONAS.beaver;
  const avoid = avoidTitles.length ? `\n[이미 발행됨 — 주제/슬러그 겹치지 마라]\n- ${avoidTitles.join('\n- ')}` : '';
  const fb = feedback ? `\n[직전 시도가 게이트에서 실패했다. 반드시 고쳐라]\n${feedback}` : '';
  return `너는 ${writer} — ${p.type} 한국어 블로그 작가다. 니치 "${niche.name}"의 ${p.type} 글을 실제로 작성하라.
구조: ${p.desc}
독자: ${niche.audience}
${RULES}
${avoid}${fb}

[출력 형식 — 정확히 이 마크다운만 출력. 설명·코드펜스 금지]
---
id: "${dateId}-${writer}"
topic_id: "<주제-슬러그>"
outline_id: "<주제>-outline"
writer: "${writer}"
slug: "<영문-소문자-하이픈 슬러그>"
title: "<핵심키워드 + 구체 가치/숫자, 낚시 금지>"
char_count: <한글음절수 추정>
status: "draft"
attempt: 0
source_refs:
  - type: "official_doc"
    title: "<출처 기관/문서명 — URL 금지>"
  - type: "blog"
    title: "<출처2>"
tags: ["<태그>", "<태그>", "자동화", "생산성"]
---

# <제목>

<본문 — 위 규칙 전부 준수, 1500~2000 한글 음절, 1인칭 경험·구체수치>`;
}

/**
 * 실 LLM 으로 초안 마크다운 생성.
 * @returns {Promise<string>} 초안 마크다운(frontmatter+본문)
 */
export async function writeDraft({ writer, niche, avoidTitles = [], dateId, feedback = '', model = 'claude-sonnet-4-6' }) {
  const prompt = buildPrompt({ writer, niche, avoidTitles, dateId, feedback });
  // 구독(Claude Code) claude -p 로 생성 — API 종량제 대체. 도구 없음(순수 생성).
  const text = (await claudeText({ prompt, model })).trim();
  // 코드펜스로 감싸 나오면 벗긴다
  return text.replace(/^```(?:markdown|md)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

export function loadNiche(path = 'config/niche.json') {
  return JSON.parse(readFileSync(path, 'utf8'));
}
