/**
 * lib/kboQuiz.ts — KBO 상식 퀴즈 문항.
 *
 * 🔴 문항 선정 원칙 하나: **시간이 지나도 답이 안 바뀌는 것만 낸다.**
 * "지금 1위 팀은?" 같은 문제는 다음 주면 틀린 답이 된다. 그래서 확정된 시즌 결과·규칙·구단
 * 정보만 쓴다. 2026 시즌은 진행 중이라 순위·성적을 문제로 쓰지 않았다.
 *
 * 사실 출처(2026-08 확인): 2025 한국시리즈 위키백과, 2026 KBO League season 위키백과, 언론 보도.
 * 확인한 것 — 2024 KIA 통합우승(V12, 삼성 상대 4승1패) / 2025 LG 통합우승(한화 상대 4승1패,
 * MVP 김현수) / 2026 규정(피치클락 무주자 18초·주자 23초, 아시아·호주 용병 1명 추가).
 */

/** 난이도 단계 — 뒤로 갈수록 어려워진다. 배열 순서가 곧 출제 순서다. */
export const LEVELS = ['kid', 'elem', 'mid', 'high'] as const;
export type Difficulty = (typeof LEVELS)[number];

/** 화면에 보일 단계 이름. 업무 위장 화면이라 '레벨' 대신 단계 표기를 쓴다. */
export const LEVEL_LABEL: Record<Difficulty, string> = {
  kid: '1단계', elem: '2단계', mid: '3단계', high: '4단계',
};

export interface QuizQuestion {
  id: string;
  /** 업무 위장 UI 에서 '작업 항목' 제목처럼 보이는 짧은 라벨. */
  label: string;
  question: string;
  choices: string[];
  /** `choices` 안의 정답 위치. */
  answer: number;
  explain: string;
  difficulty: Difficulty;
}

