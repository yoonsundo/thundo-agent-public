// 만세력(萬歲曆) 계산 엔진 — 생년월일시 → 사주 사柱

export const STEMS = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'] as const;
export const STEMS_HANJA = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'] as const;
export const BRANCHES = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'] as const;
export const BRANCHES_HANJA = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'] as const;

// 지지별 오행
export const BRANCH_ELEMENTS = ['수', '토', '목', '목', '토', '화', '화', '토', '금', '금', '토', '수'] as const;
// 천간별 오행
export const STEM_ELEMENTS = ['목', '목', '화', '화', '토', '토', '금', '금', '수', '수'] as const;

export interface Pillar {
  stem: string;
  branch: string;
  stemHanja: string;
  branchHanja: string;
  stemElement: string;
  branchElement: string;
  stemIdx: number;   // 천간 인덱스 (십성·대운 계산용)
  branchIdx: number; // 지지 인덱스 (지장간 계산용)
}

export interface SajuResult {
  year: Pillar;
  month: Pillar;
  day: Pillar;
  hour: Pillar | null;
}

// 절기 근사 날짜 — [양력 월, 양력 일, 지지 인덱스]
// 해당 날짜부터 그 월지(月支)가 시작됨
const JEOLGI: [number, number, number][] = [
  [1,  6,  1],  // 소한(小寒)  → 축월(丑月)
  [2,  4,  2],  // 입춘(立春)  → 인월(寅月)
  [3,  6,  3],  // 경칩(驚蟄)  → 묘월(卯月)
  [4,  5,  4],  // 청명(淸明)  → 진월(辰月)
  [5,  6,  5],  // 입하(立夏)  → 사월(巳月)
  [6,  6,  6],  // 망종(芒種)  → 오월(午月)
  [7,  7,  7],  // 소서(小暑)  → 미월(未月)
  [8,  8,  8],  // 입추(立秋)  → 신월(申月)
  [9,  8,  9],  // 백로(白露)  → 유월(酉月)
  [10, 8,  10], // 한로(寒露)  → 술월(戌月)
  [11, 7,  11], // 입동(立冬)  → 해월(亥月)
  [12, 7,  0],  // 대설(大雪)  → 자월(子月)
];

function makePillar(stemIdx: number, branchIdx: number): Pillar {
  return {
    stem: STEMS[stemIdx],
    branch: BRANCHES[branchIdx],
    stemHanja: STEMS_HANJA[stemIdx],
    branchHanja: BRANCHES_HANJA[branchIdx],
    stemElement: STEM_ELEMENTS[stemIdx],
    branchElement: BRANCH_ELEMENTS[branchIdx],
    stemIdx,
    branchIdx,
  };
}

function getMonthBranchIdx(month: number, day: number): number {
  // 뒤에서부터 스캔 → 현재 날짜 이하인 가장 마지막 절기
  for (let i = JEOLGI.length - 1; i >= 0; i--) {
    const [m, d, branchIdx] = JEOLGI[i];
    if (month > m || (month === m && day >= d)) return branchIdx;
  }
  return 0; // 소한 전 1/1~1/5 → 자월(子月)
}

function getJDN(year: number, month: number, day: number): number {
  // 율리우스 일수 계산 (Date.UTC 기반)
  const msPerDay = 86_400_000;
  const daysFromUnixEpoch = Math.floor(Date.UTC(year, month - 1, day) / msPerDay);
  return daysFromUnixEpoch + 2_440_588; // Unix epoch(1970-01-01)의 JDN
}

