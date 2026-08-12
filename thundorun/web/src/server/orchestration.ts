/**
 * server/orchestration.ts — 관리자 오케스트레이션 콘솔(`/admin/orchestrator`) 서버 유틸.
 *
 * agentChat.ts 미러: getSupabase(service_role) 경유, id 생성은 서버에서 req_/sub_ 접두.
 * NL 질의 1건 = orchestration_requests 카드 1건('requested'=요청중으로 태어남), 오케스트레이터
 * (runner-side `orchestrate` job)가 분해한 서브태스크는 orchestration_subtasks 에 정규화 저장.
 * 실행은 기존 agent_chat_jobs/agent_chat_messages 트랜스포트 재사용
 * (kind='orchestrate'|'execute', request_id/subtask_id 로 연결) — 승인이 유일한 실행 트리거.
 *
 * 상태 어휘(REV 2026-07-07): requested|hold|approved|done|rejected|replanning — 영문 enum,
 * 한글 라벨은 UI 몫. 초기값은 'requested'(요청중); 오케 기획이 기술적으로 불가/판단불가로 판정한
 * 경우에만 'hold'(보류)로 전환된다.
 *
 * 상세는 카드가 아니라 **스레드형 대화**다: request.session_id 의 agent_chat_messages 를
 * created_at asc 로 나열하고, 각 메시지의 subtype 으로 UI 렌더를 분기한다.
 * subtype 값: 'request'(원 요청, role user) | 'status_change'(상태전환 로그, role system) |
 * 'ai_plan'(오케 기획 요약, role assistant) | 'hold_reason'(보류 사유, role assistant) |
 * 'exec'(서브태스크 실행 스트림, role assistant) | 'done_result'(완료 결과, role assistant).
 */
import { getSupabase } from '@/lib/supabase';
import {
  ensureSession,
  listMessages,
  mkId as mkChatId,
  type ChatMessage,
} from './agentChat';

export type RequestStatus = 'requested' | 'hold' | 'approved' | 'ready' | 'rejected' | 'done' | 'replanning';
export type SubtaskStatus = 'pending' | 'queued' | 'running' | 'done' | 'error';
export type TransitionAction = 'approve' | 'hold' | 'reject' | 'replan' | 'complete' | 'resume';

export interface PlanSubtask {
  agent_id: string;
  task:     string;
  expected?: string;
}

export interface Plan {
  title?:    string;
  summary?:  string;
  worktree?: string;   // 개발 요청 시 격리 워크트리/브랜치(예: feat/notice-management). 비개발이면 빈 문자열.
  subtasks:  PlanSubtask[];
}

export interface OrchestrationRequest {
  id:                 string;
  title:              string | null;
  nl_query:           string;
  status:             RequestStatus;
  plan:               Plan | null;
  plan_version:       number;
  plan_history:       Plan[];
  reject_reason:      string | null;
  replan_note:        string | null;
  feasible:           boolean | null;
  feasibility_reason: string | null;
  worktree:           string | null;   // 계획된 격리 워크트리/브랜치(개발 요청)
  session_id:         string | null;
  created_by:         string;
  created_at:         string;
  updated_at:         string;
  decided_at:         string | null;
  decided_by:         string | null;
}

export interface OrchestrationSubtask {
  id:             string;
  request_id:     string;
  ordinal:        number;
  agent_id:       string;
  task:           string;
  expected:       string | null;
  exec_status:    SubtaskStatus;
  job_id:         string | null;
  message_id:     string | null;
  result_excerpt: string | null;
  created_at:     string;
  updated_at:     string;
}

export interface BoardCard extends OrchestrationRequest {
  subtask_count:      number;
  subtask_done_count: number;
  agent_ids:          string[];
}

export type Board = Record<RequestStatus, BoardCard[]>;

export interface RequestDetail {
  request:  OrchestrationRequest;
  subtasks: OrchestrationSubtask[];
  messages: ChatMessage[];
}

type ActionResult = { ok: true } | { ok: false; error: string };