export const QUESTIONS: QuizQuestion[] = [
  // ── LG 트윈스 팬심 ──────────────────────────────────────────────────────
  { id: 'lg-color', label: '브랜드', question: 'LG 트윈스의 상징 색은?', choices: ['빨강', '파랑', '초록', '보라'], answer: 1, explain: '빨강과 검정도 쓰지만 대표색은 파랑 계열입니다.', difficulty: 'kid' },
  { id: 'lg-name', label: '브랜드', question: 'LG 트윈스에서 트윈스(Twins)는 무슨 뜻일까요?', choices: ['쌍둥이', '독수리', '거인', '별'], answer: 0, explain: '쌍둥이입니다. 엠블럼에도 쌍둥이가 들어갑니다.', difficulty: 'kid' },
  { id: 'lg-home', label: '경기장', question: 'LG 트윈스의 홈구장은?', choices: ['잠실야구장', '고척스카이돔', '사직구장', '문학경기장'], answer: 0, explain: '잠실야구장입니다(2026년 기준).', difficulty: 'kid' },
  { id: 'lg-rival', label: '라이벌', question: '잠실을 함께 쓰며 LG의 최대 라이벌로 꼽히는 팀은?', choices: ['두산 베어스', '키움 히어로즈', 'SSG 랜더스', 'NC 다이노스'], answer: 0, explain: '두산 베어스입니다. 같은 구장을 쓰는 잠실 라이벌입니다.', difficulty: 'elem' },
  { id: 'lg-2023', label: '이력', question: 'LG 트윈스가 29년 만에 한국시리즈 우승을 한 해는?', choices: ['2021년', '2022년', '2023년', '2024년'], answer: 2, explain: '2023년입니다. 1994년 이후 29년 만이었습니다.', difficulty: 'mid' },
  { id: 'lg-2025', label: '이력', question: 'LG 트윈스가 2025년 한국시리즈에서 꺾은 상대는?', choices: ['한화 이글스', 'KIA 타이거즈', '삼성 라이온즈', '두산 베어스'], answer: 0, explain: '한화 이글스를 4승 1패로 이겼습니다.', difficulty: 'mid' },
  { id: 'lg-titles', label: '이력', question: '2025년 우승으로 LG 트윈스는 통산 몇 번째 우승을 했을까요?', choices: ['2번째', '3번째', '4번째', '6번째'], answer: 2, explain: '통산 4번째 우승입니다(1990·1994·2023·2025).', difficulty: 'high' },
  { id: 'lg-first', label: '이력', question: 'LG 트윈스가 처음 한국시리즈 우승을 한 해는?', choices: ['1982년', '1990년', '1994년', '2002년'], answer: 1, explain: '1990년입니다. LG로 이름을 바꾼 첫해에 우승했습니다.', difficulty: 'high' },
  { id: 'e-innings', label: '기본 확인', question: '야구 한 경기는 몇 이닝일까요?', choices: ['3이닝', '9이닝', '15이닝', '20이닝'], answer: 1, explain: '9이닝입니다. 동점이면 연장으로 갑니다.', difficulty: 'kid' },
  { id: 'e-strike', label: '기본 확인', question: '스트라이크 몇 개면 아웃될까요?', choices: ['1개', '2개', '3개', '5개'], answer: 2, explain: '삼진, 즉 3개입니다.', difficulty: 'kid' },
  { id: 'e-ball', label: '기본 확인', question: '볼 몇 개면 1루로 걸어 나갈까요?', choices: ['2개', '3개', '4개', '6개'], answer: 2, explain: '4개면 볼넷으로 걸어 나갑니다.', difficulty: 'kid' },
  { id: 'e-players', label: '기본 확인', question: '한 팀이 수비할 때 그라운드에 몇 명이 나갈까요?', choices: ['7명', '9명', '11명', '5명'], answer: 1, explain: '9명입니다. 투수·포수·내야 4명·외야 3명.', difficulty: 'kid' },
  { id: 'e-grandslam', label: '기본 확인', question: '주자가 꽉 찬 상태(만루)에서 홈런을 치면 몇 점?', choices: ['1점', '2점', '3점', '4점'], answer: 3, explain: '주자 3명 + 본인 = 4점. 만루홈런이라고 합니다.', difficulty: 'kid' },
  { id: 'e-out3', label: '기본 확인', question: '한 팀의 공격은 아웃 몇 개로 끝날까요?', choices: ['1개', '2개', '3개', '4개'], answer: 2, explain: '3아웃이면 공수가 교대됩니다.', difficulty: 'kid' },
  { id: 'e-teams', label: '리그 구성', question: 'KBO 프로야구는 몇 개 팀이 있을까요?', choices: ['6개', '8개', '10개', '12개'], answer: 2, explain: '10개 구단입니다.', difficulty: 'elem' },
  { id: 'e-lg', label: '팀 이름', question: 'LG 트윈스의 연고지(홈)는 어디일까요?', choices: ['부산', '서울', '대구', '광주'], answer: 1, explain: '서울입니다.', difficulty: 'elem' },
  { id: 'e-lotte', label: '팀 이름', question: '롯데 자이언츠의 홈은 어디일까요?', choices: ['부산', '인천', '수원', '창원'], answer: 0, explain: '부산입니다. 사직구장 응원이 유명하죠.', difficulty: 'elem' },
  { id: 'e-samsung', label: '팀 이름', question: '삼성 라이온즈의 홈은 어디일까요?', choices: ['대전', '대구', '광주', '서울'], answer: 1, explain: '대구입니다.', difficulty: 'elem' },
  { id: 'e-kia', label: '팀 이름', question: 'KIA 타이거즈의 홈은 어디일까요?', choices: ['광주', '전주', '목포', '순천'], answer: 0, explain: '광주입니다.', difficulty: 'elem' },
  { id: 'e-hanwha', label: '팀 이름', question: '한화 이글스의 홈은 어디일까요?', choices: ['청주', '대전', '천안', '세종'], answer: 1, explain: '대전입니다.', difficulty: 'elem' },
  { id: 'e-doosan', label: '팀 이름', question: '두산 베어스의 마스코트 동물은?', choices: ['호랑이', '곰', '독수리', '사자'], answer: 1, explain: '베어스니까 곰입니다.', difficulty: 'elem' },
  { id: 'e-tigers', label: '팀 이름', question: 'KIA 타이거즈의 상징 동물은?', choices: ['호랑이', '사자', '곰', '거인'], answer: 0, explain: '타이거즈, 호랑이입니다.', difficulty: 'elem' },
  { id: 'e-lions', label: '팀 이름', question: '삼성 라이온즈의 상징 동물은?', choices: ['사자', '늑대', '독수리', '공룡'], answer: 0, explain: '라이온즈, 사자입니다.', difficulty: 'elem' },
  { id: 'e-eagles', label: '팀 이름', question: '한화 이글스의 상징 동물은?', choices: ['독수리', '비둘기', '갈매기', '부엉이'], answer: 0, explain: '이글스, 독수리입니다.', difficulty: 'elem' },
  { id: 'e-dinos', label: '팀 이름', question: 'NC 다이노스의 상징은?', choices: ['공룡', '고래', '상어', '용'], answer: 0, explain: '다이노스, 공룡입니다.', difficulty: 'elem' },
  { id: 'e-jamsil', label: '경기장', question: '서울에 있는 유명한 야구장 이름은?', choices: ['잠실야구장', '사직구장', '고척돔', '마산구장'], answer: 0, explain: '잠실야구장입니다.', difficulty: 'elem' },
  { id: 'e-jamsil-share', label: '경기장', question: '2026년까지 잠실야구장을 함께 홈으로 쓴 두 팀은?', choices: ['LG와 두산', 'LG와 롯데', '두산과 삼성', 'KIA와 한화'], answer: 0, explain: 'LG 트윈스와 두산 베어스입니다. 2027년부터는 잠실주경기장을 임시 홈으로 씁니다.', difficulty: 'elem' },
  { id: 'e-ks-name', label: '기본 확인', question: '프로야구에서 그해 최종 우승을 가리는 경기를 뭐라고 할까요?', choices: ['한국시리즈', '올스타전', '개막전', '시범경기'], answer: 0, explain: '한국시리즈입니다. 보통 10월에 열립니다.', difficulty: 'elem' },
  { id: 'e-autumn', label: '기본 확인', question: '가을에 상위 팀들이 벌이는 토너먼트를 뭐라고 부를까요?', choices: ['가을야구', '봄야구', '겨울리그', '여름컵'], answer: 0, explain: '가을야구(포스트시즌)라고 합니다.', difficulty: 'elem' },
  { id: 'e-safe', label: '기본 확인', question: '주자가 베이스에 살아서 도착하면 심판이 뭐라고 할까요?', choices: ['세이프', '아웃', '파울', '스트라이크'], answer: 0, explain: '세이프입니다. 반대는 아웃.', difficulty: 'kid' },
  { id: 'm-ks2025', label: '2025 결과', question: '2025년 한국시리즈 우승팀은?', choices: ['LG 트윈스', '한화 이글스', 'KIA 타이거즈', '삼성 라이온즈'], answer: 0, explain: 'LG 트윈스가 한화를 4승 1패로 꺾고 통합우승했습니다.', difficulty: 'mid' },
  { id: 'm-ks2024', label: '2024 결과', question: '2024년 한국시리즈 우승팀은?', choices: ['삼성 라이온즈', 'KIA 타이거즈', 'LG 트윈스', '두산 베어스'], answer: 1, explain: 'KIA 타이거즈가 삼성을 4승 1패로 꺾고 통산 12번째 우승을 했습니다.', difficulty: 'mid' },
  { id: 'm-games', label: '일정', question: '한 팀이 정규시즌에 치르는 경기 수는?', choices: ['100경기', '144경기', '162경기', '180경기'], answer: 1, explain: '144경기입니다.', difficulty: 'mid' },
  { id: 'm-cycle', label: '용어', question: '한 경기에서 단타·2루타·3루타·홈런을 다 치면?', choices: ['사이클링 히트', '그랜드슬램', '트리플 크라운', '퍼펙트게임'], answer: 0, explain: '사이클링 히트입니다. 한 시즌에 한두 번 나올까 말까 합니다.', difficulty: 'mid' },
  { id: 'm-perfect', label: '용어', question: '상대를 한 명도 출루시키지 않고 끝낸 경기는?', choices: ['노히트노런', '완봉승', '퍼펙트게임', '세이브'], answer: 2, explain: '퍼펙트게임입니다. 볼넷·몸에 맞는 공도 없어야 합니다.', difficulty: 'mid' },
  { id: 'm-nc', label: '팀 이름', question: 'NC 다이노스의 연고지는?', choices: ['창원', '울산', '포항', '전주'], answer: 0, explain: '창원입니다.', difficulty: 'mid' },
  { id: 'm-kt', label: '팀 이름', question: 'kt wiz의 연고지는?', choices: ['수원', '성남', '고양', '용인'], answer: 0, explain: '수원입니다. 2015년 합류로 10구단 체제가 됐습니다.', difficulty: 'mid' },
  { id: 'h-ks2025-mvp', label: '2025 인사', question: '2025년 한국시리즈 MVP를 받은 선수는?', choices: ['오스틴 딘', '김현수', '홍창기', '박해민'], answer: 1, explain: 'LG 외야수 김현수가 받았습니다.', difficulty: 'high' },
  { id: 'h-kia-unbeaten', label: '기록', question: 'KIA(해태 포함)가 한국시리즈에서 세운 기록은?', choices: ['12번 올라가 12번 다 우승', '10년 연속 진출', '3년 연속 준우승', '무득점 우승'], answer: 0, explain: '한국시리즈에 12번 올라가 한 번도 지지 않았습니다.', difficulty: 'high' },
  { id: 'h-pitchclock', label: '개정 규정', question: '2026시즌 피치클락, 주자가 없을 때 투수에게 주는 시간은?', choices: ['12초', '15초', '18초', '25초'], answer: 2, explain: '무주자 18초, 주자 있으면 23초입니다.', difficulty: 'high' },
  { id: 'h-import', label: '개정 규정', question: '2026시즌부터 아시아·호주 국적 선수를 몇 명 더 뽑을 수 있게 됐나요?', choices: ['1명', '2명', '3명', '제한 없음'], answer: 0, explain: '기존 외국인 선수와 별도로 1명 추가할 수 있습니다.', difficulty: 'high' },
  { id: 'h-position', label: '기록 표기', question: '수비 포지션 번호에서 1번은 누구일까요?', choices: ['포수', '투수', '1루수', '유격수'], answer: 1, explain: '투수가 1번, 포수가 2번입니다. 6-4-3 병살 표기가 여기서 나옵니다.', difficulty: 'high' },
  { id: 'h-sponsor', label: '계약', question: '2026시즌 KBO 리그 타이틀 스폰서는?', choices: ['신한은행', 'KB국민은행', '우리은행', '하나은행'], answer: 0, explain: '신한은행입니다.', difficulty: 'high' },
  { id: 'n-era', label: '기록 용어', question: '투수의 방어율(ERA)은 몇 이닝 기준으로 계산할까요?', choices: ['5이닝', '7이닝', '9이닝', '한 경기'], answer: 2, explain: '9이닝당 평균 자책점입니다.', difficulty: 'mid' },
  { id: 'n-save', label: '기록 용어', question: '이기고 있는 경기 마지막을 지켜 낸 투수에게 주는 기록은?', choices: ['승리', '세이브', '홀드', '완투'], answer: 1, explain: '세이브입니다. 그 앞을 막으면 홀드.', difficulty: 'mid' },
  { id: 'n-dh', label: '규칙', question: '투수 대신 타석에만 들어서는 선수를 뭐라고 할까요?', choices: ['지명타자', '대타', '대주자', '선발타자'], answer: 0, explain: '지명타자(DH)입니다.', difficulty: 'mid' },
  { id: 'n-double', label: '규칙', question: '한 번의 수비로 아웃 두 개를 잡는 것을 뭐라고 할까요?', choices: ['병살', '삼중살', '희생플라이', '견제사'], answer: 0, explain: '병살(더블플레이)입니다.', difficulty: 'mid' },
  { id: 'n-balk', label: '규칙', question: '투수가 주자를 속이는 반칙 동작을 하면?', choices: ['보크', '데드볼', '파울', '폭투'], answer: 0, explain: '보크입니다. 주자가 한 베이스 진루합니다.', difficulty: 'mid' },
  { id: 'n-ops', label: '기록 용어', question: 'OPS는 무엇을 더한 값일까요?', choices: ['출루율 + 장타율', '타율 + 홈런', '득점 + 타점', '안타 + 볼넷'], answer: 0, explain: '출루율과 장타율을 더한 값입니다.', difficulty: 'high' },
  { id: 'n-triple-crown', label: '기록 용어', question: '타자 트리플 크라운은 어떤 세 부문 1위일까요?', choices: ['타율·홈런·타점', '타율·도루·득점', '홈런·볼넷·출루율', '안타·2루타·타점'], answer: 0, explain: '타율·홈런·타점 세 부문 모두 1위입니다.', difficulty: 'high' },
  { id: 'n-postseason', label: '리그 운영', question: 'KBO 정규시즌에서 몇 위까지 가을야구에 나갈까요?', choices: ['3팀', '4팀', '5팀', '6팀'], answer: 2, explain: '5위까지 포스트시즌에 진출합니다.', difficulty: 'high' },
];