export function calculateSaju(birthDate: string, birthTime?: string): SajuResult {
  const [y, m, d] = birthDate.split('-').map(Number);

  // ── 년주(年柱) ───────────────────────────────────
  // 입춘(2월 4일) 전이면 전년도 사용
  const sajuYear = m < 2 || (m === 2 && d < 4) ? y - 1 : y;
  const yearStemIdx   = ((sajuYear - 1984) % 10 + 10) % 10;
  const yearBranchIdx = ((sajuYear - 1984) % 12 + 12) % 12;

  // ── 월주(月柱) ───────────────────────────────────
  const monthBranchIdx = getMonthBranchIdx(m, d);
  // 인월(寅月, branchIdx=2)을 월 순서 0번으로 기산
  const monthOrder    = (monthBranchIdx - 2 + 12) % 12;
  // 갑기년→병(2) / 을경년→무(4) / 병신년→경(6) / 정임년→임(8) / 무계년→갑(0)
  const monthStemStart = ((yearStemIdx % 5) * 2 + 2) % 10;
  const monthStemIdx   = (monthStemStart + monthOrder) % 10;

  // ── 일주(日柱) ───────────────────────────────────
  // 기준: JDN 2415021 (1900-01-01) = 갑술(甲戌), 60갑자 index=10
  const jdn        = getJDN(y, m, d);
  const day60      = ((jdn - 2_415_021 + 10) % 60 + 60) % 60;
  const dayStemIdx   = day60 % 10;
  const dayBranchIdx = day60 % 12;

  // ── 시주(時柱) ───────────────────────────────────
  let hourPillar: Pillar | null = null;
  if (birthTime) {
    const [hStr] = birthTime.split(':');
    const h = parseInt(hStr);

    // 자시(子時): 23:00~01:00
    const hourBranchIdx = h === 23 ? 0 : Math.floor((h + 1) / 2) % 12;

    // 갑기일→갑(0) / 을경일→병(2) / 병신일→무(4) / 정임일→경(6) / 무계일→임(8)
    const hourStemStart = (dayStemIdx % 5) * 2;
    const hourStemIdx   = (hourStemStart + hourBranchIdx) % 10;

    hourPillar = makePillar(hourStemIdx, hourBranchIdx);
  }

  return {
    year:  makePillar(yearStemIdx,  yearBranchIdx),
    month: makePillar(monthStemIdx, monthBranchIdx),
    day:   makePillar(dayStemIdx,   dayBranchIdx),
    hour:  hourPillar,
  };
}

// 시간 문자열 → 시(時) 이름
export function getTimeLabel(birthTime: string): string {
  const h = parseInt(birthTime.split(':')[0]);
  const labels = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
  const idx = h === 23 ? 0 : Math.floor((h + 1) / 2) % 12;
  return `${labels[idx]}시`;
}

// ═══════════════════════════════════════════════════════
// 십성(十星) · 지장간(支藏干) · 대운(大運) · 세운(歲運)
// ═══════════════════════════════════════════════════════

export const TEN_GODS = [
  '비견', '겁재', '식신', '상관', '편재', '정재', '편관', '정관', '편인', '정인',
] as const;
export type TenGod = (typeof TEN_GODS)[number];

// 일간(日干) 기준 십성 — 오행 관계(비아/아생/아극/극아/생아) × 음양 동이
export function getTenGod(dayStemIdx: number, targetStemIdx: number): TenGod {
  const dayEl = Math.floor(dayStemIdx / 2);    // 목0 화1 토2 금3 수4
  const tgtEl = Math.floor(targetStemIdx / 2);
  const samePolarity = dayStemIdx % 2 === targetStemIdx % 2;
  let base: number;
  if (tgtEl === dayEl) base = 0;                  // 비견·겁재 (나와 같은 기운)
  else if ((dayEl + 1) % 5 === tgtEl) base = 2;   // 식신·상관 (내가 생하는 기운)
  else if ((dayEl + 2) % 5 === tgtEl) base = 4;   // 편재·정재 (내가 극하는 기운)
  else if ((tgtEl + 2) % 5 === dayEl) base = 6;   // 편관·정관 (나를 극하는 기운)
  else base = 8;                                  // 편인·정인 (나를 생하는 기운)
  return TEN_GODS[base + (samePolarity ? 0 : 1)];
}

