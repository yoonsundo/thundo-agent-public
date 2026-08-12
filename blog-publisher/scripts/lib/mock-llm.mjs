/**
 * lib/mock-llm.mjs — 에이전트 산출물 시뮬레이터 (claude 호출 없음)
 * §A2 스키마 정확히 준수.
 * mockDraft 본문: 1500~2000 한국어 음절 (공백·영문 제외 카운트).
 * 런마다 다양한 내용 생성 — 단락 셔플 + 주제별 삽입구 변형으로 dup 게이트 안정.
 */

import { createHash } from 'node:crypto';

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

/** 16자 dedup_key 생성 (§A2 규격) */
function makeDedupKey(title, keywords) {
  const norm = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const kw   = [...keywords].sort().join(',');
  return sha256hex(`${norm}|${kw}`).slice(0, 16);
}

/** 짧은 UUID-like ID */
function uid() {
  return Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 6);
}

/** 한국어 음절(가~힣) 수 카운트 */
export function countSyllables(text) {
  return [...text].filter(c => c >= '가' && c <= '힣').length;
}

/**
 * Fisher-Yates 셔플 — 배열을 제자리에서 섞어 반환.
 * seed 기반이 아닌 런타임 랜덤 → 런마다 다른 단락 순서.
 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const TOPIC_POOL = [
  {
    title: 'Claude Code로 블로그 자동발행 파이프라인 만들기',
    angle: '13개 에이전트 실전 설계와 주요 실수',
    keywords: ['Claude Code', '블로그 자동화', '에이전트 파이프라인', 'AI 자동화'],
    categories: ['AI 도구 사용법', '자동화 워크플로우'],
  },
  {
    title: 'ChatGPT vs Claude — 2025년 실무 비교',
    angle: '코딩·글쓰기·리서치 태스크별 실제 성능',
    keywords: ['ChatGPT', 'Claude', 'AI 비교', 'LLM 실무'],
    categories: ['AI 도구 사용법'],
  },
  {
    title: 'n8n으로 뉴스 수집부터 요약까지 자동화하는 법',
    angle: 'RSS·Reddit·Slack 연동 워크플로우 실전',
    keywords: ['n8n', '자동화', 'RSS', 'Slack', '워크플로우'],
    categories: ['자동화 워크플로우'],
  },
  {
    title: 'Obsidian + AI로 제텔카스텐 구축하기',
    angle: '플러그인 3개로 만드는 지식 자동화 시스템',
    keywords: ['Obsidian', '제텔카스텐', 'AI', '노트 자동화', '생산성'],
    categories: ['생산성 팁'],
  },
  {
    title: 'Cursor IDE 실전 가이드 — 초보가 빠지는 함정 5가지',
    angle: 'AI 코딩 도구를 제대로 쓰는 프롬프트 전략',
    keywords: ['Cursor', 'AI IDE', '코딩 자동화', '프롬프트'],
    categories: ['AI 도구 사용법'],
  },
];

const SOURCE_REFS_POOL = [
  { url: 'https://docs.anthropic.com/claude', type: 'official', title: 'Anthropic Claude 공식 문서' },
  { url: 'https://openai.com/research', type: 'research', title: 'OpenAI Research 블로그' },
  { url: 'https://n8n.io/blog', type: 'blog', title: 'n8n 공식 블로그' },
  { url: 'https://obsidian.md/blog', type: 'blog', title: 'Obsidian 공식 블로그' },
  { url: 'https://cursor.sh/blog', type: 'blog', title: 'Cursor 공식 블로그' },
];

// ─── 섹션별 전용 단락 풀 ──────────────────────────────────────────────────────
// 각 작가(beaver/fox/wolf)의 각 섹션에 전용 단락을 배정.
// 섹션 간 4-gram Jaccard < 0.107 을 유지하기 위해 섹션마다 주제·어휘를 완전히 분리.
// 니치 키워드(AI·자동화·LLM·워크플로우·생산성·에이전트·프롬프트·도구 등)를
// 각 섹션 단락에 자연스럽게 포함 → niche_keyword_ratio ≥ 0.40 달성.
// 구체 토큰(숫자·기간·영문 고유명사)을 각 섹션에 삽입 → density·credibility 통과.

// ─── BEAVER (how-to) 섹션별 단락 ─────────────────────────────────────────────

/** beaver 섹션 0: 왜 이 도구인가 — AI 자동화 도입 배경 */
const BEAVER_WHY = [
  'Claude Code나 Cursor 같은 AI 코딩 도구가 2024년 이후 급속도로 보급되면서, 반복 스크립트 작성에 드는 시간이 팀당 주 평균 8시간에서 2시간 미만으로 줄었다는 사례가 늘고 있습니다. LLM 에이전트를 파이프라인에 투입하면 단순 자동화 대비 처리 유연성이 크게 높아집니다.',
  'n8n, Zapier, Make 같은 노코드 워크플로우 플랫폼이 2023년부터 LLM 연동 기능을 기본 제공하면서 API 없이도 AI 자동화를 구성할 수 있게 됐습니다. 프롬프트 설계 능력이 파이프라인 품질을 좌우하는 핵심 역량으로 부상했습니다.',
  'GPT-4o와 Claude Sonnet 3.7 기준으로 입력 100만 토큰당 비용이 2달러 수준까지 내려왔습니다. 3년 전 같은 성능을 얻으려면 10배 이상 비용이 필요했음을 감안하면, 소규모 팀도 LLM 기반 자동화를 충분히 운영할 수 있는 환경이 마련됐습니다.',
];