const STATUSES: RequestStatus[] = ['requested', 'hold', 'approved', 'ready', 'rejected', 'done', 'replanning'];

/** 상태 전환 로그 메시지(subtype 'status_change') 표기용 한글 라벨. */
const STATUS_LABEL: Record<RequestStatus, string> = {
  requested:  '요청중',
  hold:       '보류',
  approved:   '승인',
  ready:      '완료대기',
  rejected:   '반려',
  done:       '완료',
  replanning: '재기획',
};

function emptyBoard(): Board {
  return { requested: [], hold: [], approved: [], ready: [], rejected: [], done: [], replanning: [] };
}

let _counter = 0;
/** req_/sub_ id 생성 — agentChat.ts mkId() 미러(접두만 다름). */
function mkId(prefix: 'req' | 'sub'): string {
  _counter = (_counter + 1) % 1_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${_counter.toString(36)}${rand}`;
}

function normalizeStatus(v: unknown): RequestStatus {
  return STATUSES.includes(v as RequestStatus) ? (v as RequestStatus) : 'requested';
}

function normalizeRequest(r: Record<string, unknown>): OrchestrationRequest {
  return {
    id:                 String(r.id ?? ''),
    title:              r.title ? String(r.title) : null,
    nl_query:           String(r.nl_query ?? ''),
    status:             normalizeStatus(r.status),
    plan:               (r.plan as Plan | null) ?? null,
    plan_version:       typeof r.plan_version === 'number' ? r.plan_version : 1,
    plan_history:       Array.isArray(r.plan_history) ? (r.plan_history as Plan[]) : [],
    reject_reason:      r.reject_reason ? String(r.reject_reason) : null,
    replan_note:        r.replan_note ? String(r.replan_note) : null,
    feasible:           typeof r.feasible === 'boolean' ? r.feasible : null,
    feasibility_reason: r.feasibility_reason ? String(r.feasibility_reason) : null,
    worktree:           r.worktree ? String(r.worktree) : null,
    session_id:         r.session_id ? String(r.session_id) : null,
    created_by:         String(r.created_by ?? ''),
    created_at:         String(r.created_at ?? ''),
    updated_at:         String(r.updated_at ?? ''),
    decided_at:         r.decided_at ? String(r.decided_at) : null,
    decided_by:         r.decided_by ? String(r.decided_by) : null,
  };
}

function normalizeSubtask(r: Record<string, unknown>): OrchestrationSubtask {
  return {
    id:             String(r.id ?? ''),
    request_id:     String(r.request_id ?? ''),
    ordinal:        typeof r.ordinal === 'number' ? r.ordinal : 0,
    agent_id:       String(r.agent_id ?? ''),
    task:           String(r.task ?? ''),
    expected:       r.expected ? String(r.expected) : null,
    exec_status:    (r.exec_status as SubtaskStatus) ?? 'pending',
    job_id:         r.job_id ? String(r.job_id) : null,
    message_id:     r.message_id ? String(r.message_id) : null,
    result_excerpt: r.result_excerpt ? String(r.result_excerpt) : null,
    created_at:     String(r.created_at ?? ''),
    updated_at:     String(r.updated_at ?? ''),
  };
}

/**
 * agent_chat_jobs 에 kind/request_id/subtask_id 를 포함해 직접 insert.
 * agentChat.ts 의 enqueueJob() 은 이 3개 컬럼을 모르므로(채팅 전용) 여기서 별도 구현.
 */
async function insertOrchestrationJob(args: {
  sessionId:  string;
  messageId:  string;
  agentId:    string | null;
  prompt:     string;
  kind:       'orchestrate' | 'execute' | 'finalize';
  requestId:  string;
  subtaskId?: string | null;
}): Promise<string> {
  const db = getSupabase();
  const id = `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (!db) return id;
  await db.from('agent_chat_jobs').insert({
    id,
    session_id: args.sessionId,
    message_id: args.messageId,
    agent_id:   args.agentId,
    prompt:     args.prompt,
    status:     'pending',
    kind:       args.kind,
    request_id: args.requestId,
    subtask_id: args.subtaskId ?? null,
  });
  return id;
}

