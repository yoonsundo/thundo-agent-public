import { NextRequest, NextResponse } from 'next/server';
import { TAROT_DECK, TAROT_POSITIONS } from '@/lib/tarotDeck';
import { getSupabase } from '@/lib/supabase';

interface CardInput {
  id: number;
  nameKo: string;
  reversed: boolean;
}

interface InterpretBody {
  topic: string;
  cards: CardInput[];
}

// ── 노련한 타로 마스터 페르소나 + 전역 규칙 ──────────────────────────────
const SYSTEM_PROMPT = `당신은 30년 경력의 노련한 타로 마스터입니다. 수천 번의 리딩 경험으로 카드의 에너지를 깊이 읽어내는 전문가로서, 상징과 직관을 결합해 삶의 실질적인 통찰을 전합니다.

[해석 원칙]
- 질문자가 선택한 주제 하나에만 집중한다. 다른 영역으로 절대 새지 않는다.
- 각 카드의 정방향/역방향 의미를 주제의 맥락과 연결해 해석한다. "왜 이 카드가 나왔는지"를 설명한다.
- 카드 위치(현재 상황 / 조언 / 흐름·전망)의 역할을 명확히 반영한다.
- 두루뭉술 금지. 구체적인 상황·행동·시기를 제시한다.
- 솔직하게, 그러나 건설적으로. 어려운 카드가 나와도 성장의 관점으로 전한다.

[표현 규칙 — 가독성 최우선]
- 타로 용어는 나올 때마다 바로 괄호로 일상어 풀이를 붙인다. 예: "역방향(카드가 거꾸로 뽑힌 상태, 에너지가 내향적으로 작용함)".
- 짧은 문장, 짧은 문단. 한 문단은 3문장을 넘기지 않는다. 나열되는 내용은 불릿(-)으로 정리한다.
- 절대 늘려 쓰지 않는다. 같은 말 반복 금지. 핵심만 밀도 있게.

[출력 형식 — 반드시 이 골격을 지킨다]
1) 맨 위 한 줄: "**🔮 한 줄 결론:** <타로 용어 없이, 핵심을 한 문장으로>"
2) 그다음 3개 섹션 (카드 이름은 실제 뽑힌 카드로 대체):
   ### 현재 상황 — <카드명>
   ### 조언 — <카드명>
   ### 흐름·전망 — <카드명>
3) 맨 아래: "**💡 정리**" 제목 아래, 바로 실천할 조언 2~3개를 불릿으로.`;

function buildPrompt(topic: string, cards: CardInput[]): string {
  const cardDescriptions = cards.map((cardInput, idx) => {
    const fullCard = TAROT_DECK.find((c) => c.id === cardInput.id);
    const direction = cardInput.reversed ? '역방향' : '정방향';
    const meaning = cardInput.reversed ? fullCard?.reversed : fullCard?.upright;
    const keywords = fullCard?.keywords.join(', ') ?? '';
    return `${idx + 1}번 카드 (${TAROT_POSITIONS[idx]}): ${cardInput.nameKo} [${direction}]
  - 키워드: ${keywords}
  - ${direction} 의미: ${meaning}`;
  }).join('\n\n');

  return `이번 리딩 주제: **${topic}**
(이 주제 하나에만 집중한다. 다른 영역 이야기로 새지 않는다.)

[뽑힌 카드]
${cardDescriptions}

위 3장의 카드를 주제(${topic}) 맥락으로 해석해주세요.
각 카드의 위치 역할(현재 상황 / 조언 / 흐름·전망)을 반드시 반영해야 합니다.`;
}

export async function POST(req: NextRequest) {
  let body: InterpretBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const { topic, cards } = body;

  if (!topic || typeof topic !== 'string' || topic.trim() === '') {
    return NextResponse.json({ error: '주제를 선택해주세요.' }, { status: 400 });
  }

  if (!Array.isArray(cards) || cards.length !== 3) {
    return NextResponse.json({ error: '카드 3장을 선택해야 합니다.' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const id = crypto.randomUUID();

  let interpretation: string;

  if (!apiKey) {
    interpretation = `[Claude API 키를 설정하면 타로 해석이 표시됩니다]\n\n.env.local 에 ANTHROPIC_API_KEY 를 입력해주세요.\n\n뽑힌 카드: ${cards.map((c) => `${c.nameKo}(${c.reversed ? '역방향' : '정방향'})`).join(', ')}`;
  } else {
    const prompt = buildPrompt(topic, cards);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Claude API 오류: ${res.status}` },
        { status: 500 }
      );
    }

    const data = await res.json();
    interpretation = data.content?.[0]?.text ?? '해석을 가져올 수 없습니다.';
  }

  // Supabase 저장 — 테이블 미생성 가능성 있으므로 에러 무시
  const db = getSupabase();
  if (db) {
    try {
      await db.from('tarot_readings').insert({
        id,
        topic,
        cards,
        result: interpretation,
      });
    } catch (err) {
      console.log('[tarot] supabase insert skipped:', err);
    }
  }

  return NextResponse.json({ id, interpretation });
}