/** beaver 섹션 1: 사전 준비 — 환경 설정·의존성 */
const BEAVER_PREP = [
  'Node.js 20 LTS와 pnpm 9.x 조합이 현재 AI 자동화 스크립트 생태계에서 가장 넓게 쓰입니다. Python 환경이라면 uv 패키지 매니저를 활용하면 가상환경 생성부터 의존성 잠금까지 30초 안에 처리됩니다.',
  'Anthropic API 키는 환경 변수 ANTHROPIC_API_KEY에, OpenAI 키는 OPENAI_API_KEY에 저장하는 것이 표준 관행입니다. .env 파일에 저장한 뒤 dotenv 라이브러리로 로드하면 코드에 키가 하드코딩되는 사고를 막을 수 있습니다.',
  'GitHub Actions나 GitLab CI에서 LLM API를 호출할 때는 Secrets 기능으로 키를 관리하세요. Repository 단위 시크릿은 fork된 PR에서 노출되지 않으므로 오픈소스 프로젝트에서도 안전하게 사용할 수 있습니다.',
];

/** beaver 섹션 2: 단계별 설정 — 실제 구현 절차 */
const BEAVER_STEPS = [
  '첫 번째 단계는 LLM 호출 래퍼 함수를 작성하는 것입니다. 재시도 로직(최대 3회), 타임아웃(60초), 에러 로깅을 함께 구현하면 프로덕션 파이프라인에서 발생하는 오류의 80% 이상을 자동으로 처리할 수 있습니다.',
  '두 번째 단계는 입력 데이터 정규화입니다. RSS 피드, JSON API, CSV 파일 등 다양한 소스에서 수집한 데이터를 단일 스키마로 변환하면 다운스트림 에이전트가 소스 형식을 신경 쓰지 않아도 됩니다. Zod나 Joi로 스키마 검증을 자동화하면 파이프라인 신뢰도가 높아집니다.',
  '세 번째 단계는 게이트 기반 품질 검증 시스템 구축입니다. LLM 산출물을 그대로 발행하지 않고 길이·금칙어·중복·밀도 등 결정론 게이트를 통과한 것만 다음 단계로 넘기면 불량 콘텐츠 발행률을 5% 미만으로 유지할 수 있습니다.',
];

/** beaver 섹션 3: 흔한 실수와 해결책 */
const BEAVER_MISTAKES = [
  'API 속도 제한(Rate Limit)을 고려하지 않고 병렬 요청을 무제한으로 날리는 실수가 흔합니다. Anthropic Claude API는 분당 요청 횟수와 토큰 한도가 플랜별로 다르므로 p-limit 라이브러리로 동시 요청을 4~8개로 제한하는 것이 권장됩니다.',
  '프롬프트 인젝션 공격에 대한 방어가 미흡한 경우도 많습니다. 외부 소스에서 수집한 텍스트를 그대로 시스템 프롬프트에 삽입하면 악성 명령이 포함될 수 있습니다. 사용자 입력은 반드시 별도 구분자로 감싸고 역할을 명확히 지정하세요.',
  '토큰 사용량 추적 없이 파이프라인을 운영하다가 월말에 예상치 못한 청구서를 받는 경우가 있습니다. 각 LLM 호출마다 usage 필드를 파싱해 일별 누적 토큰을 로깅하고 하드캡을 설정해두면 예산 초과를 사전에 방지할 수 있습니다.',
];

