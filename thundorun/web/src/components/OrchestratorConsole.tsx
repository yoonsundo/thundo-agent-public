/**
 * OrchestratorConsole.tsx — 관리자 오케스트레이션 콘솔 (클라이언트)
 *
 * 3화면:
 *   A) 목록(board)      — 상태 세그먼트 필터 + 표. 행 클릭 -> 화면 C.
 *   B) 새 요청 다이얼로그 — 제목*+내용 -> POST /api/admin/orchestrator.
 *   C) 아이디어 대화 다이얼로그 — 상태전환(확인 다이얼로그 경유) + subtype 별 스레드 + 실행 SSE 실시간 반영.
 *
 * 서버 계약(이미 구현):
 *   GET  /api/admin/orchestrator                    -> { board }
 *   POST /api/admin/orchestrator {title,content}    -> { ok, id, session_id }
 *   GET  /api/admin/orchestrator/[id]               -> { request, subtasks, messages }
 *   POST /api/admin/orchestrator/[id]/transition    -> { ok } | { ok:false, error }
 *   GET  /api/admin/agent-chat/stream?session_id=…  -> SSE(delta/done/error) — 실행 대화 tail 재사용.
 *
 * UI 는 Modernist Kit 만 사용한다(DESIGN.md).
 *  · 목록 §5 — `.page-head` -> `.seg`(상태 필터) -> `.table`(`.table-scroll`)
 *  · 되돌릴 수 없는 액션은 §4.13 `.dialog[role=dialog][aria-modal=true]` 확인 절차
 *  · 상태 배지 §4.5 `.tag`(완료=success·처리중=info·대기=warning·취소=danger 고정)
 *  · 스레드 §11.5 `.chat-log` + `.bubble`, 진행률 `.progress`
 *  · 이모지 금지(§규칙 8) — 아이콘은 lucide, 에이전트는 이름 태그로 표시
 */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, GitBranch, Plus, X } from 'lucide-react';
import AssistantMarkdown from './AssistantMarkdown';
import ConfirmDialog, { useDialogFocus } from '@/app/admin/ConfirmDialog';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import Loading from '@/components/state/Loading';
import { TableSkeleton } from '@/components/state/Skeleton';

// ─── 타입(서버 orchestration.ts 미러) ─────────────────────────────────────────
type RequestStatus = 'requested' | 'hold' | 'approved' | 'ready' | 'rejected' | 'done' | 'replanning';
type SubtaskStatus = 'pending' | 'queued' | 'running' | 'done' | 'error';
type TransitionAction = 'approve' | 'hold' | 'reject' | 'replan' | 'complete' | 'resume';

interface OrchestrationRequest {
  id:            string;
  title:         string | null;
  nl_query:      string;
  status:        RequestStatus;
  worktree:      string | null;
  session_id:    string | null;
  created_by:    string;
  created_at:    string;
  updated_at:    string;
}

interface OrchestrationSubtask {
  id:             string;
  request_id:     string;
  ordinal:        number;
  agent_id:       string;
  task:           string;
  expected:       string | null;
  exec_status:    SubtaskStatus;
  result_excerpt: string | null;
}

interface BoardCard extends OrchestrationRequest {
  subtask_count:      number;
  subtask_done_count: number;
  agent_ids:          string[];
}

type Board = Record<RequestStatus, BoardCard[]>;

interface ThreadMessage {
  id:         string;
  session_id: string;
  role:       'user' | 'assistant' | 'system';
  agent_id:   string | null;
  subtype:    string | null;
  content:    string;
  streaming:  boolean;
  status:     'ok' | 'error';
  error:      string | null;
  created_at: string;
}

interface RequestDetail {
  request:  OrchestrationRequest;
  subtasks: OrchestrationSubtask[];
  messages: ThreadMessage[];
}

