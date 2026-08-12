import { NextRequest, NextResponse } from 'next/server';
import {
  calculateSaju,
  calculateDaewoon,
  getTenGod,
  getYearGanji,
  STEMS,
  STEMS_HANJA,
  BRANCH_HIDDEN_STEMS,
  type Pillar,
} from '@/lib/manseryeok';
import { getSupabase } from '@/lib/supabase';

interface PartnerInfo {
  name: string;
  birthDate: string;
  birthTime?: string;
  gender?: string;
}

interface ReadBody {
  name: string;
  birthDate: string;
  birthTime?: string;
  gender?: string;
  fortuneTypes: string[];
  partner?: PartnerInfo;
}

export async function POST(req: NextRequest) {
  let body: ReadBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '요청 형식이 올바르지 않습니다.' }, { status: 400 });
  }

  const { name, birthDate, birthTime, gender, fortuneTypes, partner } = body;
  if (!name || !birthDate || !Array.isArray(fortuneTypes) || fortuneTypes.length === 0) {
    return NextResponse.json({ error: '필수 입력값이 누락됐습니다.' }, { status: 400 });
  }

  // 성별은 대운(10년 운) 방향 계산에 필수
  if (gender !== 'male' && gender !== 'female') {
    return NextResponse.json({ error: '성별을 선택해주세요. (대운 계산에 필요합니다)' }, { status: 400 });
  }

  if (fortuneTypes.includes('궁합') && !partner?.name) {
    return NextResponse.json({ error: '궁합 분석을 위해 상대방 정보를 입력해주세요.' }, { status: 400 });
  }

  const pillars = calculateSaju(birthDate, birthTime);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const interpretations = await Promise.all(
    fortuneTypes.map(async (type) => {
      const text = apiKey
        ? await getClaudeInterpretation({ name, birthDate, birthTime, gender, pillars, type, partner })
        : `[Claude API 키를 설정하면 ${type} 해석이 표시됩니다]\n\n.env.local 에 ANTHROPIC_API_KEY 를 입력해주세요.`;
      return { type, text };
    })
  );

  const id = crypto.randomUUID();

  const db = getSupabase();
  if (db) {
    await db.from('saju_readings').insert({
      id,
      name,
      birth_date:    birthDate,
      birth_time:    birthTime ?? null,
      gender:        gender ?? null,
      fortune_types: fortuneTypes,
      saju_pillars:  pillars,
      result:        interpretations.map((i) => `## ${i.type}\n\n${i.text}`).join('\n\n---\n\n'),
    });
  }

  return NextResponse.json({ id, pillars, interpretations });
}

function buildSajuSummary(pillars: ReturnType<typeof calculateSaju>): string {
  return [
    `년주: ${pillars.year.stemHanja}${pillars.year.branchHanja}(${pillars.year.stem}${pillars.year.branch})`,
    `월주: ${pillars.month.stemHanja}${pillars.month.branchHanja}(${pillars.month.stem}${pillars.month.branch})`,
    `일주: ${pillars.day.stemHanja}${pillars.day.branchHanja}(${pillars.day.stem}${pillars.day.branch})`,
    pillars.hour
      ? `시주: ${pillars.hour.stemHanja}${pillars.hour.branchHanja}(${pillars.hour.stem}${pillars.hour.branch})`
      : '시주: 미입력',
  ].join(', ');
}