/** beaver 섹션 4: 정리 — 다음 단계 안내 */
const BEAVER_SUMMARY = [
  '이 가이드에서 다룬 LLM 자동화 파이프라인의 핵심은 수집→생성→검증→발행의 4단계 구조입니다. 각 단계를 독립 모듈로 분리해두면 특정 에이전트만 교체해도 전체 파이프라인에 영향을 주지 않습니다.',
  '다음 단계로는 모니터링 대시보드 구축을 권합니다. Grafana와 InfluxDB 조합이나 간단히 Google Sheets 연동으로도 일별 발행 수·게이트 통과율·토큰 비용을 시각화할 수 있습니다. 수치가 눈에 보이면 개선 포인트를 찾기가 훨씬 쉬워집니다.',
  '오픈소스 커뮤니티에서 비슷한 파이프라인 구현 사례를 찾아보세요. LangChain, LlamaIndex, Haystack 등 에이전트 프레임워크 생태계가 빠르게 성숙하면서 바퀴를 새로 발명하지 않아도 되는 수준이 됐습니다.',
];

// ─── FOX (review) 섹션별 단락 ─────────────────────────────────────────────────

/** fox 섹션 0: 비교 기준 — 평가 프레임 */
const FOX_CRITERIA = [
  'AI 도구 비교에서 가장 중요한 기준은 실제 워크플로우 통합 난이도입니다. 벤치마크 점수가 높아도 기존 Slack, Notion, GitHub 생태계와 연동하는 데 2주 이상 걸린다면 팀 생산성에 오히려 해가 됩니다.',
  'LLM 기반 제품을 평가할 때는 응답 품질뿐 아니라 컨텍스트 창(Context Window) 크기도 체크해야 합니다. Claude 3.7은 200K 토큰, GPT-4o는 128K 토큰을 지원합니다. 긴 문서를 다루는 작업이라면 컨텍스트 한도가 결정적 차이를 만듭니다.',
  '비용 구조도 꼼꼼히 살펴야 합니다. 월 구독형과 API 종량제의 손익분기점은 팀 규모와 사용 패턴에 따라 크게 달라집니다. 월 1,000회 미만 호출이라면 종량제가 유리하고, 그 이상이면 구독형을 검토해볼 만합니다.',
];

/** fox 섹션 1: 항목별 비교 */
const FOX_COMPARISON = [
  'ChatGPT(GPT-4o)와 Claude Sonnet을 코딩 태스크로 비교하면 Python 스크립트 생성에서는 GPT-4o가 약간 빠르고, 긴 코드베이스 리팩터링에서는 Claude의 200K 컨텍스트가 강점입니다. 실제 프로젝트 3건을 교차 테스트한 결과 Claude가 섹션 간 일관성을 더 잘 유지했습니다.',
  'Cursor와 GitHub Copilot을 IDE 통합 관점에서 비교하면 Cursor는 프로젝트 전체 컨텍스트를 인식하는 반면 Copilot은 현재 파일 위주로 동작합니다. 대규모 모노레포 작업에서는 Cursor의 에이전트 모드가 평균 40분 걸리던 리팩터링을 8분으로 줄여줬습니다.',
  'n8n과 Zapier를 자동화 플랫폼으로 비교하면 n8n은 셀프호스팅이 가능해 데이터 주권 측면에서 우위이고, Zapier는 2,000개 이상 앱 연동과 안정적인 SLA가 강점입니다. 한 달 무료 트라이얼 후 팀 요건에 맞춰 선택하는 것을 권합니다.',
];

/** fox 섹션 2: 장단점 요약 */
const FOX_PROS_CONS = [
  '장점으로는 세 가지를 꼽겠습니다. 첫째, 반복 작업 자동화로 팀원 1인당 주 5~10시간을 절약할 수 있습니다. 둘째, LLM 기반 요약·분류 덕분에 정보 과부하를 줄일 수 있습니다. 셋째, API 연동으로 사람이 개입 없이 24시간 파이프라인을 유지할 수 있습니다.',
  '단점도 솔직히 짚겠습니다. 할루시네이션 위험이 상존하므로 LLM 산출물에 사람 검토 단계 없이 완전 자동화하면 오류가 발행될 수 있습니다. 또 API 비용이 스케일업 시 선형 증가하므로 월 예산 캡을 반드시 설정해야 합니다.',
  '중간 지점을 찾는다면 게이트 기반 반자동화가 현실적입니다. LLM이 초안을 생성하고 결정론 게이트가 품질을 필터링한 뒤, 경계선 케이스만 사람이 검토하는 구조입니다. Anthropic 공식 문서의 에이전트 설계 가이드에도 이 접근을 권장합니다.',
];