// ─── 상수·라벨 ────────────────────────────────────────────────────────────────
const STATUS_LABEL: Record<RequestStatus, string> = {
  requested: '요청중', hold: '보류', approved: '승인', ready: '완료대기',
  rejected: '반려', done: '완료', replanning: '재기획',
};

/** 목록 표시 순서. */
const BOARD_ORDER: RequestStatus[] = ['requested', 'hold', 'approved', 'ready', 'replanning', 'done', 'rejected'];

/**
 * 상태 -> 태그 톤. DESIGN.md §4.5 의 고정 매핑만 쓴다
 * (완료=success · 처리중=info · 대기=warning · 취소=danger).
 */
const STATUS_TONE: Record<RequestStatus, string> = {
  requested:  'tag-info',
  hold:       'tag-warning',
  approved:   'tag-info',
  ready:      'tag-info',
  done:       'tag-success',
  rejected:   'tag-danger',
  replanning: 'tag-warning',
};

const SUBTASK_STATUS_LABEL: Record<SubtaskStatus, string> = {
  pending: '대기', queued: '큐', running: '실행중', done: '완료', error: '오류',
};

const SUBTASK_TONE: Record<SubtaskStatus, string> = {
  pending: 'tag-warning',
  queued:  'tag-warning',
  running: 'tag-info',
  done:    'tag-success',
  error:   'tag-danger',
};

/** 전환 액션별 허용 원본 상태(완료는 추가로 전 서브태스크 done 요구). */
const ACTION_FROM: Record<TransitionAction, RequestStatus[]> = {
  approve:  ['requested', 'hold'],
  hold:     ['requested'],
  reject:   ['requested', 'hold', 'approved'],
  // 재기획은 요청중·보류에서만 — 완료(done)·반려(rejected) 카드에서는 비활성(사용자 요청 2026-07-09).
  replan:   ['requested', 'hold'],
  complete: ['ready', 'approved'],
  resume:   ['replanning'],
};

function fmtTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type LoadState = 'loading' | 'ready' | 'error';

// ─── 상태 배지 ────────────────────────────────────────────────────────────────
function StatusTag({ status }: { status: RequestStatus }) {
  return <span className={['tag', STATUS_TONE[status]].join(' ')}>{STATUS_LABEL[status]}</span>;
}