// ── 50년 경력 대가 페르소나 + 전역 규칙 (system 프롬프트) ──────────────
const SYSTEM_PROMPT = `당신은 50년 동안 사주명리학 하나만 파고든 대가입니다. 수만 명의 사주를 직접 짚어온 노련한 명리학자로서, 원국을 보면 그 사람의 결을 정확히 읽어냅니다.

[해석 원칙]
- 사용자가 "이번에 선택한 운 하나"에만 집중한다. 다른 주제로 절대 새지 않는다. (연애운을 물었으면 연애 이야기만)
- 모든 판단의 근거를 일간(日干, 사주의 주인공인 나 자신)과 오행(목·화·토·금·수)의 균형, 십성(十星)에서 짚어준다. "왜 그런지"를 사주에서 끌어온다.
- 입력의 [십성]·[대운]·[세운] 블록은 만세력 코드로 계산된 정확한 값이다. 나이·연도·시기를 말할 때는 **반드시 이 계산값만** 근거로 쓰고, 절대 임의의 대운수·연도를 지어내지 않는다.
- 두루뭉술 금지. 구체적인 나이·연도·시기·상황을 명시한다.
- 노련하게, 그러나 솔직하게. 약점·주의점도 분명히 짚되 품위 있게 전한다.

[표현 규칙 — 가독성 최우선]
- 명리학 용어(천간·지지·오행·십성·신살 등)는 나올 때마다 바로 괄호로 일상어 풀이를 붙인다. 예: "편재(사업·투자처럼 들어오는 큰 돈)".
- 한자는 한글로 풀어 설명한다.
- 짧은 문장, 짧은 문단. 한 문단은 3문장을 넘기지 않는다. 나열되는 내용은 불릿(-)으로 정리한다.
- 절대 늘려 쓰지 않는다. 같은 말 반복 금지. 핵심만 밀도 있게 — 분량보다 정확함과 가독성이 우선이다.

[출력 형식 — 반드시 이 골격을 지킨다]
1) 맨 위 한 줄: "**🔮 한 줄 결론:** <사주 용어 없이, 핵심을 한 문장으로>"
2) 그다음: 아래에 지정된 섹션만 "### 제목" 으로 작성한다. 섹션을 추가하거나 생략하지 않는다.
3) 맨 아래 한 블록: "**💡 정리**" 제목 아래, 바로 실천할 조언 2~3개를 불릿으로.`;

// ── 운별 전용 명세: 그 운에 "딱 맞는" 섹션만 정의 ───────────────────
// {y}=기준연도, {y1}=내년, {y3}=3년뒤, {today}=오늘 날짜 로 치환된다.
const TYPE_SPEC: Record<string, { focus: string; sections: string[] }> = {
  '원국': {
    focus: '타고난 기질과 그릇 — 이 사람이 본래 어떤 사람인가',
    sections: ['타고난 성정과 기질', '살려야 할 강점', '주의할 약점·기질', '인생 전반의 큰 줄기'],
  },
  '대운': {
    focus: '10년 단위로 흐르는 큰 운의 방향',
    sections: ['지금 흐르고 있는 대운', '앞으로의 대운 전환점 (나이대별)', '가장 빛나는 시기와 조심할 시기'],
  },
  '세운': {
    focus: `해마다 바뀌는 한 해 운세 (${'{y}'}년 중심)`,
    sections: ['올해({y}년) 전체 흐름', '상반기 vs 하반기 포인트', '향후 전망 ({y1}~{y3}년 핵심만)'],
  },
  '월운': {
    focus: '이번 달의 운 흐름',
    sections: ['이번 달 전반 기운', '시기별(초·중·말) 포인트', '이번 달 조심할 점'],
  },
  '연애운': {
    focus: '연애·이성 인연과 본인의 연애 성향 (연애에만 집중)',
    sections: ['타고난 연애 성향', `지금의 이성운 흐름 (${'{y}'}년 중심)`, '잘 맞는 인연의 결 / 피해야 할 패턴', '좋은 만남이 오는 시기'],
  },
  '결혼운': {
    focus: '배우자 인연과 결혼 (결혼에만 집중)',
    sections: ['배우자 인연의 결', '결혼 적기 (나이·시기 구체적으로)', '결혼 후 부부 기운과 주의점'],
  },
  '재물운': {
    focus: '돈을 모으고 쓰는 기운 (재물에만 집중)',
    sections: ['타고난 재물 그릇', `돈이 들고 나는 흐름 (${'{y}'}년 중심)`, '재물이 트이는 시기 / 손재 조심할 시기', '돈 관리 핵심 조언'],
  },
  '취업운': {
    focus: '직업 적성과 취업·이직 (커리어에만 집중)',
    sections: ['잘 맞는 직업·직군의 결', '취업·이직에 유리한 시기', '커리어에서 살릴 강점 / 보완할 약점'],
  },
  '사업운': {
    focus: '사업·창업 적합성 (사업에만 집중)',
    sections: ['사업가 기질이 있는가', '창업·확장에 유리한 시기 / 리스크 시기', '맞는 업종의 결과 동업 여부'],
  },
  '건강운': {
    focus: '오행 균형으로 본 건강 (건강에만 집중)',
    sections: ['오행 불균형으로 약한 장부·부위', '건강을 특히 조심할 시기', '체질에 맞는 건강 관리 조언'],
  },
  '학업운': {
    focus: '공부·시험 운 (학업에만 집중)',
    sections: ['공부·집중력의 결', '시험·합격에 유리한 시기', '잘 맞는 공부 방향'],
  },
  '가족운': {
    focus: '가족 관계의 기운 (가족에만 집중)',
    sections: ['부모·형제 인연의 결', '자녀운', '가정 안에서 조심할 점'],
  },
  '이사운': {
    focus: '이동·이사의 길흉 (이사에만 집중)',
    sections: [`이동·이사 흐름 (${'{y}'}년 중심)`, '유리한 시기와 방위', '이사할 때 주의할 점'],
  },
  '오늘운세': {
    focus: '오늘 하루의 운세 ({today})',
    sections: ['오늘({today}) 전반의 기운', '오늘 잘 풀릴 일 / 조심할 일', '오늘의 행동 팁 (시간대·방향 등)'],
  },
};

