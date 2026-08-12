/**
 * server/hub/query.ts — CEO Q&A 질의 응답기 (query.mjs 이식)
 *
 * 환각 방지 계약 (변형 금지):
 *   - 모든 답변은 실제 store 레코드·run.json·briefing 데이터에만 근거한다.
 *   - 데이터가 없으면 "정보 없음" 을 명시한다. 추측·채워넣기 금지.
 *   - LLM 외부 호출 없음 — 결정론 intent-match + 데이터 조회만 수행.
 */
import { makeLogger }   from './logger';
import { readRecords, timeline, latest } from './store-supabase';
// 주의: run.json 은 파이프라인 호스트에만 있고 Vercel 서버리스엔 없다.
// 런 요약(발행/예산/알림)은 파이프라인이 STEP 9 에서 Supabase hub_briefings 에 적재하므로,
// 질의 봇은 파일 대신 최신 브리핑 레코드(latest('briefing'))에서 읽는다 → Vercel 안전.

const log = makeLogger('hub/query');

// ─── 인텐트 매핑 (키워드 기반, 결정론) ────────────────────────────────────────

type Intent =
  | 'yesterday_perf'
  | 'budget'
  | 'pending_decisions'
  | 'recent_commands'
  | 'recent_messages'
  | 'pipeline_status'
  | 'recent_briefing'
  | 'timeline'
  | 'unknown';

const INTENT_PATTERNS: Array<{ intent: Intent; patterns: RegExp[] }> = [
  { intent: 'yesterday_perf',   patterns: [/어제/, /발행/, /성과/, /결과/, /어떻게 됐/, /몇 편/, /초안/] },
  { intent: 'budget',           patterns: [/예산/, /비용/, /토큰/, /얼마/, /남은/, /소비/] },
  { intent: 'pending_decisions',patterns: [/결정/, /승인/, /대기/, /기다리/, /선택/, /판단/] },
  { intent: 'recent_commands',  patterns: [/명령/, /커맨드/, /지시/, /실행/, /내렸/, /pause/, /rerun/] },
  { intent: 'recent_messages',  patterns: [/메시지/, /채팅/, /대화/, /기록/, /말했/, /전달/] },
  { intent: 'pipeline_status',  patterns: [/파이프라인/, /상태/, /돌아가/, /실행 중/, /멈/, /동작/] },
  { intent: 'recent_briefing',  patterns: [/브리핑/, /요약/, /오늘/, /보고/] },
  { intent: 'timeline',         patterns: [/타임라인/, /전체/, /흐름/, /목록/, /히스토리/, /이력/] },
];

function detectIntent(question: string): Intent {
  const lower = question.toLowerCase();
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some(p => p.test(lower))) return intent;
  }
  return 'unknown';
}

// ─── 인텐트별 데이터 조회 + 포맷 ─────────────────────────────────────────────

/** 최신 브리핑 레코드의 날짜 문자열 */
function briefingDate(b: { run_date?: unknown; ts: string }): string {
  return typeof b.run_date === 'string' ? b.run_date : b.ts.slice(0, 10);
}

async function answerYesterdayPerf(): Promise<string> {
  const b = await latest('briefing');
  if (!b) return '정보 없음: 저장된 브리핑이 없습니다. 일일 런이 완료되면 자동 생성됩니다.';

  const y = (b.yesterday ?? {}) as { published?: number; failed?: number; discarded?: number; titles?: string[] };
  const titles = Array.isArray(y.titles) ? y.titles : [];
  const lines = [
    `브리핑 기준일: ${briefingDate(b)}`,
    `발행 완료: ${y.published ?? 0}편`,
    ...titles.map(t => `  • ${t}`),
    `게이트 실패: ${y.failed ?? 0}편`,
    `폐기: ${y.discarded ?? 0}편`,
  ];
  return lines.join('\n');
}

async function answerBudget(): Promise<string> {
  const b = await latest('briefing');
  if (!b) return '정보 없음: 저장된 브리핑이 없습니다.';

  const bud = (b.budget ?? {}) as { hard_cap?: unknown; spent?: unknown; remaining?: unknown };
  if (bud.spent == null && bud.hard_cap == null) return '정보 없음: 예산 데이터가 브리핑에 없습니다.';
  const fmt = (v: unknown) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return [
    `예산 현황 (브리핑 ${briefingDate(b)} 기준):`,
    `하드캡: ${fmt(bud.hard_cap)}`,
    `사용량: ${fmt(bud.spent)}`,
    `잔여: ${fmt(bud.remaining)}`,
  ].join('\n');
}

async function answerPendingDecisions(): Promise<string> {
  const decisions = await readRecords('decision', { limit: 10 });
  if (decisions.length === 0) return '대기 중인 결정 없음 (최근 10건 기준).';
  const lines = decisions.map((d, i) => `${i + 1}. [${d.ts?.slice(0, 10) ?? '미상'}] choice=${d.choice ?? '미결'} topic=${String(d.topic ?? '—')}`);
  return ['최근 결정 기록:'].concat(lines).join('\n');
}

