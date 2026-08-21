/**
 * AgentChat.tsx — 에이전트 채팅 UI (클라이언트)
 * POST/GET /api/admin/agent-chat + SSE /api/admin/agent-chat/stream
 *
 * UI 는 Modernist Kit 만 사용한다(DESIGN.md).
 *  · 셸 §4.1 `.shell` + `.sidebar` + `.shell-main`(접힘은 `data-collapsed`)
 *  · 대화 §11.5 `.chat-log` `.bubble .bubble-user` `.bubble .bubble-agent` `.chat-composer`
 *  · 좁은 화면·접힘 상태의 세션 목록은 §4.13 `.drawer-backdrop` + `.drawer`
 *  · 상태 3종 §6 — 로딩 `.skeleton`(CardSkeleton) / 빈 `Empty` / 에러 `ErrorState`
 *  · 이모지 금지(§규칙 8) — 에이전트 표시는 이니셜 `.avatar` 또는 lucide `Bot`
 */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { ArrowDown, ArrowLeft, Bot, Menu, MessagesSquare, Plus, X } from 'lucide-react';
import AssistantMarkdown from './AssistantMarkdown';
import Empty from '@/components/state/Empty';
import ErrorState from '@/components/state/ErrorState';
import Loading from '@/components/state/Loading';
import { CardSkeleton } from '@/components/state/Skeleton';

// ─── 타입 ──────────────────────────────────────────────────────────────────────
interface Agent {
  id: string;
  name: string;
  role: string;
  /** 서버 호환 필드 — UI 에 렌더하지 않는다(이모지 금지). */
  emoji?: string;
  /** DB agents.image_url — 아바타의 단일 출처. */
  image_url?: string | null;
}

interface ChatSession {
  id: string;
  title: string;
  created_by: string;
  updated_at: string;
}

interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  agent_id?: string | null;
  content: string;
  streaming?: boolean;
  status?: string;
  error?: string | null;
  created_at: string;
}

type PostResponse =
  | { type: 'agent_list'; agents: Agent[] }
  | {
      ok: true;
      session_id: string;
      job_id: string;
      assistant_message_id: string;
      user_message_id: string;
      agent_id: string;
    };

type LoadState = 'loading' | 'ready' | 'error';

// ─── 에이전트 표시(이니셜) ─────────────────────────────────────────────────────
/** 에이전트 이니셜 — `lion` -> `LI`. 이모지 대체(§규칙 8). */
/**
 * 아바타 — 소개 화면·홈과 **같은 얼굴**을 쓴다(단일 출처는 DB image_url).
 * agents 목록에서 그 에이전트를 찾아 초상을 넘기고, 못 찾으면 공용 컴포넌트가
 * 역할 아이콘 → 모노그램으로 떨어뜨린다. agent_id 자체가 없으면 사람이 아니라 시스템
 * 메시지이므로 lucide Bot 을 쓴다.
 */
function ChatAvatar({ agentId, agents }: { agentId?: string | null; agents: Agent[] }) {
  if (!agentId) {
    return (
      <span className="avatar avatar-neutral" aria-hidden="true">
        <Bot size={16} />
      </span>
    );
  }
  const a = agents.find((x) => x.id === agentId);
  return <AgentAvatar id={agentId} name={a?.name ?? agentId} imageUrl={a?.image_url} sizeClass="" />;
}

// 복사 버튼·마크다운 렌더러는 AssistantMarkdown.tsx 로 추출(오케 콘솔과 공용, 2026-07-09).