// 지장간 — 각 지지(자~해) 속에 숨은 천간 인덱스. 마지막 원소가 본기(本氣, 주된 기운)
export const BRANCH_HIDDEN_STEMS: readonly (readonly number[])[] = [
  [8, 9],     // 자: 임·계
  [9, 7, 5],  // 축: 계·신·기
  [4, 2, 0],  // 인: 무·병·갑
  [0, 1],     // 묘: 갑·을
  [1, 9, 4],  // 진: 을·계·무
  [4, 6, 2],  // 사: 무·경·병
  [2, 5, 3],  // 오: 병·기·정
  [3, 1, 5],  // 미: 정·을·기
  [4, 8, 6],  // 신: 무·임·경
  [6, 7],     // 유: 경·신
  [7, 3, 4],  // 술: 신·정·무
  [4, 0, 8],  // 해: 무·갑·임
];

// 연도 → 그 해의 간지 (세운용). 입춘 기준 경계는 호출자가 인지하고 사용
export function getYearGanji(year: number): {
  stemIdx: number; branchIdx: number; name: string; hanja: string;
} {
  const stemIdx = ((year - 1984) % 10 + 10) % 10;
  const branchIdx = ((year - 1984) % 12 + 12) % 12;
  return {
    stemIdx,
    branchIdx,
    name: `${STEMS[stemIdx]}${BRANCHES[branchIdx]}`,
    hanja: `${STEMS_HANJA[stemIdx]}${BRANCHES_HANJA[branchIdx]}`,
  };
}

export interface Daewoon {
  startAge: number;   // 시작 나이 (만 나이 근사)
  startYear: number;  // 시작 연도
  stem: string;
  branch: string;
  stemHanja: string;
  branchHanja: string;
  stemIdx: number;
  branchIdx: number;
}

export interface DaewoonResult {
  direction: '순행' | '역행';
  daewoonSu: number;    // 대운수 (첫 대운이 들어오는 나이)
  list: Daewoon[];
}

// 출생 연도 ±1년 범위의 절기 JDN 목록 (근사 날짜 기반)
function jeolgiJdnsAround(year: number): number[] {
  const jdns: number[] = [];
  for (let y = year - 1; y <= year + 1; y++) {
    for (const [m, d] of JEOLGI) jdns.push(getJDN(y, m, d));
  }
  return jdns.sort((a, b) => a - b);
}

// 대운 계산 — 양년생 남·음년생 여 → 순행 / 음년생 남·양년생 여 → 역행.
// 대운수 = 출생일~다음(순행)/이전(역행) 절기까지 일수 ÷ 3 (반올림, 1~10).
// 절기가 근사 날짜라 대운수는 ±1년 오차가 있을 수 있다.
export function calculateDaewoon(
  birthDate: string,
  gender: 'male' | 'female',
  count = 8,
): DaewoonResult {
  const [y, m, d] = birthDate.split('-').map(Number);
  const pillars = calculateSaju(birthDate);

  const yangYear = pillars.year.stemIdx % 2 === 0;
  const forward = (yangYear && gender === 'male') || (!yangYear && gender === 'female');

  const birthJdn = getJDN(y, m, d);
  const jdns = jeolgiJdnsAround(y);
  const days = forward
    ? jdns.find((j) => j > birthJdn)! - birthJdn
    : birthJdn - [...jdns].reverse().find((j) => j <= birthJdn)!;
  const daewoonSu = Math.min(10, Math.max(1, Math.round(days / 3)));

  // 월주의 60갑자 인덱스 → 대운은 거기서 한 칸씩 순행/역행
  let month60 = pillars.month.stemIdx;
  while (month60 % 12 !== pillars.month.branchIdx) month60 += 10;

  const dir = forward ? 1 : -1;
  const list: Daewoon[] = Array.from({ length: count }, (_, i) => {
    const k = ((month60 + dir * (i + 1)) % 60 + 60) % 60;
    const stemIdx = k % 10;
    const branchIdx = k % 12;
    const startAge = daewoonSu + 10 * i;
    return {
      startAge,
      startYear: y + startAge,
      stem: STEMS[stemIdx],
      branch: BRANCHES[branchIdx],
      stemHanja: STEMS_HANJA[stemIdx],
      branchHanja: BRANCHES_HANJA[branchIdx],
      stemIdx,
      branchIdx,
    };
  });

  return { direction: forward ? '순행' : '역행', daewoonSu, list };
}