/** fox 섹션 3: 추천 시나리오 */
const FOX_SCENARIOS = [
  '뉴스레터 팀에 적합한 시나리오: RSS 피드 20개를 매일 자동 수집하고 Claude로 요약한 뒤 Notion 데이터베이스에 저장합니다. 편집자는 Notion에서 최종 선택만 하면 됩니다. 구현 기간은 대략 1주일이며 월 API 비용은 5달러 미만입니다.',
  '개발팀 내부 지식베이스 구축 시나리오: GitHub 이슈와 PR 코멘트를 LLM으로 구조화해 Confluence나 Notion에 자동 정리합니다. 팀 온보딩 시간이 기존 3일에서 반나절로 줄었다는 사례가 보고된 바 있습니다.',
  '소규모 미디어 스타트업 시나리오: 트렌드 키워드를 수집하고 AI 에이전트가 초안을 작성한 뒤 SEO 게이트를 통과한 글만 CMS에 발행합니다. 콘텐츠 팀 2명이 주 20편을 안정적으로 운영하는 사례가 있습니다.',
];

/** fox 섹션 4: 마무리 */
const FOX_CONCLUSION = [
  'AI 도구 선택에서 정답은 없습니다. 팀 규모, 기술 스택, 예산, 데이터 민감도에 따라 최선의 선택이 달라집니다. 무료 트라이얼로 실제 워크플로우에 적용해 보는 것이 가장 신뢰할 수 있는 평가 방법입니다.',
  '3개월 단위로 사용 중인 AI 도구를 재평가하는 루틴을 권합니다. LLM 시장이 빠르게 변하기 때문에 6개월 전 최선이던 선택이 지금은 최선이 아닐 수 있습니다. 비용 대비 성능 비교표를 팀 위키에 업데이트하는 습관을 들이세요.',
  '도입 후 30일 체크포인트를 설정하세요. 실제 사용 빈도, 절감된 업무 시간, 발생한 오류 건수를 측정해 목표 대비 성과를 검토하면 투자 정당성을 데이터로 증명할 수 있습니다.',
];

// ─── WOLF (opinion) 섹션별 단락 ──────────────────────────────────────────────

/** wolf 섹션 0: 배경과 근거 */
const WOLF_BACKGROUND = [
  'AI 에이전트 파이프라인이 지식 노동을 대체하는 속도는 예상보다 빠릅니다. McKinsey 2024년 보고서에 따르면 반복적 데이터 처리 업무의 60~70%가 현재 기술 수준에서 자동화 가능합니다. 이 숫자가 현실이 되는 시점이 5년 뒤가 아니라 지금 당장일 수 있습니다.',
  'LLM 추론 비용은 18개월마다 절반씩 떨어지고 있습니다. GPT-3 출시 당시 100만 토큰당 20달러였던 비용이 지금은 0.15달러 수준입니다. 이 속도라면 2026년 중으로 대부분의 콘텐츠 자동화 파이프라인이 수익 구조를 바꿀 것입니다.',
  '국내 기업들도 변하고 있습니다. 네이버, 카카오, 크래프톤이 사내 LLM 에이전트 도입을 공식화했고, 스타트업 생태계에서는 AI 자동화 스택 없이 시드 투자를 받기 어렵다는 이야기가 나오고 있습니다.',
];

/** wolf 섹션 1: 반론 검토 */
const WOLF_COUNTERARG = [
  '"AI가 아직 신뢰할 수 없다"는 반론을 자주 듣습니다. 맞는 말입니다. Claude나 GPT-4o도 할루시네이션을 완전히 제거하지 못했습니다. 그러나 이 반론은 "자동화를 하지 말라"는 결론으로 이어져서는 안 됩니다. 할루시네이션 위험은 게이트와 검증 레이어로 관리할 수 있습니다.',
  '"비용이 부담된다"는 반론도 있습니다. Anthropic Claude API 기준 월 50달러 예산으로 하루 100편 초안 생성이 가능합니다. 인력 비용과 비교하면 자동화 투자 회수 기간은 통상 2~3개월입니다. 비용 문제는 실행하지 않을 이유가 아니라 ROI 계산의 출발점이어야 합니다.',
  '"우리 팀에는 맞지 않는다"는 반론도 있습니다. 팀 규모가 작을수록 사람이 하는 반복 업무가 더 큰 비중을 차지합니다. 2인 팀이라면 한 명분의 반복 업무를 자동화하는 것만으로도 팀 처리 용량이 두 배가 됩니다.',
];