// ─── 메시지 말풍선 ─────────────────────────────────────────────────────────────
function MessageBubble({ message, agents }: { message: ChatMessage; agents: Agent[] }) {
  const isUser = message.role === 'user';
  const agent = agents.find((a) => a.id === message.agent_id);

  if (isUser) {
    return (
      <div className="bubble bubble-user">
        <p>{message.content}</p>
      </div>
    );
  }

  const label = agent?.name ?? message.agent_id ?? '에이전트';
  const failed = message.status === 'error' || message.error;

  return (
    <div className="stack-2">
      <div className="row">
        <ChatAvatar agentId={message.agent_id} agents={agents} />
        <span className="kicker">{label}</span>
      </div>
      <div className="bubble bubble-agent">
        {failed ? (
          <div className="banner" data-tone="danger" role="alert">
            <span>
              <b>응답 실패</b>
              <br />
              {message.error ?? '알 수 없는 오류'}
            </span>
          </div>
        ) : message.content ? (
          <AssistantMarkdown content={message.content} />
        ) : (
          // 내용이 비어 있으면 '생각 중' 표시(§4.14 `.spinner`).
          <Loading label={agent?.name ? `${agent.name} 생각 중…` : '생각 중…'} />
        )}
        {message.streaming && message.content && (
          <p className="card-meta" role="status" aria-live="polite">
            <span className="spinner" />
            응답 중…
          </p>
        )}
      </div>
    </div>
  );
}

// ─── 예시 프롬프트 ─────────────────────────────────────────────────────────────
const EXAMPLES = [
  '사용 가능한 에이전트가 뭐야?',
  '오늘 블로그 발행 현황 알려줘',
  'Lion, 파이프라인 상태 보고해',
  '어제 게이트 실패 이유는?',
];