/**
 * agent_chat_messages 에 subtype 을 포함해 직접 insert(스레드 렌더 분기용).
 * agentChat.ts 의 insertUserMessage()/insertAssistantPlaceholder() 는 subtype 을 모르므로
 * (일반 채팅 전용) 여기서 별도 구현 — id 생성만 agentChat.mkId('msg') 로 공유.
 */
async function insertThreadMessage(args: {
  sessionId: string;
  role:      'user' | 'assistant' | 'system';
  subtype:   string | null;
  content:   string;
  agentId?:  string | null;
  streaming?: boolean;
}): Promise<string> {
  const db = getSupabase();
  const id = mkChatId('msg');
  if (!db) return id;
  await db.from('agent_chat_messages').insert({
    id,
    session_id: args.sessionId,
    role:       args.role,
    agent_id:   args.agentId ?? null,
    subtype:    args.subtype,
    content:    args.content,
    streaming:  args.streaming ?? false,
  });
  return id;
}

/** 상태 전환 로그(status_change) 메시지 append — 모든 전환에서 공통 호출. */
async function appendStatusChangeMessage(
  sessionId: string,
  newStatus: RequestStatus,
  decidedBy?: string,
): Promise<void> {
  await insertThreadMessage({
    sessionId,
    role:     'system',
    subtype:  'status_change',
    content:  `'${STATUS_LABEL[newStatus]}'으로 변경`,
    agentId:  decidedBy || 'system',
  });
}

/**
 * NL 질의 → 요청 카드 생성('requested') + 그룹핑 세션 + 원 요청 스레드 메시지
 * + 오케 기획 placeholder + orchestrate job enqueue.
 * title 은 사용자 입력(신규요청 모달 제목*) 그대로 저장 — 오케(AI)는 title 을 덮어쓰지 않고
 * plan.summary 로만 기획 요약을 남긴다.
 */
export async function createRequest(args: {
  title:     string;
  content:   string;
  createdBy: string;
}): Promise<{ ok: true; id: string; session_id: string } | { ok: false; error: string }> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  const title = args.title.trim();
  const content = args.content.trim();
  if (!title) return { ok: false, error: 'title 필수' };
  if (!content) return { ok: false, error: 'content 필수' };

  const id = mkId('req');
  // 그룹핑 세션(요청 스레드 + 오케스트레이션 대화 + 실행 대화가 모두 여기 쌓임, SSE tail 대상)
  const sessionId = await ensureSession(undefined, args.createdBy);

  const { error: insErr } = await db.from('orchestration_requests').insert({
    id,
    title,
    nl_query:   content,
    status:     'requested',
    session_id: sessionId,
    created_by: args.createdBy,
  });
  if (insErr) return { ok: false, error: insErr.message };

  // ① 원 요청 스레드 메시지(role user, subtype 'request') — 상세 스레드 최상단.
  await insertThreadMessage({
    sessionId,
    role:    'user',
    subtype: 'request',
    content,
  });

  // ② 오케 기획 placeholder(role assistant, subtype 'ai_plan') → orchestrate job 이 스트리밍으로 채움.
  // agent_chat_jobs 는 message_id/prompt/session_id NOT NULL → placeholder 먼저 생성.
  const messageId = await insertThreadMessage({
    sessionId,
    role:      'assistant',
    subtype:   'ai_plan',
    content:   '',
    streaming: true,
  });
  await insertOrchestrationJob({
    sessionId,
    messageId,
    agentId:   null,
    prompt:    content,
    kind:      'orchestrate',
    requestId: id,
  });

  return { ok: true, id, session_id: sessionId };
}

