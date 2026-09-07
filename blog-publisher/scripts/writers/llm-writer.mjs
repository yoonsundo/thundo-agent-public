// llm-writer.mjs — 실 LLM(Anthropic API) 작가. mock-llm 의 mockDraft 를 대체한다.
// stdlib only (global fetch). 작가 페르소나(beaver/fox/wolf) + 니치 + 게이트 제약을
// 시스템 프롬프트로 녹여, 결정론 게이트를 통과하는 한국어 초안을 생성한다.
//
// 2026-09-07 — RULES 3번을 갈아엎었다. 원래는 "1인칭 실사용 경험 + 구체 수치 필수" 였다.
// 작가의 도구는 Read·Write 뿐이라 실행도 측정도 못 하는데, 그 규칙이 **없는 실행을 지어내라고
// 지시하고 있었다** — 발행물 203편 중 111편에 조작된 실행 주장이 남았다.
// 그렇다고 규칙을 지우기만 하면 density·credibility 게이트가 요구하는 구체성이 사라져 얕은
// 일반론으로 흐른다(그 게이트들이 생긴 이유가 그것이다). 그래서 "구체성의 출처"만 바꿨다 —
// 1인칭 실행 → 출처 귀속 수치·조건부 비교·문서에 적힌 절차. 게이트17(firsthand)이 최종 방어선.
import { readFileSync } from 'node:fs';
import { claudeText } from '../lib/claude-cli.mjs';

// 작가별 글 유형
const PERSONAS = {
  beaver: { type: 'how-to', desc: '단계별 실습 가이드(준비물→단계1,2,3→흔한 실수→마무리)' },
  fox:    { type: 'review', desc: 'AI 도구/서비스 비교·리뷰(비교 기준→도구별 장단점→상황별 추천→결론)' },
  wolf:   { type: 'opinion', desc: '관점·주장 중심 오피니언(주장→근거·논증→반론 인정→입장 정리)' },  // 경험 X — 실행 못 하는 작가에게 경험을 요구하면 지어낸다
};

// 게이트 통과를 위한 공통 제약(실제로 게이트13 전수통과를 만들어낸 규칙)
const RULES = `
[게이트 통과 필수 규칙 — 전부 지켜야 발행됨]
1. length: 본문 한글 음절(가~힣, 공백·영문 제외) 1500~2000개. 섹션 4~6개.
2. banned/ai-tells: 금칙어 금지 — "결론적으로","시사하는 바가 크다","혁신적/획기적","~에 있어서","것으로 보인다". 이중조사(-에서의/-으로의) 금지. 같은 종결어미(~습니다/~해요) 3문장 연속 금지 — 섞어라. 문장 길이 혼합(짧은8~15·중간20~30·긴35~50음절).
3. credibility/density/firsthand: 구체 수치 필수 — 단, **출처에 귀속시켜라**. 너는 도구를 실행할 수 없다(Read·Write 뿐). 실행·측정·소유를 주장하면 게이트17 firsthand 가 즉시 차단한다.
   금지: "제가 직접 돌려봤더니 48초", "제 노트북에서 20분", "측정해보니", "실측한 결과", "3개월 써본 결과", "제 환경은 우분투 22.04"
   대체: ①출처 귀속 — "공식 문서 기준 48초", "릴리스 노트에 따르면 컨텍스트 200K", "요금 페이지 기준 월 20달러"
        ②조건부 비교 — "파일 10개 이상이면 A가 유리하고, 단일 파일이면 B가 낫다" 처럼 갈림길과 기준선을 수치로 제시
        ③문서에 적힌 절차·값 — "재시도 대기를 10000ms 로 두면 1초→2초→4초로 늘어난다"
        ④독자 검증 유도 — "직접 재보세요"(권유는 허용, 본인이 쟀다는 주장만 금지)
   의견·판단은 자유다("제가 보기엔", "저는 ~라고 봅니다"). 막는 것은 **하지 않은 일을 했다고 쓰는 것**뿐이다.
4. hedge: 헤징("~인 것 같다/아마") 남발 금지(35%미만). 단정적이되 과장 금지.
5. niche: 문단마다 니치 키워드(AI/자동화/생산성/에이전트/LLM/워크플로우/도구) 포함 — 주제이탈 금지.
6. sources: source_refs 는 텍스트 제목만(URL/빈url 금지). 본문에 URL 링크 절대 금지.
7. empty/internal-dup: 빈 섹션 금지. 섹션끼리 같은 내용 재진술 금지(각 섹션 다른 단계/관점).
8. lint/render-fit: 깔끔한 마크다운(## 헤딩 2개 이상, - 리스트, 문단 3개 이상). HTML/script 금지.
톤: 친근한 존댓말(~해요/~합니다 혼용), 전문적이되 쉬움. **문서를 꼼꼼히 읽은 분석가처럼** — 해보지도 않은 일을 해본 척하지 마라.`;

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

<본문 — 위 규칙 전부 준수, 1500~2000 한글 음절, 출처 귀속 구체수치·조건부 비교. 1인칭 실행/측정 주장 금지>`;
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
