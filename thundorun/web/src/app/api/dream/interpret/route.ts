import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

interface InterpretBody {
  dreamText: string;
  mood?: string;
}

interface DreamSymbol {
  name: string;
  meaning: string;
}

interface DreamPayload {
  verdict: '길몽' | '흉몽' | '평몽';
  verdictSummary: string;
  symbols: DreamSymbol[];
  luckyNumbers: number[];
  interpretation: string;
}

// 꿈 텍스트 기반 결정적 해시로 행운번호 생성 (1-45, 고유, 정확히 6개)
function pickLuckyNumbers(seedText: string, partial: number[]): number[] {
  const existing = new Set(partial.filter((n) => Number.isInteger(n) && n >= 1 && n <= 45));
  const result = Array.from(existing);

  let seed = 0;
  for (let i = 0; i < seedText.length; i++) {
    seed = (seed * 31 + seedText.charCodeAt(i)) & 0x7fffffff;
  }

  let cursor = seed;
  while (result.length < 6) {
    cursor = (cursor * 1664525 + 1013904223) & 0x7fffffff;
    const candidate = (cursor % 45) + 1;
    if (!existing.has(candidate)) {
      existing.add(candidate);
      result.push(candidate);
    }
  }

  return result.slice(0, 6);
}

// ── 50년 경력 해몽 전문가 페르소나 + 가독성 원칙 (system 프롬프트) ──
const SYSTEM_PROMPT = `당신은 50년 동안 꿈해몽 하나만 파고든 대가입니다. 수만 명의 꿈을 풀어온 노련한 해몽사로서, 꿈 하나를 보면 그 사람의 무의식과 현실의 결을 정확히 읽어냅니다.

[해석 원칙]
- 꿈에 등장하는 상징(인물·동물·사물·자연·감정)의 전통적 의미와 심리적 의미를 함께 짚는다.
- 두루뭉술 금지. 길흉의 근거를 꿈 속 상징에서 끌어온다.
- 노련하게, 그러나 솔직하게. 흉몽도 품위 있게 전하되 현실 조언을 반드시 붙인다.

[표현 규칙 — 가독성 최우선]
- 해몽 용어(오행·상징·기운 등)는 나올 때마다 괄호로 일상어 풀이를 붙인다.
- 짧은 문장, 짧은 문단. 한 문단은 3문장을 넘기지 않는다. 나열되는 내용은 불릿(-)으로 정리한다.
- 절대 늘려 쓰지 않는다. 같은 말 반복 금지. 핵심만 밀도 있게.

[출력 형식 — 반드시 순수 JSON만 출력, 코드펜스 없이]
{
  "verdict": "길몽" | "흉몽" | "평몽",
  "verdictSummary": "한 줄 요약",
  "symbols": [{"name": "뱀", "meaning": "변화와 재생의 기운..."}],
  "luckyNumbers": [6개 정수, 1-45, 고유],
  "interpretation": "🔮 한 줄 결론으로 시작, ### 꿈의 의미 / ### 길흉 풀이 / ### 현실 조언 섹션, 마지막 💡 정리"
}`;