/** 상황판: 모든 요청을 status 별로 그룹 + 서브태스크 롤업(개수·완료수). */
export async function listBoard(): Promise<Board> {
  const db = getSupabase();
  if (!db) return emptyBoard();

  const { data: requests, error } = await db
    .from('orchestration_requests')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error || !Array.isArray(requests)) return emptyBoard();

  const { data: subtasks } = await db
    .from('orchestration_subtasks')
    .select('request_id, exec_status, agent_id, ordinal')
    .order('ordinal', { ascending: true });

  const rollup = new Map<string, { count: number; done: number; agents: string[] }>();
  for (const s of (subtasks ?? []) as Record<string, unknown>[]) {
    const rid = String(s.request_id ?? '');
    if (!rid) continue;
    const cur = rollup.get(rid) ?? { count: 0, done: 0, agents: [] };
    cur.count += 1;
    if (s.exec_status === 'done') cur.done += 1;
    const agent = s.agent_id ? String(s.agent_id) : '';
    if (agent && !cur.agents.includes(agent)) cur.agents.push(agent);
    rollup.set(rid, cur);
  }

  const board = emptyBoard();
  for (const row of requests as Record<string, unknown>[]) {
    const req  = normalizeRequest(row);
    const roll = rollup.get(req.id) ?? { count: 0, done: 0, agents: [] };
    board[req.status].push({
      ...req,
      subtask_count:      roll.count,
      subtask_done_count: roll.done,
      agent_ids:          roll.agents,
    });
  }
  return board;
}

/** 요청 상세: 카드 + 서브태스크 + 정렬된 스레드(연결된 세션의 대화, subtype 포함, created_at asc). */
export async function getRequestDetail(id: string): Promise<RequestDetail | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data: reqRow, error } = await db
    .from('orchestration_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !reqRow) return null;

  const request = normalizeRequest(reqRow as Record<string, unknown>);

  const { data: subRows } = await db
    .from('orchestration_subtasks')
    .select('*')
    .eq('request_id', id)
    .order('ordinal', { ascending: true });
  const subtasks = Array.isArray(subRows) ? subRows.map(r => normalizeSubtask(r as Record<string, unknown>)) : [];

  const messages = request.session_id ? await listMessages(request.session_id) : [];

  return { request, subtasks, messages };
}

/**
 * 승인: requested|hold → approved. 서브태스크마다 placeholder(subtype 'exec')+execute job enqueue → queued.
 *
 * 멱등화(REV 2026-07-07): status 전환을 **먼저** 가드 조건부 update(`.in('status', ['requested','hold'])`)로
 * 시도해 0행이면 즉시 실패 반환 — 이중 클릭·경합으로 두 번 enqueue 되는 것을 원천 차단한다.
 * 전환이 실제로 성공했을 때만 서브태스크 enqueue 로 진행하고, 그마저도 `exec_status==='pending'` 인
 * 서브태스크만 큐잉한다(재기획 후 살아남은 done/queued/running 서브태스크의 재실행 방지).
 */
export async function approveAndEnqueue(id: string, decidedBy?: string): Promise<ActionResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };

  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, error: '요청을 찾을 수 없음' };
  const { request, subtasks } = detail;

  if (request.status !== 'requested' && request.status !== 'hold') {
    return { ok: false, error: `승인은 요청중/보류 상태에서만 가능(현재: ${request.status})` };
  }
  if (!request.session_id) return { ok: false, error: '연결된 세션 없음' };
  if (subtasks.length === 0) return { ok: false, error: '서브태스크가 없어 승인할 수 없음' };

  // ① status 가드 전환을 먼저 — 성공(1행)해야만 아래에서 enqueue 진행. 실패(0행)면 즉시 반환.
  const now = new Date().toISOString();
  const { data, error } = await db.from('orchestration_requests')
    .update({ status: 'approved', decided_at: now, decided_by: decidedBy ?? null })
    .eq('id', id)
    .in('status', ['requested', 'hold'])
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '이미 상태가 바뀌어 승인 실패(경합)' };

  // ② pending 서브태스크만 enqueue — done/queued/running 은 이미 처리(또는 처리중)이므로 건너뜀.
  for (const st of subtasks) {
    if (st.exec_status !== 'pending') continue;
    const messageId = await insertThreadMessage({
      sessionId: request.session_id,
      role:      'assistant',
      subtype:   'exec',
      content:   '',
      streaming: true,
      agentId:   st.agent_id,
    });
    const jobId = await insertOrchestrationJob({
      sessionId: request.session_id,
      messageId,
      agentId:   st.agent_id,
      prompt:    st.task,
      kind:      'execute',
      requestId: id,
      subtaskId: st.id,
    });
    await db.from('orchestration_subtasks')
      .update({ exec_status: 'queued', job_id: jobId, message_id: messageId })
      .eq('id', st.id);
  }

  await appendStatusChangeMessage(request.session_id, 'approved', decidedBy);
  return { ok: true };
}