/** wolf 섹션 2: 실제 경험담 */
const WOLF_EXPERIENCE = [
  '뉴스레터 발행 자동화를 6개월간 운영한 결과를 공유합니다. 처음 한 달은 프롬프트 튜닝에 시간을 많이 썼지만 2개월차부터 안정화됐습니다. 현재는 매주 5편을 AI 에이전트가 초안 작성하고 편집자가 30분 검토하는 방식으로 운영 중입니다.',
  '가장 놀란 점은 독자 반응이었습니다. AI 초안과 사람이 쓴 글을 블라인드 테스트한 결과 독자의 73%가 둘을 구분하지 못했습니다. 물론 이는 게이트 시스템이 AI 티를 걸러낸 덕분이기도 합니다. ai-tells 게이트 하나만으로도 글의 자연스러움이 크게 개선됐습니다.',
  '실패 사례도 있습니다. 처음에는 게이트 없이 완전 자동 발행을 시도했다가 할루시네이션 오류가 포함된 글이 나간 적이 있습니다. 그 이후 13종 품질 게이트를 단계적으로 도입했고 오류 발행률이 주 2건에서 0건으로 떨어졌습니다.',
];

/** wolf 섹션 3: 결론 */
const WOLF_CLOSING = [
  'AI 자동화 파이프라인 도입은 선택이 아니라 타이밍의 문제입니다. 지금 시작한 팀이 6개월 후 갖게 될 데이터·프롬프트·노하우는 늦게 시작한 팀이 따라잡기 어려운 격차가 됩니다.',
  '시작 방법은 간단합니다. 팀에서 가장 반복적인 작업 하나를 골라 LLM 자동화를 적용해보세요. 첫 파이프라인은 거칠어도 됩니다. 작동하는 최소 구성에서 시작해 주 단위로 개선하면 3개월 안에 팀 운영 방식 자체가 바뀝니다.',
  '저는 이 방향이 옳다고 확신합니다. Anthropic, OpenAI, Google이 경쟁적으로 에이전트 기능을 강화하는 지금이 가장 좋은 타이밍입니다. 도구는 이미 충분히 좋아졌습니다. 남은 건 시작하는 결단뿐입니다.',
];

// ─── 섹션→단락 풀 매핑 ───────────────────────────────────────────────────────
// 각 작가의 섹션 순서에 맞춰 섹션 전용 단락 풀을 배열로 정의.
// 섹션마다 어휘 주제가 완전히 달라 4-gram Jaccard가 임계(0.107) 이하로 유지됨.

const SECTION_POOLS = {
  beaver: [BEAVER_WHY, BEAVER_PREP, BEAVER_STEPS, BEAVER_MISTAKES, BEAVER_SUMMARY],
  fox:    [FOX_CRITERIA, FOX_COMPARISON, FOX_PROS_CONS, FOX_SCENARIOS, FOX_CONCLUSION],
  wolf:   [WOLF_BACKGROUND, WOLF_COUNTERARG, WOLF_EXPERIENCE, WOLF_CLOSING],
};

// ─── 본문 생성기 ──────────────────────────────────────────────────────────────

/**
 * 목표 음절 수에 맞춰 본문 생성.
 * 섹션마다 전용 단락 풀에서 선택 → 섹션 간 4-gram Jaccard < 0.107 보장.
 * 런마다 각 섹션 풀 내부를 셔플 → 반복 실행 시 다양성 유지.
 */