// JSON.parse 실패(잘림 등) 시 부분 JSON 문자열에서 필드를 정규식으로 추출한다
function salvagePartialJson(cleaned: string, rawText: string): Partial<DreamPayload> {
  const pickString = (key: string): string | undefined => {
    const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`) as string; // 이스케이프(\n 등) 해제
    } catch {
      return m[1];
    }
  };

  const verdictRaw = pickString('verdict');
  const verdict = (['길몽', '흉몽', '평몽'] as const).find((v) => v === verdictRaw);

  const numbersMatch = cleaned.match(/"luckyNumbers"\s*:\s*\[([^\]]*)\]/);
  const luckyNumbers = numbersMatch
    ? numbersMatch[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n))
    : [];

  // interpretation까지 추출되면 그것을, 아니면 원문 전체를 보여준다
  const interpretation = pickString('interpretation') ?? rawText;

  return {
    verdict: verdict ?? '평몽',
    verdictSummary: pickString('verdictSummary') ?? '해몽을 불러왔습니다.',
    symbols: [],
    luckyNumbers,
    interpretation,
  };
}

function buildUserPrompt(dreamText: string, mood?: string): string {
  const moodLine = mood ? `\n꿈의 분위기: ${mood}` : '';
  return `꿈 내용: ${dreamText}${moodLine}

위 꿈을 해몽해주세요. 반드시 아래 JSON 형식만 출력하세요 (코드펜스·추가 텍스트 없이):
{
  "verdict": "길몽" | "흉몽" | "평몽",
  "verdictSummary": "한 줄 요약 (20자 이내)",
  "symbols": [{"name": "상징 이름", "meaning": "의미 설명 (1문장)"}],
  "luckyNumbers": [정수1, 정수2, 정수3, 정수4, 정수5, 정수6],
  "interpretation": "마크다운 전체 해몽 — 🔮 한 줄 결론으로 시작, ### 꿈의 의미 / ### 길흉 풀이 / ### 현실 조언 섹션, 마지막 💡 정리 불릿"
}

분량 제약 (JSON이 잘리지 않도록 반드시 지킬 것):
- symbols는 핵심 상징 최대 3개만
- interpretation은 전체 800자 이내로 밀도 있게`;
}

export async function POST(req: NextRequest) {
  let body: InterpretBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const { dreamText, mood } = body;

  if (!dreamText || !dreamText.trim()) {
    return NextResponse.json({ error: '꿈 내용을 입력해주세요.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let payload: DreamPayload;

  if (!apiKey) {
    payload = {
      verdict: '평몽',
      verdictSummary: 'API 키를 설정하면 해몽이 표시됩니다.',
      symbols: [],
      luckyNumbers: pickLuckyNumbers(dreamText, []),
      interpretation:
        '[Claude API 키를 설정하면 해몽이 표시됩니다]\n\n.env.local 에 ANTHROPIC_API_KEY 를 입력해주세요.',
    };
  } else {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(dreamText, mood) }],
      }),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Claude API 오류: ${res.status}` },
        { status: 502 },
      );
    }

    const data = await res.json();
    const rawText: string = data.content?.[0]?.text ?? '';

    // 코드펜스 제거 후 JSON 파싱
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let parsed: Partial<DreamPayload> = {};
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // 파싱 실패(예: 응답 잘림) — 부분 JSON에서 필드를 최대한 건져낸다
      parsed = salvagePartialJson(cleaned, rawText);
    }

    // luckyNumbers 정제: 1-45 정수·고유·정확히 6개
    const rawNumbers = Array.isArray(parsed.luckyNumbers) ? parsed.luckyNumbers : [];
    const validPartial = rawNumbers.filter(
      (n): n is number => Number.isInteger(n) && n >= 1 && n <= 45,
    );
    const uniquePartial = Array.from(new Set(validPartial));

    payload = {
      verdict: (['길몽', '흉몽', '평몽'] as const).includes(parsed.verdict as '길몽' | '흉몽' | '평몽')
        ? (parsed.verdict as '길몽' | '흉몽' | '평몽')
        : '평몽',
      verdictSummary: parsed.verdictSummary ?? '해몽 결과를 확인하세요.',
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols : [],
      luckyNumbers: pickLuckyNumbers(dreamText, uniquePartial),
      interpretation: parsed.interpretation ?? rawText,
    };
  }

  // Supabase 저장 (테이블 없을 수 있으므로 에러 무시)
  const db = getSupabase();
  if (db) {
    try {
      await db.from('dream_readings').insert({
        id,
        dream_text: dreamText,
        mood: mood ?? null,
        verdict: payload.verdict,
        lucky_numbers: payload.luckyNumbers,
        symbol_tags: payload.symbols.map((s) => s.name),
        result: payload.interpretation,
      });
    } catch (err) {
      console.log('[dream] Supabase insert skipped:', err);
    }
  }

  return NextResponse.json({ id, ...payload });
}