/** 보류: requested → hold(오케 기획이 기술적 불가/판단불가로 판정) + 보류 사유(subtype 'hold_reason') 필수. */
async function holdRequest(id: string, reason: string | undefined, decidedBy?: string): Promise<ActionResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  const trimmed = reason?.trim();
  if (!trimmed) return { ok: false, error: 'hold_reason(feasibility_reason) 필수' };

  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, error: '요청을 찾을 수 없음' };
  const { request } = detail;
  if (!request.session_id) return { ok: false, error: '연결된 세션 없음' };

  const now = new Date().toISOString();
  const { data, error } = await db.from('orchestration_requests')
    .update({
      status:             'hold',
      feasible:           false,
      feasibility_reason: trimmed,
      decided_at:         now,
      decided_by:         decidedBy ?? null,
    })
    .eq('id', id)
    .eq('status', 'requested')
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '보류는 요청중 상태에서만 가능(경합 또는 존재하지 않음)' };

  await appendStatusChangeMessage(request.session_id, 'hold', decidedBy);
  await insertThreadMessage({
    sessionId: request.session_id,
    role:      'assistant',
    subtype:   'hold_reason',
    content:   trimmed,
  });
  return { ok: true };
}

/** 반려: requested|hold|approved → rejected + 사유 필수(status_change 후 별도 assistant 메시지로 사유도 남김). */
async function rejectRequest(id: string, reason: string | undefined, decidedBy?: string): Promise<ActionResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  const trimmed = reason?.trim();
  if (!trimmed) return { ok: false, error: 'reject_reason 필수' };

  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, error: '요청을 찾을 수 없음' };
  const { request } = detail;

  const now = new Date().toISOString();
  const { data, error } = await db.from('orchestration_requests')
    .update({ status: 'rejected', reject_reason: trimmed, decided_at: now, decided_by: decidedBy ?? null })
    .eq('id', id)
    .in('status', ['requested', 'hold', 'approved'])
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '반려는 요청중/보류/승인 상태에서만 가능(경합 또는 존재하지 않음)' };

  if (request.session_id) {
    await appendStatusChangeMessage(request.session_id, 'rejected', decidedBy);
    // hold_reason 이 아닌 일반 assistant 메시지로 반려 사유를 별도로 남김(subtype 없음).
    await insertThreadMessage({
      sessionId: request.session_id,
      role:      'assistant',
      subtype:   null,
      content:   trimmed,
    });
  }
  return { ok: true };
}

/** 담당 에이전트 id → 사용자 친화 한글 단계명(완료 설명용). */
const DONE_ROLE_KO: Record<string, string> = {
  planner: '기획', architect: '설계', designer: '디자인', coder: '구현',
  tester: '테스트', 'security-reviewer': '보안 검토', verifier: '검증', devops: '배포',
};

/** result_excerpt 의 첫 문장(대략)만 뽑아 평문 한 줄로. */
function firstSentence(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.trim().replace(/\s+/g, ' ');
  const m = t.match(/^(.{0,140}?[.。!?])/);
  return (m ? m[1] : t.slice(0, 140)).trim();
}