function buildBody(topic, outline, writer, targetMin = 1500, targetMax = 2000) {
  const writerKey = ['beaver', 'fox', 'wolf'].includes(writer) ? writer : 'beaver';

  // H1 제목 + 작가별 도입부 (MD022: 헤딩 앞뒤 빈 줄 필수)
  const writerIntros = {
    beaver: `# ${topic.title}\n\n이 글은 ${topic.title}를 처음 접하는 분들을 위한 단계별 실용 가이드입니다. AI 자동화 워크플로우와 LLM 도구 활용법을 중심으로 설명합니다.\n\n`,
    fox:    `# ${topic.title}\n\n${topic.title}에 대해 실제 사용 데이터와 비용 분석을 바탕으로 평가합니다. AI 도구와 자동화 파이프라인 선택에 도움이 되길 바랍니다.\n\n`,
    wolf:   `# ${topic.title}\n\n${topic.title}에 대한 제 입장을 솔직하게 밝힙니다. AI 에이전트와 LLM 자동화가 업무 방식을 바꾸는 속도를 데이터와 경험으로 살펴보겠습니다.\n\n`,
  };

  const sectionsByWriter = {
    beaver: ['## 왜 이 도구인가', '## 사전 준비', '## 단계별 설정', '## 흔한 실수와 해결책', '## 정리'],
    fox:    ['## 비교 기준', '## 항목별 비교', '## 장단점 요약', '## 추천 시나리오', '## 마무리'],
    wolf:   ['## 배경과 근거', '## 반론 검토', '## 실제 경험담', '## 마치며'],
  };

  const secs = sectionsByWriter[writerKey];
  const pools = SECTION_POOLS[writerKey];

  let body = writerIntros[writerKey];

  // 각 섹션에 전용 풀에서 단락 2개 선택 (풀 내부 셔플로 런마다 다른 조합)
  for (let si = 0; si < secs.length; si++) {
    body += `${secs[si]}\n\n`;
    const pool = shuffle(pools[si] || pools[0]);
    // 풀 크기가 2 미만이면 첫 번째 단락 반복
    body += pool[0] + '\n\n';
    body += (pool[1] || pool[0]) + '\n\n';
  }

  // 음절 수 확인 후 부족하면 추가 단락 삽입 (마지막 섹션 풀 순환)
  const lastPool = shuffle(pools[pools.length - 1] || pools[0]);
  let extraIdx = 0;
  let syl = countSyllables(body);
  while (syl < targetMin) {
    body += lastPool[extraIdx % lastPool.length] + '\n\n';
    extraIdx++;
    syl = countSyllables(body);
  }

  // 초과 시 마지막 단락 트림 (음절 기준)
  if (syl > targetMax) {
    const chars = [...body];
    let kCount = 0;
    let cutIdx  = chars.length;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] >= '가' && chars[i] <= '힣') kCount++;
      if (kCount >= targetMax) {
        cutIdx = i + 1;
        break;
      }
    }
    let trimBody = body.slice(0, cutIdx);
    const lastPeriod = Math.max(
      trimBody.lastIndexOf('.'),
      trimBody.lastIndexOf('요.'),
    );
    if (lastPeriod > trimBody.length - 200) {
      trimBody = trimBody.slice(0, lastPeriod + 1);
    }
    body = trimBody + '\n';
  }

  // 참고 자료 — 본문 단락으로 첨부 (## 헤딩 아님 — check-empty 오탐 방지)
  const refs = (topic.source_refs || []).slice(0, 3);
  if (refs.length > 0) {
    body += '\n이 글을 작성하는 데 다음 자료를 참고했습니다: ';
    body += refs.map(r => `${r.title}(${r.type})`).join(', ') + '.\n\n';
  }

  return body;
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * mockResearch(source) → Topic[]
 * §A2 Topic 스키마 준수.
 */
export function mockResearch(source = 'reddit') {
  const pool = [...TOPIC_POOL];
  // 2~3개 반환, source 태그 반영
  const count = 2 + Math.floor(Math.random() * 2);
  const picked = pool.sort(() => Math.random() - 0.5).slice(0, count);

  return picked.map((t, i) => {
    const refs = SOURCE_REFS_POOL.slice(i % SOURCE_REFS_POOL.length,
      (i % SOURCE_REFS_POOL.length) + 2);
    return {
      id:           `topic-${uid()}`,
      source:       source === 'reddit' ? 'reddit' : (i % 2 === 0 ? 'trend' : 'depth'),
      collector:    source === 'reddit' ? 'magpie' : (source === 'trend' ? 'cheetah' : 'owl'),
      title:        t.title,
      angle:        t.angle,
      keywords:     t.keywords,
      source_refs:  refs,
      dedup_key:    makeDedupKey(t.title, t.keywords),
      created_at:   nowIso(),
    };
  });
}

/**
 * mockOutline(topic) → Outline
 * §A2 Outline 스키마 준수.
 */
export function mockOutline(topic) {
  const writerTypes = { 'AI 도구 사용법': 'fox', '자동화 워크플로우': 'beaver', '생산성 팁': 'wolf' };
  const cat = topic.keywords[0] ? 'AI 도구 사용법' : '자동화 워크플로우';
  const writerAssigned = writerTypes[cat] || 'beaver';
  const asciiSlug = `post-${uid()}`;

  return {
    id:              `outline-${uid()}`,
    topic_id:        topic.id,
    slug:            asciiSlug,
    writer_assigned: writerAssigned,
    target_chars:    [1500, 2000],
    sections: [
      '시작하기 전에',
      '핵심 개념',
      '단계별 가이드',
      '흔한 실수',
      '정리 및 다음 단계',
    ],
    created_at: nowIso(),
  };
}

/**
 * mockDraft(topic, outline, writer) → Draft
 * §A2 Draft 스키마 준수. 본문 1500~2000 한국어 음절.
 */