/** 등급 구간 — 맞힌 개수(비율) 기준. 위에서부터 처음 만족하는 구간을 쓴다. */
export const GRADES: { min: number; title: string; body: string }[] = [
  { min: 0.9, title: '구단 프런트급', body: '이 정도면 취미가 아니라 업무입니다. 야구 보는 시간을 근무시간으로 정산해야 할 수준.' },
  { min: 0.7, title: '시즌권 소지자', body: '중계 없으면 허전한 사람. 주변에서 야구 물어보는 사람이 한 명쯤 있을 겁니다.' },
  { min: 0.5, title: '가을야구만 챙김', body: '평소엔 잠잠하다가 포스트시즌에 갑자기 열심입니다. 가장 흔하고 가장 현명한 유형.' },
  { min: 0.3, title: '치킨 먹으러 감', body: '경기보다 응원가와 야식이 목적. 그것도 야구의 절반입니다.' },
  { min: 0, title: '중계를 틀어둔 사람', body: '소리만 켜두고 다른 일 하는 유형. 오늘부터 시작하면 됩니다.' },
];

export function gradeFor(correct: number, total: number): { title: string; body: string } {
  const ratio = total > 0 ? correct / total : 0;
  // 위에서부터 훑어 처음 만족하는 구간. min 이 내림차순이라는 전제를 깨지 않게 정렬해 둔다.
  const hit = GRADES.find(g => ratio >= g.min);
  return hit ?? GRADES[GRADES.length - 1];
}