/**
 * 완료 설명(subtype 'done_result') — 사용자가 "무슨 작업을 했는지" 쉽게 이해하도록 평문으로 구성.
 * 오케가 만든 쉬운 요약(plan.summary) + 단계별 담당이 실제로 한 일 + 결과물 위치(워크트리) + 다음 할 일.
 */
function buildDoneResultContent(request: OrchestrationRequest, subtasks: OrchestrationSubtask[]): string {
  const out: string[] = ['## ✅ 완료'];
  const what = request.plan?.summary || request.title || request.nl_query;
  if (what) out.push('', '**무엇을 했나요**', what);

  const done = subtasks.filter(s => s.exec_status === 'done');
  if (done.length) {
    out.push('', '**진행 내역**');
    for (const s of done) {
      const ko = DONE_ROLE_KO[s.agent_id] || s.agent_id;
      out.push(`- ${ko}: ${firstSentence(s.result_excerpt) || '완료'}`);
    }
  } else if (subtasks.length === 0) {
    out.push('', '요청하신 작업을 처리했습니다.');
  }

  if (request.worktree) {
    out.push('', '**결과물 위치**', `🌿 \`${request.worktree}\` 브랜치 — 아직 배포 전(라이브 반영 안 됨).`);
    out.push('', '**다음 할 일**', '코드 리뷰 → DB 마이그레이션 적용 → main 병합·배포하면 실제 사이트에 반영됩니다.');
  }
  return out.join('\n');
}

/**
 * 완료 처리: 완료대기(ready)에서 관리자가 결과를 검토하고 누른다.
 *  - 개발 요청(worktree 있음): 데몬에 finalize job 투입 → 커밋→push→배포(데몬이 수행).
 *    상태는 'ready' 유지(데몬이 배포 성공 시 'done' 으로 내림). 중복 클릭은 pending/running
 *    finalize job 존재 검사로 차단.
 *  - 비개발 요청(worktree 없음): 배포할 것이 없으므로 즉시 'done' + 완료 요약.
 * 하위호환: 구(舊) 'approved' 상태 카드도 완료 처리 허용(전환기 카드).
 */
async function completeRequest(id: string, decidedBy?: string): Promise<ActionResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };

  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, error: '요청을 찾을 수 없음' };
  const { request, subtasks } = detail;

  if (request.status !== 'ready' && request.status !== 'approved') {
    return { ok: false, error: `완료 처리는 완료대기 상태에서만 가능(현재: ${STATUS_LABEL[request.status]})` };
  }
  if (subtasks.length > 0 && !subtasks.every(s => s.exec_status === 'done')) {
    return { ok: false, error: '아직 끝나지 않은 하위작업이 있어 완료 처리할 수 없습니다.' };
  }

  const isDev = !!(request.worktree && request.worktree.trim());

  // ── 개발 요청: 배포 트리거(데몬 finalize job) ──
  if (isDev) {
    if (!request.session_id) return { ok: false, error: '연결된 세션 없음' };
    // 중복 배포 방지: 이미 대기/실행 중인 finalize job 이 있으면 거부.
    const { data: existing } = await db.from('agent_chat_jobs')
      .select('id').eq('request_id', id).eq('kind', 'finalize').in('status', ['pending', 'running']).limit(1);
    if (existing && existing.length > 0) return { ok: false, error: '이미 배포 처리 중입니다.' };

    const messageId = await insertThreadMessage({
      sessionId: request.session_id,
      role:      'assistant',
      subtype:   'status_change',
      content:   '🚀 배포 처리를 시작합니다…',
      streaming: true,
      agentId:   'system',
    });
    await insertOrchestrationJob({
      sessionId: request.session_id,
      messageId,
      agentId:   null,
      prompt:    'finalize-deploy',
      kind:      'finalize',
      requestId: id,
    });
    return { ok: true };
  }

  // ── 비개발 요청: 배포 없이 즉시 완료 ──
  const now = new Date().toISOString();
  const { data, error } = await db.from('orchestration_requests')
    .update({ status: 'done', decided_at: now, decided_by: decidedBy ?? null })
    .eq('id', id)
    .in('status', ['ready', 'approved'])
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '완료 처리 실패(경합 또는 이미 처리됨)' };

  if (request.session_id) {
    await appendStatusChangeMessage(request.session_id, 'done', decidedBy);
    await insertThreadMessage({
      sessionId: request.session_id,
      role:      'assistant',
      subtype:   'done_result',
      content:   buildDoneResultContent(request, subtasks),
    });
  }
  return { ok: true };
}