// ─── 세션 목록(사이드바·드로어 공용) ──────────────────────────────────────────
function SessionList({
  sessions, activeSessionId, state, onSelect, onRetry,
}: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  state: LoadState;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  if (state === 'loading') return <CardSkeleton count={3} />;
  if (state === 'error') {
    return <ErrorState title="대화 목록을 불러오지 못했습니다" onRetry={onRetry} />;
  }
  if (sessions.length === 0) {
    // 빈 상태는 키트 컴포넌트로 통일한다(§4.14) — 액션은 바로 위 '새 대화' 버튼이 맡는다.
    return <Empty title="대화 내역이 없습니다" body="새 대화를 시작하면 여기에 쌓입니다." />;
  }
  return (
    <>
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          className="nav-item"
          aria-current={activeSessionId === s.id ? 'page' : undefined}
          onClick={() => onSelect(s.id)}
        >
          {s.title || '새 대화'}
        </button>
      ))}
    </>
  );
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
export default function AgentChat() {
  const [sessions, setSessions]             = useState<ChatSession[]>([]);
  const [sessionsState, setSessionsState]   = useState<LoadState>('loading');
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages]             = useState<ChatMessage[]>([]);
  const [messagesState, setMessagesState]   = useState<LoadState>('ready');
  const [agents, setAgents]                 = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent]   = useState<Agent | null>(null);
  const [inputText, setInputText]           = useState('');
  const [isStreaming, setIsStreamingState]  = useState(false);
  const [sidebarOpen, setSidebarOpen]       = useState(true);
  const [drawerOpen, setDrawerOpen]         = useState(false);
  const [isAtBottom, setIsAtBottomState]    = useState(true);

  // 클로저 안에서 최신 값이 필요한 ref
  const isStreamingRef      = useRef(false);
  const isAtBottomRef       = useRef(true);
  const sseRef              = useRef<EventSource | null>(null);
  const reconnectTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentAccumRef     = useRef<Map<string, string>>(new Map());
  const activeSessionIdRef  = useRef<string | null>(null);
  const scrollContainerRef  = useRef<HTMLDivElement>(null);
  const textareaRef         = useRef<HTMLTextAreaElement>(null);

  function setIsStreaming(v: boolean) {
    isStreamingRef.current = v;
    setIsStreamingState(v);
  }
  function setIsAtBottom(v: boolean) {
    isAtBottomRef.current = v;
    setIsAtBottomState(v);
  }

  // ── 스크롤 ──────────────────────────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setIsAtBottom(atBottom);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 메시지 변경 시 자동 스크롤 (하단에 붙어 있을 때만)
  useEffect(() => {
    if (isAtBottomRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

  // ── 데이터 로드 ─────────────────────────────────────────────────────────────
  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/agent-chat');
      if (!res.ok) { setSessionsState('error'); return; }
      const data = (await res.json()) as { sessions: ChatSession[] };
      setSessions(data.sessions ?? []);
      setSessionsState('ready');
    } catch { setSessionsState('error'); }
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    setMessagesState('loading');
    try {
      const res = await fetch(`/api/admin/agent-chat?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) { setMessagesState('error'); return; }
      const data = (await res.json()) as { messages: ChatMessage[] };
      setMessages(data.messages ?? []);
      setMessagesState('ready');
      contentAccumRef.current.clear();
      setTimeout(scrollToBottom, 50);
    } catch { setMessagesState('error'); }
  }, [scrollToBottom]);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/agents');
      if (!res.ok) return;
      const data = (await res.json()) as Agent[] | { agents: Agent[] };
      setAgents(Array.isArray(data) ? data : (data.agents ?? []));
    } catch { /* 무시 */ }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadAgents();
  }, [loadSessions, loadAgents]);

  // ── SSE ─────────────────────────────────────────────────────────────────────
  const closeSSE = useCallback(() => {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
  }, []);

  const openStream = useCallback((sessionId: string) => {
    closeSSE();

    const connect = () => {
      // 세션이 바뀐 경우 중단
      if (activeSessionIdRef.current !== sessionId) return;

      const es = new EventSource(
        `/api/admin/agent-chat/stream?session_id=${encodeURIComponent(sessionId)}`
      );
      sseRef.current = es;

      es.addEventListener('delta', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data as string) as {
            message_id: string;
            content: string;
            streaming: boolean;
            status: string;
            agent_id?: string;
          };
          // 서버는 누적(절대) content 를 보낸다 -> append 가 아니라 set.
          const next = d.content;
          contentAccumRef.current.set(d.message_id, next);
          setMessages((msgs) =>
            msgs.map((m) =>
              m.id === d.message_id ? { ...m, content: next, streaming: d.streaming } : m
            )
          );
          if (isAtBottomRef.current) scrollToBottom();
        } catch { /* 무시 */ }
      });

      es.addEventListener('done', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data as string) as {
            message_id: string;
            status: string;
            error?: string;
          };
          setMessages((msgs) =>
            msgs.map((m) =>
              m.id === d.message_id
                ? { ...m, streaming: false, status: d.status, error: d.error }
                : m
            )
          );
        } catch { /* 무시 */ }
        setIsStreaming(false);
        es.close();
        sseRef.current = null;
      });

      es.addEventListener('error', (ev: MessageEvent) => {
        try {
          const d = JSON.parse(ev.data as string) as { message?: string };
          setMessages((msgs) => {
            const last = msgs[msgs.length - 1];
            if (last?.streaming) {
              return msgs.map((m, i) =>
                i === msgs.length - 1
                  ? { ...m, streaming: false, status: 'error', error: d.message ?? '스트리밍 오류' }
                  : m
              );
            }
            return msgs;
          });
        } catch { /* 무시 */ }
      });

      // 연결 끊김 — 스트리밍 중이면 재연결 (SSE는 ~55s 서버 닫힘 설계)
      es.onerror = () => {
        if (sseRef.current !== es) return;
        es.close();
        sseRef.current = null;
        if (isStreamingRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };
    };

    connect();
  }, [closeSSE, scrollToBottom]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => closeSSE(), [closeSSE]);

  // ── 세션 선택 ────────────────────────────────────────────────────────────────
  const selectSession = useCallback(
    (sessionId: string | null) => {
      closeSSE();
      setIsStreaming(false);
      setActiveSessionId(sessionId);
      activeSessionIdRef.current = sessionId;
      if (sessionId) {
        void loadMessages(sessionId);
      } else {
        setMessages([]);
        setMessagesState('ready');
        contentAccumRef.current.clear();
      }
    },
    [closeSSE, loadMessages] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ── 메시지 전송 ──────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isStreamingRef.current) return;

    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const now = new Date().toISOString();
    const tempUserId    = `temp-user-${Date.now()}`;
    const tempAsstId    = `temp-asst-${Date.now()}`;
    const curSessionId  = activeSessionId;

    const userMsg: ChatMessage = {
      id: tempUserId,
      session_id: curSessionId ?? '',
      role: 'user',
      content: text,
      created_at: now,
    };
    const asstMsg: ChatMessage = {
      id: tempAsstId,
      session_id: curSessionId ?? '',
      role: 'assistant',
      agent_id: selectedAgent?.id,
      content: '',
      streaming: true,
      created_at: now,
    };

    setMessages((msgs) => [...msgs, userMsg, asstMsg]);
    setIsStreaming(true);
    setIsAtBottom(true);
    setTimeout(scrollToBottom, 10);

    try {
      const body: Record<string, string> = { text };
      if (curSessionId)    body.session_id = curSessionId;
      if (selectedAgent)   body.agent_id   = selectedAgent.id;

      const res = await fetch('/api/admin/agent-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        setMessages((msgs) =>
          msgs.map((m) =>
            m.id === tempAsstId
              ? { ...m, streaming: false, status: 'error', error: `HTTP ${res.status}` }
              : m
          )
        );
        setIsStreaming(false);
        return;
      }

      const data = (await res.json()) as PostResponse;

      // agent_list 응답
      if ('type' in data && data.type === 'agent_list') {
        setAgents(data.agents);
        const listText = `사용 가능한 에이전트:\n${data.agents.map((a) => `- **${a.name}** (${a.role})`).join('\n')}`;
        setMessages((msgs) =>
          msgs.map((m) =>
            m.id === tempAsstId
              ? { ...m, streaming: false, content: listText }
              : m
          )
        );
        setIsStreaming(false);
        return;
      }

      // 정상 응답
      const okData = data as Extract<PostResponse, { ok: true }>;
      const { session_id, assistant_message_id, user_message_id } = okData;

      // temp ID -> 실제 ID 교체
      setMessages((msgs) =>
        msgs.map((m) => {
          if (m.id === tempUserId)  return { ...m, id: user_message_id,      session_id };
          if (m.id === tempAsstId)  return { ...m, id: assistant_message_id, session_id };
          return m;
        })
      );

      contentAccumRef.current.delete(tempAsstId);
      contentAccumRef.current.set(assistant_message_id, '');

      // 새 세션이면 목록 갱신
      if (!curSessionId) {
        setActiveSessionId(session_id);
        activeSessionIdRef.current = session_id;
        void loadSessions();
      }

      openStream(session_id);
    } catch (e) {
      setMessages((msgs) =>
        msgs.map((m) =>
          m.id === tempAsstId
            ? { ...m, streaming: false, status: 'error', error: (e as Error).message }
            : m
        )
      );
      setIsStreaming(false);
    }
  }, [inputText, activeSessionId, selectedAgent, scrollToBottom, loadSessions, openStream]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── textarea 자동 높이 ───────────────────────────────────────────────────────
  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInputText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    // `.input` 은 border-box 라 height 에 테두리까지 포함된다. scrollHeight(=내용+패딩)를
    // 그대로 넣으면 상하 테두리 2px 만큼 상자가 모자라 두 줄부터 항상 잘린 채 스크롤됐다.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = Math.min(el.scrollHeight + border, 144) + 'px';
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  // 드로어는 ESC 로 닫는다(§8).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const activeTitle = activeSessionId
    ? (sessions.find((s) => s.id === activeSessionId)?.title || '채팅')
    : '새 대화';

  function pickSession(id: string) {
    selectSession(id);
    setDrawerOpen(false);
  }

  const sessionList = (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      state={sessionsState}
      onSelect={pickSession}
      onRetry={() => { setSessionsState('loading'); void loadSessions(); }}
    />
  );

  // ── 렌더 ────────────────────────────────────────────────────────────────────
  return (
    <div className="shell" data-collapsed={!sidebarOpen}>
      {/* 사이드바 — 펼침이면 세션 목록, 접힘이면 아이콘 스트립(목록은 드로어로) */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="sidebar-mark" />
          {sidebarOpen && '에이전트 채팅'}
        </div>

        {sidebarOpen ? (
          <>
            <div className="sidebar-group">
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={() => selectSession(null)}
              >
                <Plus size={16} />
                새 대화
              </button>
            </div>
            <div className="sidebar-group kicker">대화 내역</div>
            <div className="scroll-y stack-2" style={{ flex: 1, paddingInline: 'var(--space-2)' }}>
              {sessionList}
            </div>
            <a className="nav-item" href="/admin">
              <ArrowLeft size={16} />
              대시보드
            </a>
          </>
        ) : (
          <>
            <div className="sidebar-group stack-2">
              <button type="button" className="btn btn-icon" aria-label="새 대화" onClick={() => selectSession(null)}>
                <Plus size={18} />
              </button>
              <button
                type="button"
                className="btn btn-icon"
                aria-label="대화 내역 열기"
                aria-expanded={drawerOpen}
                onClick={() => setDrawerOpen(true)}
              >
                <MessagesSquare size={18} />
              </button>
            </div>
            <div className="spacer" />
            <div className="sidebar-group">
              <a className="btn btn-icon" href="/admin" aria-label="대시보드로">
                <ArrowLeft size={16} />
              </a>
            </div>
          </>
        )}
      </aside>

      {/* 본문 */}
      <div className="shell-main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn-icon"
            aria-label={sidebarOpen ? '사이드바 접기' : '사이드바 펼치기'}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu size={20} />
          </button>
          <div className="crumb">
            <span>ADMIN</span>
            <span>/</span>
            <b>{activeTitle}</b>
          </div>
          <div className="spacer" />
          {selectedAgent && <span className="tag tag-neutral">{selectedAgent.name}</span>}
        </header>

        {/* 대화 영역 */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="chat-log scroll-y"
        >
          {messagesState === 'loading' ? (
            <Loading label="대화를 불러오는 중…" />
          ) : messagesState === 'error' ? (
            <ErrorState
              title="대화를 불러오지 못했습니다"
              onRetry={() => { if (activeSessionId) void loadMessages(activeSessionId); }}
            />
          ) : messages.length === 0 ? (
            <Empty
              title="에이전트와 대화하기"
              body="메시지를 입력하거나 아래 예시를 클릭해 시작하세요."
              action={
                <div className="grid-2" style={{ width: '100%' }}>
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className="btn btn-secondary btn-block"
                      onClick={() => {
                        setInputText(ex);
                        textareaRef.current?.focus();
                      }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              }
            />
          ) : (
            messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} agents={agents} />
            ))
          )}
        </div>

        {/* 맨 아래로 (스크롤 이탈 시) */}
        {!isAtBottom && messages.length > 0 && (
          <div className="row-end" style={{ paddingInline: 'var(--space-4)' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { scrollToBottom(); setIsAtBottom(true); }}
            >
              <ArrowDown size={16} />
              맨 아래로
            </button>
          </div>
        )}

        {/* 입력부 */}
        <div>
          <div className="chat-composer">
            <select
              className="input chat-agent-select"
              aria-label="에이전트 선택"
              value={selectedAgent?.id ?? ''}
              onChange={(e) => {
                const agent = agents.find((a) => a.id === e.target.value);
                setSelectedAgent(agent ?? null);
              }}
            >
              <option value="">에이전트 선택 (선택사항)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {/* 입력칸과 전송은 한 덩어리다(§11.5 `.chat-input-row`) — 셋을 그냥 wrap 시키면
                남는 폭에 따라 전송 버튼만 다음 줄 왼쪽으로 떨어져 나간다(430px 실측). */}
            <div className="chat-input-row">
              <textarea
                ref={textareaRef}
                className="input"
                value={inputText}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                disabled={isStreaming}
                placeholder="메시지를 입력하세요"
                rows={1}
                aria-label="메시지"
                style={{ minHeight: 36, maxHeight: 144 }}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleSend()}
                disabled={isStreaming || !inputText.trim()}
              >
                {isStreaming && <span className="spinner" />}
                전송
              </button>
            </div>
          </div>
          <p className="field-hint" style={{ padding: '0 var(--space-4) var(--space-3)' }}>
            Enter 전송 · Shift+Enter 줄바꿈. AI 응답은 실수가 있을 수 있습니다 — 중요한 정보는 직접 확인하세요.
          </p>
        </div>
      </div>

      {/* 세션 목록 드로어 (사이드바 접힘·좁은 화면) */}
      {drawerOpen && (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="대화 내역">
            <div className="drawer-head">
              <h5>대화 내역</h5>
              <div className="spacer" />
              <button
                type="button"
                className="btn btn-icon"
                aria-label="닫기"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <div className="drawer-body stack-2">
              <button
                type="button"
                className="btn btn-secondary btn-block"
                onClick={() => { selectSession(null); setDrawerOpen(false); }}
              >
                <Plus size={16} />
                새 대화
              </button>
              {sessionList}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