// ─── 공용 다이얼로그 껍데기 (§4.13) ───────────────────────────────────────────
function Dialog({
  children, onClose, label, width, tall,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  width: number;
  tall?: boolean;
}) {
  // ESC 로 닫기 · Tab 포커스 트랩 · 닫을 때 트리거로 포커스 복귀(§8).
  // 확인 다이얼로그(ConfirmDialog)와 같은 훅을 써서 접근성 계약을 한 곳에 모은다.
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={tall ? { width: `min(${width}px, 100%)`, height: '85vh' } : { width: `min(${width}px, 100%)`, maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// ─── 화면 B: 새 요청 다이얼로그 ───────────────────────────────────────────────
function NewRequestDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle]     = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const submit = useCallback(async () => {
    const t = title.trim();
    if (!t) { setError('제목을 입력하세요.'); return; }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/orchestrator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t, content: content.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `요청 실패 (HTTP ${res.status})`);
        setBusy(false);
        return;
      }
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }, [title, content, busy, onCreated]);

  return (
    <Dialog onClose={onClose} label="새 요청" width={560}>
      <span className="dialog-title">새 요청</span>

      {error && (
        <div className="banner" data-tone="danger" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="field" data-invalid={!!error && !title.trim()}>
        <label htmlFor="orch-title">제목<span className="req">*</span></label>
        <input
          id="orch-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="요청 제목"
          autoFocus
        />
      </div>

      <div className="field">
        <label htmlFor="orch-content">내용</label>
        <textarea
          id="orch-content"
          className="input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="요청 내용을 적어주세요…"
          rows={6}
        />
        {/*
         * 보안 각주: 완료 메시지는 AssistantMarkdown(react-markdown, rehype-raw 미사용)으로
         * 렌더한다 — raw HTML 은 이스케이프되어 텍스트로 표시되므로 XSS-safe. 스트리밍 중엔 평문.
         * 어떤 경우에도 dangerouslySetInnerHTML/rehype-raw 를 쓰지 말 것(XSS 회귀 방지).
         */}
        <span className="field-hint">일반 텍스트로 전송됩니다. HTML 은 이스케이프되어 그대로 보입니다.</span>
      </div>

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>취소</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={busy || !title.trim()}
        >
          {busy && <span className="spinner" />}
          {busy ? '요청 중…' : '심사 요청'}
        </button>
      </div>
    </Dialog>
  );
}

// ─── 스레드 메시지 렌더 (subtype 별) ──────────────────────────────────────────
function StreamText({ content, streaming }: { content: string; streaming: boolean }) {
  if (!content) {
    return <Loading label="응답 대기 중…" />;
  }
  // 스트리밍 중엔 평문(빠른 갱신), 완료되면 마크다운 렌더(AgentChat 과 동일 공용 렌더러 —
  // rehype-raw 미사용이라 raw HTML 은 이스케이프됨, dangerouslySetInnerHTML 없음).
  if (streaming) {
    return (
      <>
        <p>{content}</p>
        <p className="card-meta" role="status" aria-live="polite">
          <span className="spinner" />
          응답 중…
        </p>
      </>
    );
  }
  return <AssistantMarkdown content={content} />;
}

/** 에이전트 말풍선 — 머리글(이름·시각) + 본문. */
function AgentBubble({
  header, children,
}: {
  header: string;
  children: React.ReactNode;
}) {
  return (
    <div className="stack-2">
      <span className="kicker">{header}</span>
      <div className="bubble bubble-agent">{children}</div>
    </div>
  );
}

function ThreadItem({
  msg, request, subtasks,
}: {
  msg: ThreadMessage;
  request: OrchestrationRequest;
  subtasks: OrchestrationSubtask[];
}) {
  // request -> 사용자 말풍선
  if (msg.subtype === 'request') {
    return (
      <div className="bubble bubble-user">
        <span className="card-meta">{request.created_by} · {fmtTime(msg.created_at)}</span>
        {request.title && <b>{request.title}</b>}
        <p>{msg.content}</p>
      </div>
    );
  }

  // status_change -> 시스템 이벤트(muted 메타 줄)
  if (msg.subtype === 'status_change') {
    const who = msg.agent_id === 'system' || !msg.agent_id ? 'AI/시스템' : `관리자(${msg.agent_id})`;
    return <p className="card-meta">{who} · {msg.content}</p>;
  }

  // ai_plan -> AI 말풍선 + subtasks 목록
  if (msg.subtype === 'ai_plan') {
    return (
      <AgentBubble header={`AI/시스템 · ${fmtTime(msg.created_at)}`}>
        <StreamText content={msg.content} streaming={msg.streaming} />
        {subtasks.length > 0 && (
          <div className="list">
            {subtasks.map((st) => (
              <div className="list-row" key={st.id}>
                <span className="tag tag-neutral">{st.agent_id}</span>
                <span style={{ flex: 1 }}>{st.task}</span>
                <span className={['tag', SUBTASK_TONE[st.exec_status]].join(' ')}>
                  {SUBTASK_STATUS_LABEL[st.exec_status]}
                </span>
              </div>
            ))}
          </div>
        )}
      </AgentBubble>
    );
  }

  // hold_reason -> 경고 배너
  if (msg.subtype === 'hold_reason') {
    return (
      <div className="banner" data-tone="warning">
        <span>
          <b>AI/시스템 · 보류 사유</b>
          <br />
          {msg.content}
        </span>
      </div>
    );
  }

  // exec -> 담당 에이전트 실행 스트림
  if (msg.subtype === 'exec') {
    return (
      <AgentBubble header={`${msg.agent_id ?? '에이전트'} · 실행`}>
        {msg.status === 'error' || msg.error ? (
          <div className="banner" data-tone="danger" role="alert">
            <span>
              <b>실행 오류</b>
              <br />
              {msg.error ?? '알 수 없는 오류'}
            </span>
          </div>
        ) : (
          <StreamText content={msg.content} streaming={msg.streaming} />
        )}
      </AgentBubble>
    );
  }

  // done_result -> 완료 결과 분석
  if (msg.subtype === 'done_result') {
    return (
      <AgentBubble header="완료 결과">
        <StreamText content={msg.content} streaming={msg.streaming} />
      </AgentBubble>
    );
  }

  // null -> 일반 말풍선
  if (msg.role === 'user') {
    return (
      <div className="bubble bubble-user">
        <p>{msg.content}</p>
      </div>
    );
  }
  return (
    <AgentBubble header={`AI/시스템 · ${fmtTime(msg.created_at)}`}>
      <StreamText content={msg.content} streaming={msg.streaming} />
    </AgentBubble>
  );
}

// ─── 화면 C: 아이디어 대화 다이얼로그 ────────────────────────────────────────
interface ActionForm {
  action: 'reject' | 'replan' | 'hold';
  label: string;
  placeholder: string;
  field: string;
  /** 파괴적 액션(반려)은 실행 버튼을 `.btn-danger` 로. */
  destructive?: boolean;
}

const ACTION_FORMS: Record<'reject' | 'replan' | 'hold', ActionForm> = {
  reject: { action: 'reject', label: '반려 사유', placeholder: '반려 사유를 입력하세요…', field: 'reject_reason', destructive: true },
  replan: { action: 'replan', label: '보강 지시', placeholder: '재기획 보강 지시를 입력하세요…', field: 'replan_note' },
  hold:   { action: 'hold',   label: '보류 사유', placeholder: '보류 사유를 입력하세요…', field: 'hold_reason' },
};

/** 확인만 필요한(입력 없는) 전환. */
const CONFIRM_COPY: Record<'approve' | 'complete' | 'resume', { title: string; body: string; cta: string }> = {
  approve:  { title: '이 요청을 승인할까요?', body: '승인하면 서브태스크가 큐에 올라가 실행이 시작됩니다.', cta: '승인' },
  complete: { title: '완료 처리할까요?', body: '완료 처리하면 이 요청은 종료 상태가 됩니다.', cta: '완료 처리' },
  resume:   { title: '재기획을 마칠까요?', body: '요청중 상태로 되돌려 다시 심사할 수 있게 합니다.', cta: '재기획 완료' },
};

function DetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail]   = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [form, setForm]       = useState<ActionForm | null>(null);
  const [formText, setFormText] = useState('');
  const [confirm, setConfirm] = useState<'approve' | 'complete' | 'resume' | null>(null);

  const sseRef             = useRef<EventSource | null>(null);
  const reconnectRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef          = useRef<HTMLDivElement>(null);
  const sessionIdRef       = useRef<string | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const loadDetail = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/orchestrator/${encodeURIComponent(id)}`);
      if (!res.ok) { setError(`상세 로드 실패 (HTTP ${res.status})`); return; }
      const data = (await res.json()) as RequestDetail;
      setDetail(data);
      sessionIdRef.current = data.request.session_id;
      setTimeout(scrollToBottom, 30);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, scrollToBottom]);

  // ── SSE: 실행/기획 스트림 tail (delta = 절대 content) ────────────────────────
  const closeSSE = useCallback(() => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
  }, []);

  const openStream = useCallback((sessionId: string) => {
    closeSSE();
    const connect = () => {
      if (sessionIdRef.current !== sessionId) return;
      const es = new EventSource(`/api/admin/agent-chat/stream?session_id=${encodeURIComponent(sessionId)}`);
      sseRef.current = es;

      es.addEventListener('delta', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data as string) as { message_id: string; content: string; streaming: boolean };
          let known = false;
          setDetail((prev) => {
            if (!prev) return prev;
            const messages = prev.messages.map((m) => {
              if (m.id !== d.message_id) return m;
              known = true;
              return { ...m, content: d.content, streaming: d.streaming };
            });
            return { ...prev, messages };
          });
          // 로드 이후 서버가 새로 만든 placeholder(exec 등) → 상세 재조회로 편입.
          if (!known) void loadDetail();
          scrollToBottom();
        } catch { /* 무시 */ }
      });

      es.addEventListener('done', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data as string) as { message_id: string; status: string; error?: string };
          setDetail((prev) => {
            if (!prev) return prev;
            const messages = prev.messages.map((m) =>
              m.id === d.message_id
                ? { ...m, streaming: false, status: d.status === 'error' ? 'error' as const : 'ok' as const, error: d.error ?? m.error }
                : m,
            );
            return { ...prev, messages };
          });
          // 서브태스크 exec_status·결과 갱신 반영.
          void loadDetail();
        } catch { /* 무시 */ }
      });

      es.onerror = () => {
        if (sseRef.current !== es) return;
        es.close();
        sseRef.current = null;
        // 스트리밍 진행 중이면 재연결(서버 SSE ~55s 종료 설계).
        reconnectRef.current = setTimeout(connect, 3000);
      };
    };
    connect();
  }, [closeSSE, loadDetail, scrollToBottom]);

  useEffect(() => {
    // 최초 상세 로드(비동기 — setState 는 await 이후) + 언마운트 시 SSE 정리.
    void loadDetail(); // eslint-disable-line react-hooks/set-state-in-effect
    return () => closeSSE();
  }, [loadDetail, closeSSE]);

  // 세션 확보되면 스트림 구독(기획·실행 스트림이 이 세션에 쌓임).
  useEffect(() => {
    const sid = detail?.request.session_id ?? null;
    if (sid) openStream(sid);
    return () => closeSSE();
  }, [detail?.request.session_id, openStream, closeSSE]);

  // ── 전환 실행 ────────────────────────────────────────────────────────────────
  const runTransition = useCallback(async (action: TransitionAction, payload: Record<string, string> = {}) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/orchestrator/${encodeURIComponent(id)}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `전환 실패 (HTTP ${res.status})`);
        return;
      }
      setForm(null);
      setFormText('');
      setConfirm(null);
      await loadDetail();  // 새 status_change/exec/plan 메시지 편입
      onChanged();         // 배경 목록 갱신
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, id, loadDetail, onChanged]);

  const submitForm = useCallback(() => {
    if (!form) return;
    const v = formText.trim();
    if (!v) { setError(`${form.label}을(를) 입력하세요.`); return; }
    void runTransition(form.action, { [form.field]: v });
  }, [form, formText, runTransition]);

  const status = detail?.request.status;
  const allSubtasksDone = !!detail && detail.subtasks.length > 0
    && detail.subtasks.every((s) => s.exec_status === 'done');
  // 진행 중: 상태 변경을 잠근다(서버 transition() 도 동일 잠금).
  //  · 스트리밍 메시지 존재 → 기획(분해)·재기획 재분해·배포(finalize) 단계(서브태스크가 아직 없어도 잡힘)
  //  · 서브태스크 queued|running → 실행 단계
  // 데몬이 완료하면 스트림이 멈추고 서브태스크가 done 으로 내려가 자동 해제된다.
  const inProgress = !!detail && (
    detail.messages.some((m) => m.streaming)
    || detail.subtasks.some((s) => s.exec_status === 'queued' || s.exec_status === 'running')
  );

  function canDo(action: TransitionAction): boolean {
    if (!status) return false;
    // 진행 중이면 어떤 전환도 불가 — 기획·실행·배포 중인 작업의 상태를 중간에 바꾸지 못하게 한다.
    if (inProgress) return false;
    if (!ACTION_FROM[action].includes(status)) return false;
    if (action === 'complete') return allSubtasksDone;
    // 보류(hold) 카드는 오케 기획이 "기술적 불가/판단불가"로 내린 판정 — subtasks 가 0개면
    // 서버 approveAndEnqueue 가 어차피 거부하므로, 무효 클릭 자체를 막아 에러를 예방한다.
    // subtasks 가 있는 hold(오케가 그래도 실행안을 만든 경우)나 requested 상태는 정상 허용.
    if (action === 'approve' && status === 'hold' && (detail?.subtasks.length ?? 0) === 0) return false;
    return true;
  }

  // recovery: 복구용 액션 — targetStatus 가 흔한 상태(requested)와 겹쳐도 '(현재)' 표기를 하지 않는다.
  const BUTTONS: Array<{ action: TransitionAction; label: string; targetStatus: RequestStatus; recovery?: boolean }> = [
    { action: 'approve',  label: '승인',      targetStatus: 'approved' },
    { action: 'hold',     label: '보류',      targetStatus: 'hold' },
    { action: 'reject',   label: '반려',      targetStatus: 'rejected' },
    { action: 'replan',   label: '재기획',    targetStatus: 'replanning' },
    { action: 'resume',   label: '재기획 완료', targetStatus: 'requested', recovery: true },
    { action: 'complete', label: '완료 처리', targetStatus: 'done' },
  ];

  function onButton(action: TransitionAction) {
    setError(null);
    if (action === 'approve' || action === 'complete' || action === 'resume') {
      // 되돌릴 수 없는 액션 — 확인 다이얼로그를 한 번 거친다(§4.13).
      setConfirm(action);
    } else {
      setForm(ACTION_FORMS[action]);
      setFormText('');
    }
  }

  const doneCount = detail?.subtasks.filter((s) => s.exec_status === 'done').length ?? 0;
  const totalCount = detail?.subtasks.length ?? 0;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <>
      <Dialog onClose={onClose} label="아이디어 대화" width={880} tall>
        {/* 머리글 */}
        {/* 좁은 폭(390px)에선 이 행이 줄바꿈된다 — 브랜치명은 말줄임으로 잘라
            다이얼로그 폭을 밀지 않게 한다(전체 값은 title 속성으로 남긴다). */}
        <div className="row dialog-head">
          <span className="dialog-title">아이디어 대화</span>
          {status && <StatusTag status={status} />}
          {detail?.request.worktree && (
            <span className="tag tag-neutral text-mono" title={detail.request.worktree}>
              <GitBranch size={16} />
              <span className="text-ellipsis">{detail.request.worktree}</span>
            </span>
          )}
          <div className="spacer" />
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="닫기">
            <X size={20} />
          </button>
        </div>

        {/* 진행률 */}
        {totalCount > 0 && (
          <div className="stack-2">
            <div className="card-meta">
              서브태스크 {doneCount}/{totalCount}
              {inProgress && <span className="tag tag-info">진행 중 — 상태 변경 잠금</span>}
            </div>
            <div className="progress" data-tone={pct === 100 ? 'success' : undefined}>
              <span style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        {/* 상태 변경 */}
        <div className="toolbar">
          {BUTTONS.map((b) => {
            const isCurrent = !b.recovery && status === b.targetStatus;
            const enabled = canDo(b.action) && !busy;
            const destructive = b.action === 'reject';
            return (
              <button
                key={b.action}
                type="button"
                className={['btn', destructive ? 'btn-danger' : 'btn-secondary', 'btn-sm'].join(' ')}
                onClick={() => onButton(b.action)}
                disabled={!enabled}
                aria-current={isCurrent ? 'true' : undefined}
              >
                {b.label}{isCurrent ? ' (현재)' : ''}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="banner" data-tone="danger" role="alert">
            <span>{error}</span>
          </div>
        )}

        {/* 스레드 */}
        <div ref={scrollRef} className="chat-log scroll-y">
          {loading ? (
            <Loading label="대화를 불러오는 중…" />
          ) : !detail ? (
            <ErrorState title="상세를 불러올 수 없습니다" onRetry={() => void loadDetail()} />
          ) : detail.messages.length === 0 ? (
            <Empty title="대화 내역이 없습니다" body="상태를 바꾸면 기획·실행 기록이 이 자리에 쌓입니다." />
          ) : (
            detail.messages.map((m) => (
              <ThreadItem key={m.id} msg={m} request={detail.request} subtasks={detail.subtasks} />
            ))
          )}
        </div>

        {/* 메시지 입력 — 후속 메시지용 오케 전용 엔드포인트가 없어 v1은 비활성(안내만) */}
        <div className="chat-composer">
          <textarea
            className="input"
            disabled
            rows={1}
            aria-label="메시지"
            placeholder="후속 메시지는 다음 버전에서 지원합니다"
            style={{ minHeight: 36, maxHeight: 96 }}
          />
          <button type="button" className="btn btn-secondary" disabled>전송</button>
        </div>
      </Dialog>

      {/* 입력이 필요한 전환(반려·재기획·보류) — 사유 확인 다이얼로그 */}
      {form && (
        <ConfirmDialog
          title={form.label}
          body={
            form.destructive
              ? '반려하면 이 요청은 더 진행되지 않습니다. 사유는 스레드에 남습니다.'
              : '입력한 내용은 스레드에 기록되어 다음 단계의 근거가 됩니다.'
          }
          confirmLabel={busy ? '처리 중…' : '확정'}
          cancelLabel="취소"
          tone={form.destructive ? 'danger' : 'primary'}
          busy={busy}
          confirmDisabled={!formText.trim()}
          width={520}
          onConfirm={submitForm}
          onClose={() => { setForm(null); setFormText(''); setError(null); }}
        >
          <div className="field" data-invalid={!!error && !formText.trim()}>
            <label htmlFor="orch-form-text">{form.label}<span className="req">*</span></label>
            <textarea
              id="orch-form-text"
              className="input"
              value={formText}
              onChange={(e) => setFormText(e.target.value)}
              placeholder={form.placeholder}
              rows={4}
              autoFocus
            />
          </div>
          {error && (
            <div className="banner" data-tone="danger" role="alert">
              <span>{error}</span>
            </div>
          )}
        </ConfirmDialog>
      )}

      {/* 입력이 없는 전환(승인·완료·재기획완료) — 되돌릴 수 없어 확인 절차 */}
      {confirm && (
        <ConfirmDialog
          title={CONFIRM_COPY[confirm].title}
          body={CONFIRM_COPY[confirm].body}
          confirmLabel={CONFIRM_COPY[confirm].cta}
          cancelLabel="취소"
          tone="primary"
          busy={busy}
          onConfirm={() => void runTransition(confirm)}
          onClose={() => setConfirm(null)}
        >
          {error && (
            <div className="banner" data-tone="danger" role="alert">
              <span>{error}</span>
            </div>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

// ─── 메인: 요청 목록 ──────────────────────────────────────────────────────────
type Filter = 'all' | RequestStatus;

export default function OrchestratorConsole() {
  const [board, setBoard]       = useState<Board | null>(null);
  const [state, setState]       = useState<LoadState>('loading');
  const [showNew, setShowNew]   = useState(false);
  const [openId, setOpenId]     = useState<string | null>(null);
  const [filter, setFilter]     = useState<Filter>('all');

  const loadBoard = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/orchestrator');
      if (!res.ok) { setState('error'); return; }
      const data = (await res.json()) as { board: Board };
      setBoard(data.board);
      setState('ready');
    } catch { setState('error'); }
  }, []);

  // 최초 목록 로드(비동기 — setState 는 await 이후).
  useEffect(() => { void loadBoard(); }, [loadBoard]); // eslint-disable-line react-hooks/set-state-in-effect

  const countOf = (s: RequestStatus) => board?.[s]?.length ?? 0;
  const totalCards = board ? BOARD_ORDER.reduce((n, s) => n + countOf(s), 0) : 0;

  const rows: BoardCard[] = board
    ? (filter === 'all' ? BOARD_ORDER : [filter])
        .flatMap((s) => board[s] ?? [])
        .sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at))
    : [];

  // 빈 상태가 뜨면 그 화면의 유일한 primary 는 빈 상태의 액션이다(§4.4·§4.14) —
  // 같은 '새 요청' 이 머리글에도 있으므로 이때는 머리글 쪽을 secondary 로 내린다.
  const isEmpty = state === 'ready' && totalCards === 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">오케스트레이션 콘솔</h1>
          <p className="page-sub">총 {totalCards}건</p>
        </div>
        <div className="page-actions">
          <a className="btn btn-secondary" href="/admin">
            <ArrowLeft size={16} />
            대시보드
          </a>
          <button
            type="button"
            className={isEmpty ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={() => setShowNew(true)}
          >
            <Plus size={16} />
            새 요청
          </button>
        </div>
      </div>

      {/* 상태 필터 */}
      <div className="toolbar">
        <div className="table-scroll">
          <div className="seg">
            <label className="seg-opt">
              <input
                type="radio"
                name="orch-filter"
                checked={filter === 'all'}
                onChange={() => setFilter('all')}
              />
              전체
              <span className="badge">{totalCards}</span>
            </label>
            {BOARD_ORDER.map((s) => (
              <label className="seg-opt" key={s}>
                <input
                  type="radio"
                  name="orch-filter"
                  checked={filter === s}
                  onChange={() => setFilter(s)}
                />
                {STATUS_LABEL[s]}
                <span className="badge">{countOf(s)}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* 목록 — 상태 3종(§6) */}
      {state === 'error' ? (
        <ErrorState
          title="요청 목록을 불러오지 못했습니다"
          onRetry={() => { setState('loading'); void loadBoard(); }}
        />
      ) : state === 'ready' && totalCards === 0 ? (
        <Empty
          title="아직 요청이 없습니다"
          body="새 요청을 등록하면 기획·승인·실행이 이 목록에 쌓입니다."
          action={
            <button type="button" className="btn btn-primary" onClick={() => setShowNew(true)}>
              <Plus size={16} />
              새 요청
            </button>
          }
        />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>제목</th>
                <th>상태</th>
                <th>진행</th>
                <th>담당</th>
                <th>요청자</th>
                <th className="num">갱신</th>
                <th />
              </tr>
            </thead>
            {state === 'loading' ? (
              <TableSkeleton cols={7} />
            ) : (
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted">이 상태의 요청이 없습니다.</td>
                  </tr>
                ) : (
                  rows.map((c) => (
                    <tr key={c.id}>
                      <td>{c.title || '(제목 없음)'}</td>
                      <td><StatusTag status={c.status} /></td>
                      <td className="num">
                        {c.subtask_count > 0 ? `${c.subtask_done_count}/${c.subtask_count}` : '-'}
                      </td>
                      <td>
                        {c.agent_ids.length === 0
                          ? <span className="text-muted">-</span>
                          : c.agent_ids.map((a) => (
                              <span className="tag tag-neutral" key={a}>{a}</span>
                            ))}
                      </td>
                      <td className="text-muted">{c.created_by}</td>
                      <td className="num">{fmtTime(c.updated_at || c.created_at)}</td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setOpenId(c.id)}
                        >
                          상세
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
        </div>
      )}

      {/* 다이얼로그 */}
      {showNew && (
        <NewRequestDialog
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); void loadBoard(); }}
        />
      )}
      {openId && (
        <DetailDialog
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void loadBoard()}
        />
      )}
    </div>
  );
}