/**
 * 재기획: requested|hold → replanning. 완료(done)·반려(rejected)·승인(approved)·재기획중은 제외
 * (2026-07-09 사용자 요청: 완료·반려 카드는 재기획 불가). 현재 plan → plan_history 스냅샷, plan_version++,
 * 미실행(pending/queued) 서브태스크 삭제, 새 placeholder(subtype 'ai_plan')+orchestrate job enqueue(note 포함).
 */
export async function replan(id: string, note: string | undefined, decidedBy?: string): Promise<ActionResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };
  const trimmed = note?.trim();
  if (!trimmed) return { ok: false, error: 'replan_note 필수' };

  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, error: '요청을 찾을 수 없음' };
  const { request, subtasks } = detail;

  // 재기획 허용 상태: 요청중·보류만 — 완료(done)·반려(rejected)는 재기획 불가(사용자 요청 2026-07-09).
  const REPLANNABLE: RequestStatus[] = ['requested', 'hold'];
  if (!REPLANNABLE.includes(request.status)) {
    return { ok: false, error: `재기획은 요청중/보류 상태에서만 가능(현재: ${request.status})` };
  }
  if (!request.session_id) return { ok: false, error: '연결된 세션 없음' };

  const history = request.plan ? [...request.plan_history, request.plan] : request.plan_history;

  const toDelete = subtasks.filter(s => s.exec_status === 'pending' || s.exec_status === 'queued').map(s => s.id);
  if (toDelete.length) {
    await db.from('orchestration_subtasks').delete().in('id', toDelete);
  }

  const messageId = await insertThreadMessage({
    sessionId: request.session_id,
    role:      'assistant',
    subtype:   'ai_plan',
    content:   '',
    streaming: true,
  });
  await insertOrchestrationJob({
    sessionId: request.session_id,
    messageId,
    agentId:   null,
    prompt:    `[재기획 보강지시] ${trimmed}\n\n원 질의: ${request.nl_query}`,
    kind:      'orchestrate',
    requestId: id,
  });

  const now = new Date().toISOString();
  const { data, error } = await db.from('orchestration_requests')
    .update({
      status:       'replanning',
      replan_note:  trimmed,
      plan_version: request.plan_version + 1,
      plan_history: history,
      decided_at:   now,
      decided_by:   decidedBy ?? null,
    })
    .eq('id', id)
    .in('status', REPLANNABLE)
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '재기획 실패(경합 또는 재기획 불가 상태)' };

  await appendStatusChangeMessage(request.session_id, 'replanning', decidedBy);
  return { ok: true };
}

/**
 * 재기획 완료(수동 재진입): replanning → requested. 러너(agent-runner)가 재분해 성공 시
 * 자동으로 requested 로 되돌리지만, 그 orchestrate 잡이 실패·중단되면 카드가 'replanning' 에
 * 영구 고착(데드엔드)된다. 이 액션은 관리자가 그 고착을 수동으로 푸는 복구 경로다
 * (별도 사유·재분해 없이 상태만 요청중으로 되돌림 — 이후 재승인 또는 재기획 가능).
 */
async function resumeRequest(id: string, decidedBy?: string): Promise<ActionResult> {
  const db = getSupabase();
  if (!db) return { ok: false, error: 'Supabase 미연결' };

  const detail = await getRequestDetail(id);
  if (!detail) return { ok: false, error: '요청을 찾을 수 없음' };
  const { request } = detail;
  if (!request.session_id) return { ok: false, error: '연결된 세션 없음' };

  const now = new Date().toISOString();
  const { data, error } = await db.from('orchestration_requests')
    .update({ status: 'requested', decided_at: now, decided_by: decidedBy ?? null })
    .eq('id', id)
    .eq('status', 'replanning')
    .select();
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: '재기획 완료는 재기획 상태에서만 가능(경합 또는 존재하지 않음)' };

  await appendStatusChangeMessage(request.session_id, 'requested', decidedBy);
  return { ok: true };
}