async function answerRecentCommands(): Promise<string> {
  const commands = await readRecords('command', { limit: 5 });
  if (commands.length === 0) return '최근 CEO 명령 없음.';
  const lines = commands.map((c, i) => `${i + 1}. [${c.ts?.slice(0, 19) ?? '미상'}] ${String(c.kind ?? c.type)} — ${JSON.stringify(c.args ?? {})}`);
  return ['최근 CEO 명령 (최대 5건):'].concat(lines).join('\n');
}

async function answerRecentMessages(): Promise<string> {
  const msgs = await readRecords('message', { limit: 5 });
  if (msgs.length === 0) return '최근 메시지 없음.';
  const lines = msgs.map((m, i) => `${i + 1}. [${m.ts?.slice(0, 19) ?? '미상'}] [${String(m.role ?? '?')}] ${String(m.content ?? '').slice(0, 100)}`);
  return ['최근 메시지 (최대 5건):'].concat(lines).join('\n');
}

async function answerPipelineStatus(): Promise<string> {
  const b = await latest('briefing');
  if (!b) return '정보 없음: 최근 브리핑이 없어 파이프라인 상태를 확인할 수 없습니다.';
  const alerts = Array.isArray(b.alerts) ? (b.alerts as Array<{ detail?: string; severity?: string }>) : [];
  const alertLine = alerts.length
    ? alerts.map(a => `  • [${a.severity ?? 'info'}] ${a.detail ?? JSON.stringify(a)}`).join('\n')
    : '  • 이상 없음 ✅';
  return [`파이프라인 상태 (브리핑 ${briefingDate(b)} 기준):`, '알림:', alertLine].join('\n');
}

async function answerRecentBriefing(): Promise<string> {
  const briefing = await latest('briefing');
  if (!briefing) return '저장된 브리핑 없음. /api/admin/briefings POST 로 생성해 주세요.';
  const text = typeof briefing.text === 'string' ? briefing.text : JSON.stringify(briefing, null, 2);
  return `최근 브리핑 [${briefing.ts?.slice(0, 10) ?? '미상'}]:\n${text.slice(0, 2000)}`;
}

async function answerTimeline(): Promise<string> {
  const rows = await timeline({ limit: 10 });
  if (rows.length === 0) return '타임라인 데이터 없음.';
  const lines = rows.map((r, i) => `${i + 1}. [${r.ts?.slice(0, 19) ?? '미상'}] [${r.type}] ${String((r as Record<string, unknown>).kind ?? r.action ?? r.choice ?? r.role ?? '').slice(0, 60)}`);
  return ['최근 허브 이벤트 (최대 10건):'].concat(lines).join('\n');
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

export interface QueryResult {
  ok: boolean;
  intent: string;
  answer: string;
  source: string;
}

/**
 * answerQuery(question) → QueryResult
 * LLM 외부 호출 없음. 결정론 intent 탐지 + store/run.json 데이터 조회만 수행.
 * 데이터 없으면 "정보 없음" 명시. 추측·채워넣기 절대 금지.
 */
export async function answerQuery(question: string): Promise<QueryResult> {
  const intent = detectIntent(question);
  log.info(`질의 처리: intent=${intent} q="${question.slice(0, 80)}"`);

  let answer: string;
  let source: string;

  switch (intent) {
    case 'yesterday_perf':
      answer = await answerYesterdayPerf(); source = 'store/briefing'; break;
    case 'budget':
      answer = await answerBudget(); source = 'store/briefing'; break;
    case 'pending_decisions':
      answer = await answerPendingDecisions(); source = 'store/decision'; break;
    case 'recent_commands':
      answer = await answerRecentCommands(); source = 'store/command'; break;
    case 'recent_messages':
      answer = await answerRecentMessages(); source = 'store/message'; break;
    case 'pipeline_status':
      answer = await answerPipelineStatus(); source = 'store/briefing'; break;
    case 'recent_briefing':
      answer = await answerRecentBriefing(); source = 'store/briefing'; break;
    case 'timeline':
      answer = await answerTimeline(); source = 'store/timeline'; break;
    default:
      answer = [
        '질문을 이해하지 못했습니다.',
        '다음 주제에 대해 질문할 수 있습니다:',
        '• 어제 발행 성과 / 초안 결과',
        '• 예산 현황 및 토큰 사용량',
        '• 대기 중인 결정 사항',
        '• 최근 CEO 명령 이력',
        '• 최근 채팅 메시지',
        '• 파이프라인 상태',
        '• 최근 브리핑 요약',
        '• 전체 타임라인',
      ].join('\n');
      source = 'none';
  }

  return { ok: true, intent, answer, source };
}