export function mockDraft(topic, outline, writer) {
  writer = writer || outline.writer_assigned || 'beaver';
  const pipeline = { length: { min: 1500, max: 2000 } };

  const body = buildBody(topic, outline, writer, pipeline.length.min, pipeline.length.max);
  const sylCount = countSyllables(body);

  const draftId = `draft-${uid()}`;

  const frontmatter = [
    '---',
    `id: ${draftId}`,
    `topic_id: ${topic.id}`,
    `outline_id: ${outline.id}`,
    `writer: ${writer}`,
    `slug: ${outline.slug}`,
    `title: "${topic.title}"`,
    `char_count: ${sylCount}`,
    `status: draft`,
    `attempt: 0`,
    `created_at: "${nowIso()}"`,
    '---',
    '',
  ].join('\n');

  const fullContent = frontmatter + body;

  return {
    id:          draftId,
    topic_id:    topic.id,
    outline_id:  outline.id,
    writer,
    slug:        outline.slug,
    title:       topic.title,
    char_count:  sylCount,
    status:      'draft',
    attempt:     0,
    source_refs: topic.source_refs || [],
    content:     fullContent,
    created_at:  nowIso(),
  };
}

/**
 * mockReview(draft, validator) → Review
 * §A2 Review 스키마 준수.
 * 주로 pass, 가끔 fail (재시도 테스트용).
 */
export function mockReview(draft, validator) {
  const validators = ['eagle', 'bee', 'swan', 'raven'];
  validator = validator || validators[Math.floor(Math.random() * validators.length)];

  // MOCK_REVIEW_FORCE_FAIL=1 → 항상 fail (발행0 엣지케이스 테스트용)
  // 약 15% 확률로 fail (재시도 테스트)
  const shouldFail = process.env.MOCK_REVIEW_FORCE_FAIL === '1' || Math.random() < 0.15;

  const passReasons = {
    eagle: ['핵심 주장에 출처 링크 확인됨', '수치·날짜 정확 — 공식 문서 일치', '무인용 단정 비율 60% 이하'],
    bee:   ['제목에 핵심 키워드 포함', 'H2 섹션 3개 이상', '슬러그 영문 ASCII 확인', '음절 수 기준 충족'],
    swan:  ['도입-본문-결론 흐름 자연스러움', '빈 섹션 없음', '문단 가독성 양호'],
    raven: ['SimHash 표절 해시 통과', '충분한 변형·관점 추가 확인됨', 'AI 양산 투성이 표현 최소'],
  };

  const failReasons = {
    eagle: ['일부 수치 출처 불명확', '2개 단정 문장 링크 없음'],
    bee:   ['H2 섹션 2개만 탐지 — 최소 3개 필요', '메타 설명 누락'],
    swan:  ['결론 섹션 분량 과소 (50자 미만 감지)', '일부 문단 전환이 어색함'],
    raven: ['도입부 AI 클리셰 표현 2건 발견', '원본과 유사도 경계치 근접'],
  };

  const v = validators.includes(validator) ? validator : 'eagle';

  if (shouldFail) {
    return {
      draft_id:               draft.id,
      validator:              v,
      verdict:                'fail',
      authority:              'advisory',
      reasons:                failReasons[v] || ['검토 실패 (시뮬레이션)'],
      deterministic_gate_ref: null,
      model:                  'mock/v1',
      flags:                  ['MOCK_FAIL'],
      reviewed_at:            nowIso(),
    };
  }

  return {
    draft_id:               draft.id,
    validator:              v,
    verdict:                'pass',
    authority:              'advisory',
    reasons:                passReasons[v] || ['통과'],
    deterministic_gate_ref: null,
    model:                  'mock/v1',
    flags:                  ['MOCK_PASS'],
    reviewed_at:            nowIso(),
  };
}

// ─── 이미지 디자이너 듀얼 mock (결정론 — Math.random 미사용) ──────────────────
// 후보 표준객체: { by, format, path, alt, brief, svg?, score?, meta:{w,h,bytes,mock} }
// path 는 디자이너 스크립트가 파일 기록 후 채운다(여기선 svg 마크업·메타만 산출).

/** 제목에서 핵심 토큰 추출(한글 어절/영문 단어, 2자+) */
function imageTokens(text) {
  return (text || '')
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(w => w.length >= 2);
}

/** 결정론 팔레트(해시 기반) */
function seededPalette(seed) {
  const h = parseInt(sha256hex(seed).slice(0, 6), 16);
  const hue = h % 360;
  return {
    bg:     `hsl(${hue} 38% 16%)`,
    accent: `hsl(${(hue + 40) % 360} 70% 58%)`,
    fg:     'hsl(0 0% 96%)',
  };
}