/** 서브태스크 중 실행 중(queued|running)이 하나라도 있으면 true — 관리자 상태변경 잠금 판정용. */
async function hasInflightSubtask(id: string): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { data } = await db.from('orchestration_subtasks')
    .select('id')
    .eq('request_id', id)
    .in('exec_status', ['queued', 'running'])
    .limit(1);
  return !!data && data.length > 0;
}

/**
 * 처리 안 끝난 job(pending|running)이 하나라도 있으면 true — 관리자 상태변경 잠금 판정용.
 * 서브태스크가 아직 없는 **기획(orchestrate)·재기획 재분해** 단계와 **배포(finalize)** 단계까지
 * 포괄한다(서브태스크 큐/실행 검사만으로는 이 구간을 놓친다). 데몬은 실행 시작 시 job 을 'running'
 * 으로, 완료 시 'done'/'error' 로 내리므로, 이 값이 곧 "지금 데몬이 이 요청을 처리 중"과 같다.
 * 좀비 job(크래시)은 reaper 가 'pending' 으로 되돌리므로 여전히 활성으로 잡히고, 실패 job 은
 * 'error' 로 내려가 비활성이 되어 재기획완료(resume) 복구 경로를 막지 않는다.
 */
async function hasActiveJob(id: string): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { data } = await db.from('agent_chat_jobs')
    .select('id')
    .eq('request_id', id)
    .in('status', ['pending', 'running'])
    .limit(1);
  return !!data && data.length > 0;
}

/**
 * 상태머신 진입점. 불법 전이는 {ok:false} 반환(카드 상태는 미변경).
 *
 * 진행중 잠금(2026-07-09): 이 요청을 데몬이 처리 중이면(활성 job pending|running, 또는 서브태스크
 * queued|running) 어떤 관리자 액션도 거부한다 — 기획(분해)·재기획 재분해·실행·배포 어느 단계든
 * 진행 중 상태를 중간에 바꿔 실행/결과와 상태가 어긋나는 것을 막는다. 서브태스크가 아직 없는
 * 분해 단계는 활성 job 검사가 잡고, job 이 이미 'done'이고 서브태스크만 정리 중인 짧은 창은
 * 서브태스크 검사가 잡는다(둘을 OR).
 * approve 는 분해 완료 후 job='done'·서브태스크 pending 이라 통과하고, complete 는 활성 job 없이
 * 전부 done 이라 통과한다. 러너(agent-runner)는 이 함수를 경유하지 않고 DB 를 직접 patch 하므로
 * 잠금의 영향을 받지 않는다.
 */
export async function transition(
  id: string,
  action: TransitionAction,
  payload: { reject_reason?: string; replan_note?: string; hold_reason?: string; decided_by?: string } = {},
): Promise<ActionResult> {
  if (await hasActiveJob(id) || await hasInflightSubtask(id)) {
    return { ok: false, error: '진행 중에는 상태를 변경할 수 없습니다. 작업이 끝난 뒤 다시 시도하세요.' };
  }
  switch (action) {
    case 'approve':  return approveAndEnqueue(id, payload.decided_by);
    case 'hold':     return holdRequest(id, payload.hold_reason, payload.decided_by);
    case 'reject':   return rejectRequest(id, payload.reject_reason, payload.decided_by);
    case 'complete': return completeRequest(id, payload.decided_by);
    case 'replan':   return replan(id, payload.replan_note, payload.decided_by);
    case 'resume':   return resumeRequest(id, payload.decided_by);
    default:         return { ok: false, error: `알 수 없는 action: ${String(action)}` };
  }
}