function buildElementProfile(pillars: ReturnType<typeof calculateSaju>): string {
  const order = ['목', '화', '토', '금', '수'] as const;
  const cells = [
    pillars.year.stemElement, pillars.year.branchElement,
    pillars.month.stemElement, pillars.month.branchElement,
    pillars.day.stemElement, pillars.day.branchElement,
    ...(pillars.hour ? [pillars.hour.stemElement, pillars.hour.branchElement] : []),
  ];
  const counts = order.map((el) => `${el} ${cells.filter((c) => c === el).length}`);
  const missing = order.filter((el) => !cells.includes(el));
  const ilgan = `${pillars.day.stem}(${pillars.day.stemHanja}) — 오행 ${pillars.day.stemElement}`;
  return [
    `일간(나 자신): ${ilgan}`,
    `오행 분포: ${counts.join(', ')}`,
    missing.length ? `부족한 기운: ${missing.join('·')}` : '오행이 비교적 고르게 갖춰짐',
  ].join('\n');
}

type SajuPillars = ReturnType<typeof calculateSaju>;

// 지지 한 자리: 본기(주된 기운)의 십성 + 지장간 나열
function describeBranch(dayStemIdx: number, p: Pillar): string {
  const hidden = BRANCH_HIDDEN_STEMS[p.branchIdx];
  const main = hidden[hidden.length - 1];
  const hiddenNames = hidden.map((i) => STEMS[i]).join('·');
  return `${p.branch}(${p.branchHanja}) 본기 ${STEMS[main]}(${STEMS_HANJA[main]}) → ${getTenGod(dayStemIdx, main)} [지장간: ${hiddenNames}]`;
}

// 여덟 글자 전체의 십성 — 일간 기준 코드 계산값
function buildTenGodProfile(pillars: SajuPillars): string {
  const d = pillars.day.stemIdx;
  const stemLine = (label: string, p: Pillar) =>
    `${label} ${p.stem}(${p.stemHanja}) → ${getTenGod(d, p.stemIdx)}`;
  return [
    `${stemLine('년간', pillars.year)} / 년지 ${describeBranch(d, pillars.year)}`,
    `${stemLine('월간', pillars.month)} / 월지 ${describeBranch(d, pillars.month)}`,
    `일간(나 자신) ${pillars.day.stem}(${pillars.day.stemHanja}) / 일지 ${describeBranch(d, pillars.day)}`,
    pillars.hour
      ? `${stemLine('시간', pillars.hour)} / 시지 ${describeBranch(d, pillars.hour)}`
      : '시주: 미입력',
  ].join('\n');
}

// 대운 리스트 — 시작 나이·연도·간지·천간 십성
function buildDaewoonProfile(birthDate: string, gender: 'male' | 'female', dayStemIdx: number): string {
  const { direction, daewoonSu, list } = calculateDaewoon(birthDate, gender);
  const rows = list.map(
    (dw) =>
      `- ${dw.startAge}세(${dw.startYear}년)부터 10년: ${dw.stem}${dw.branch}(${dw.stemHanja}${dw.branchHanja}) 대운 — 천간 십성 ${getTenGod(dayStemIdx, dw.stemIdx)}`,
  );
  return [`방향 ${direction} · 대운수 ${daewoonSu} (첫 대운이 들어오는 나이, ±1년 오차 가능)`, ...rows].join('\n');
}

// 세운 리스트 — 연도별 간지·천간 십성
function buildSeunProfile(dayStemIdx: number, fromYear: number, years: number): string {
  return Array.from({ length: years }, (_, i) => {
    const yy = fromYear + i;
    const g = getYearGanji(yy);
    return `- ${yy}년: ${g.name}(${g.hanja})년 — 천간 십성 ${getTenGod(dayStemIdx, g.stemIdx)}`;
  }).join('\n');
}