/* ── 출제 순서 섞기 ─────────────────────────────────────────────────────── */

/**
 * 선택지를 섞은 문항.
 * ⚠ 선택지를 섞으면 원래 `answer` 인덱스가 무의미해진다. 섞은 뒤의 정답 위치를 다시 계산해
 *   담아야 하고, 이걸 화면 안에서 즉석으로 하면 실수가 조용히 숨는다 — 그래서 함수로 뺐다.
 */
export interface ShuffledQuestion extends QuizQuestion {
  /** 섞인 선택지. */
  shuffled: string[];
  /** `shuffled` 안의 정답 위치. */
  shuffledAnswer: number;
}

/** Fisher–Yates. `rand` 를 주입할 수 있어 테스트에서 순서를 고정할 수 있다. */
export function shuffle<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 한 문항의 선택지를 섞고 정답 위치를 다시 잡는다.
 *
 * ⚠ **문자열이 아니라 인덱스를 섞는다.** 처음엔 섞은 배열에서 정답 문자열을 `indexOf` 로 찾았는데,
 *   선택지에 같은 문자열이 두 개 있으면 첫 번째를 가리켜 정답이 조용히 어긋난다. 지금 데이터에는
 *   중복이 없고 테스트로도 막고 있지만, 그건 "지금은 안전"일 뿐이고 문항을 추가하는 사람이
 *   그 규칙을 알아야만 유지된다. 인덱스를 섞으면 위험 자체가 사라진다.
 */
export function shuffleChoices(q: QuizQuestion, rand: () => number = Math.random): ShuffledQuestion {
  const order = shuffle(q.choices.map((_, i) => i), rand);
  return {
    ...q,
    shuffled: order.map(i => q.choices[i]),
    shuffledAnswer: order.indexOf(q.answer),
  };
}

/**
 * 출제 세트 — **쉬운 단계부터 순서대로** 낸다.
 * 단계 안에서만 섞는다. 전체를 섞으면 첫 문항에 고딩 문제가 나와 "쉽게 시작"이 깨진다.
 */
export function buildQuiz(rand: () => number = Math.random, limit = QUESTIONS.length): ShuffledQuestion[] {
  const byLevel = LEVELS.flatMap(lv => shuffle(QUESTIONS.filter(q => q.difficulty === lv), rand));
  return byLevel.slice(0, limit).map(q => shuffleChoices(q, rand));
}