/** 결정론 SVG 커버 생성(1200x630, 1.91:1). title·seed·palette 로 재현가능. */
function buildCoverSVG(title, seed, palette, tag) {
  const W = 1200, H = 630;
  const safe = String(title || '제목 없음').replace(/[<&>"]/g, c =>
    ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  // 제목 줄바꿈(대략 18자/줄)
  const words = safe.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > 18) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 4);
  const h2 = parseInt(sha256hex(seed + '|deco').slice(0, 8), 16);
  const cx = 200 + (h2 % 800), cy = 120 + ((h2 >> 8) % 380), r = 80 + ((h2 >> 16) % 160);
  const tspans = shown.map((l, i) =>
    `<tspan x="80" dy="${i === 0 ? 0 : 70}">${l}</tspan>`).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`,
    `<rect width="${W}" height="${H}" fill="${palette.bg}"/>`,
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${palette.accent}" opacity="0.22"/>`,
    `<rect x="0" y="${H - 14}" width="${W}" height="14" fill="${palette.accent}"/>`,
    `<text x="80" y="240" font-family="system-ui,sans-serif" font-size="58" font-weight="700" fill="${palette.fg}">${tspans}</text>`,
    `<text x="80" y="${H - 50}" font-family="system-ui,sans-serif" font-size="26" fill="${palette.accent}">${tag}</text>`,
    `</svg>`,
  ].join('');
}

/** 후보 brief·alt 생성(결정론) */
function imageBriefAlt(topic, draft, by) {
  const title = (topic && topic.title) || (draft && draft.title) || '블로그 글';
  const kws = imageTokens(title).slice(0, 6).join(' ');
  return {
    alt:   `${title} 핵심 개념을 담은 커버 이미지`,
    brief: `${by} 디자이너: "${title}" 주제. 키워드 ${kws}. 차분한 톤, 텍스트 가독 우선.`,
  };
}

/** mockImageSVG(topic, draft) → Claude(SVG) 후보 (결정론) */
export function mockImageSVG(topic, draft) {
  const title = (topic && topic.title) || (draft && draft.title) || '블로그 글';
  const seed = sha256hex(`claude|${title}`);
  const palette = seededPalette(seed);
  const svg = buildCoverSVG(title, seed, palette, 'illustration · claude');
  const { alt, brief } = imageBriefAlt(topic, draft, 'claude');
  return {
    by: 'claude', format: 'svg', path: null, alt, brief, svg,
    meta: { w: 1200, h: 630, bytes: Buffer.byteLength(svg, 'utf8'), mock: true },
  };
}

/** mockImageRaster(topic, draft) → Gemini(래스터 placeholder, mock=SVG) 후보 (결정론) */
export function mockImageRaster(topic, draft) {
  const title = (topic && topic.title) || (draft && draft.title) || '블로그 글';
  const seed = sha256hex(`gemini|${title}`);
  const palette = seededPalette(seed + '|g');
  const svg = buildCoverSVG(title, seed, palette, 'render · gemini');
  const { alt, brief } = imageBriefAlt(topic, draft, 'gemini');
  return {
    by: 'gemini', format: 'svg', path: null, alt, brief, svg,
    meta: { w: 1200, h: 630, bytes: Buffer.byteLength(svg, 'utf8'), mock: true, intended: 'webp' },
  };
}

/**
 * mockImageJudge(candidates, draft) → { winner, scores, tiebreak }
 * 결정론. 포맷무관 jaccard(alt+brief 토큰, 제목 토큰)로 채점. by 미참조(blind).
 */
export function mockImageJudge(candidates, draft) {
  const valid = (candidates || []).filter(Boolean);
  if (valid.length === 0) return { winner: null, scores: [], tiebreak: false };
  const titleTokens = new Set(imageTokens((draft && draft.title) || ''));
  const scoreOf = (c) => {
    const ct = new Set(imageTokens(`${c.alt} ${c.brief}`));
    let inter = 0;
    for (const t of ct) if (titleTokens.has(t)) inter++;
    const union = new Set([...ct, ...titleTokens]).size || 1;
    return inter / union;
  };
  const scores = valid.map(c => ({ by: c.by, score: scoreOf(c) }));
  let best = valid[0], bestScore = scoreOf(valid[0]), tiebreak = false;
  for (const c of valid.slice(1)) {
    const s = scoreOf(c);
    if (s > bestScore + 0.05) { best = c; bestScore = s; }
    else if (Math.abs(s - bestScore) <= 0.05) {
      tiebreak = true; // 동점 → 결정론 by 알파벳순
      if (c.by < best.by) { best = c; bestScore = s; }
    }
  }
  return { winner: best, scores, tiebreak };
}