function buildPrompt(params: {
  name: string;
  birthDate: string;
  birthTime?: string;
  gender: 'male' | 'female';
  pillars: SajuPillars;
  type: string;
  partner?: PartnerInfo;
}): string {
  const { name, birthDate, birthTime, gender, pillars, type, partner } = params;
  const sajuSummary = buildSajuSummary(pillars);
  const elementProfile = buildElementProfile(pillars);
  const genderStr = gender === 'male' ? '남성' : '여성';
  const timeStr = birthTime ? ` ${birthTime}` : '';
  const now = new Date();
  const y = now.getFullYear();
  const today = `${y}년 ${now.getMonth() + 1}월 ${now.getDate()}일`;
  const fill = (s: string) =>
    s.replaceAll('{y}', String(y)).replaceAll('{y1}', String(y + 1))
     .replaceAll('{y3}', String(y + 3)).replaceAll('{today}', today);

  const dayStemIdx = pillars.day.stemIdx;
  const tenGodProfile = buildTenGodProfile(pillars);
  const daewoonProfile = buildDaewoonProfile(birthDate, gender, dayStemIdx);
  const seunProfile = buildSeunProfile(dayStemIdx, y, 5);

  if (type === '궁합') {
    const partnerPillars = partner ? calculateSaju(partner.birthDate, partner.birthTime) : null;
    const partnerSajuSummary = partnerPillars ? buildSajuSummary(partnerPillars) : '정보 없음';
    const partnerProfile = partnerPillars ? buildElementProfile(partnerPillars) : '정보 없음';
    const partnerTenGod = partnerPillars ? buildTenGodProfile(partnerPillars) : '정보 없음';
    const partnerGender = partner?.gender ? (partner.gender === 'male' ? '남성' : '여성') : '';

    return `이번에 볼 운: **궁합** — 두 사람의 사주를 비교해 관계의 결만 본다.

[나 — ${name}]
이름: ${name} (${genderStr}) / 생년월일: ${birthDate}${timeStr}
사주: ${sajuSummary}
${elementProfile}
[십성 — 코드로 계산된 값]
${tenGodProfile}

[상대방 — ${partner?.name}]
이름: ${partner?.name}${partnerGender ? ` (${partnerGender})` : ''} / 생년월일: ${partner?.birthDate}${partner?.birthTime ? ` ${partner.birthTime}` : ''}
사주: ${partnerSajuSummary}
${partnerProfile}
[십성 — 코드로 계산된 값]
${partnerTenGod}

[세운 — 코드로 계산된 값 (${y}년부터 5년)]
${seunProfile}

아래 섹션만, 지정된 순서대로 "### 제목"으로 작성한다:
- 궁합 총평 (두 사람 오행의 상생·상극과 한 줄 점수)
- 두 사람의 역할 (누가 이끌고 누가 받쳐주는가)
- 잘 맞는 부분 (시너지)
- 솔직하게 안 맞는 부분 (반드시 주의할 갈등 지점)
- 함께 좋은 시기 (위 [세운] 계산값 근거로, 구체적 연도)
- 조심할 시기 (갈등·이별 위기가 올 수 있는 시기·나이)`;
  }

  const spec = TYPE_SPEC[type];
  const focus = spec ? fill(spec.focus) : `${type}`;
  const sectionList = spec
    ? spec.sections.map((s) => `- ${fill(s)}`).join('\n')
    : `- ${type} 핵심 분석\n- 유리한 시기와 조심할 시기`;

  return `이번에 볼 운: **${type}** — ${focus}
(이 운 하나에만 집중한다. 다른 운 이야기로 새지 않는다.)

[대상]
이름: ${name} (${genderStr})
생년월일: ${birthDate}${timeStr}
기준일: ${today}

[사주 원국]
${sajuSummary}
${elementProfile}

[십성 — 코드로 계산된 값]
${tenGodProfile}

[대운 — 코드로 계산된 값]
${daewoonProfile}

[세운 — 코드로 계산된 값 (${y}년부터 5년)]
${seunProfile}

아래 섹션만, 지정된 순서대로 "### 제목"으로 작성한다 (추가·생략 금지):
${sectionList}`;
}

async function getClaudeInterpretation(params: {
  name: string;
  birthDate: string;
  birthTime?: string;
  gender: 'male' | 'female';
  pillars: SajuPillars;
  type: string;
  partner?: PartnerInfo;
}): Promise<string> {
  const { type } = params;
  const prompt = buildPrompt(params);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: type === '궁합' ? 2600 : 1800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API 오류: ${res.status}`);

  const data = await res.json();
  return data.content?.[0]?.text ?? '해석을 가져올 수 없습니다.';
}
