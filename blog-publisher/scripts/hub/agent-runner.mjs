/**
 * scripts/hub/agent-runner.mjs — agent-chat job runner daemon
 *
 * Poll loop (~1500 ms) + heartbeat (mirror worker.mjs pattern).
 * Each tick: claim one pending job from Supabase, stream response, finalize.
 *
 * RUN_MODE=mock (default when ANTHROPIC_API_KEY absent): stream a canned response
 *   in ~6 chunks with small delays, writing deltas to both local sqlite and Supabase.
 * RUN_MODE=live: spawn `claude -p` with stream-json output, parse JSONL deltas.
 *
 * Flags:
 *   --once   process a single job then exit (for e2e tests)
 *
 * npm run hub:agent-runner
 */

import { spawn }                      from 'node:child_process';
import { existsSync, writeFileSync,
         mkdirSync }                  from 'node:fs';
import { join, dirname }              from 'node:path';
import { fileURLToPath }              from 'node:url';
import { makeLogger }                 from '../lib/log.mjs';
import { paths }                      from '../lib/config.mjs';
import { upsertJob, markJob,
         ensureMessage, appendDelta,
         finishMessage }              from './chat-store.mjs';
import { claimPendingJob, patchMessage,
         markJobStatus, patchOrchestrationRequest,
         insertOrchestrationSubtasks, deleteOrchestrationSubtasks,
         patchOrchestrationSubtask, insertChatMessage,
         getOrchestrationRequest, getOrchestrationSubtasks,
         reapStaleJobs }              from './agent-chat-supabase.mjs';
import { systemPromptFor, allowedToolsFor,
         agentCatalog, loadAgents }   from './agent-router.mjs';
import { loadDeployConfig, deployEnabled, isDevRequest,
         prepareDevContext, finalizeDeploy,
         buildDeployDoneContent }     from './orchestrator-deploy.mjs';
import { appendAudit, ACTIONS }       from '../audit/append.mjs';

const log = makeLogger('hub/agent-runner');

const __dir      = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dir, '..', '..');
const POLL_MS    = 1_500;
const HEARTBEAT_MS = 30_000;
const REAP_MS    = 60_000;        // throttle stale-job reaper (checked each tick, run when due)
const STALE_MS   = 10 * 60 * 1000; // a running job older than this is presumed crashed
const ONCE_MODE  = process.argv.includes('--once');
// 채팅 러너의 mock 판정은 발행 크리덴셜(GITHUB/VERCEL)과 무관.
// RUN_MODE=mock 을 명시했을 때만 mock, 아니면 live(구독 claude 실행).
const MOCK_MODE  = process.env.RUN_MODE === 'mock';
const MAX_SUBTASKS = 12;          // 모델 제어 과다 팬아웃 방지 상한

// ─── 자식 프로세스 시크릿 스크럽 ────────────────────────────────────────────────
// 프롬프트 인젝션 → RCE/시크릿 유출의 blast radius 축소. 러너 부모가 DB·알림을
// 미러링하므로 자식 claude 는 이 키들이 전혀 필요 없다(구독 claude 는 HOME/.claude
// 세션만 사용). PATH·HOME 등 claude 구동 필수 변수는 보존한다.
// ANTHROPIC_API_KEY 도 제거한다 — 있으면 claude 가 API 종량제로 빠지므로, 지워서
// 구독(Claude Code OAuth) 인증을 강제한다(크레딧 소모 방지).
const SECRET_ENV = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_ANON_KEY',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'DISCORD_WEBHOOK_URL',
  'SALES_SLACK_BOT_TOKEN', 'CRW_SLACK_WEBHOOK_URL', 'SALES_SLACK_WEBHOOK_URL',
  'GSC_SITE_URL',
];

/** 자식 claude 에 넘길 env 사본에서 민감 시크릿을 제거한다. */
function childEnvScrubbed() {
  const childEnv = { ...process.env };
  for (const k of SECRET_ENV) delete childEnv[k];
  // 이름 기반 필터: 시크릿류(TOKEN·KEY·PASSWORD·SECRET·CREDENTIAL·WEBHOOK·SERVICE_ROLE)를 전부 삭제.
  // dev 워크트리 실행 에이전트(coder/devops)는 Bash 를 가지므로 GITHUB_TOKEN·VERCEL_TOKEN 등이
  // 남으면 오남용 가능 — push·배포는 부모(러너)가 하므로 자식엔 토큰이 필요 없다.
  for (const k of Object.keys(childEnv)) {
    if (/WEBHOOK|SERVICE_ROLE|SECRET|TOKEN|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)) delete childEnv[k];
  }
  return childEnv;
}

/** 러너-측 메시지 id 생성(웹 mkId('msg') 와 동형: 접두 + 시간(36) + 랜덤). */
const mkMessageId = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

let running = true;

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT',  () => { log.info('SIGINT  — stopping'); running = false; });
process.on('SIGTERM', () => { log.info('SIGTERM — stopping'); running = false; });

// ─── Heartbeat ────────────────────────────────────────────────────────────────

function writeHeartbeat() {
  try {
    const dir  = join(paths.state, 'hub');
    const file = join(dir, 'agent-runner-heartbeat.json');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, mode: MOCK_MODE ? 'mock' : 'live' }),
      'utf8'
    );
  } catch (err) {
    log.warn('heartbeat write failed', err?.message);
  }
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

function auditLine(job, status, extra = '') {
  try {
    appendAudit({
      actor:       job.session_id ?? 'unknown',
      action:      ACTIONS.PUBLISH ?? 'agent_chat',
      before_hash: '',
      after_hash:  '',
      reason:      `agent=${job.agent_id ?? 'none'} prompt_len=${String(job.prompt ?? '').length} status=${status}${extra ? ' ' + extra : ''}`,
    });
  } catch (err) {
    // Fallback to plain log — audit is best-effort
    log.info(`audit_fallback agent=${job.agent_id ?? 'none'} session=${job.session_id} status=${status}${extra ? ' ' + extra : ''}`);
  }
}

// ─── Mock stream ──────────────────────────────────────────────────────────────

/** Canned mock chunks for each known agent (falls back to generic). */
function mockChunks(agentId, prompt, kind) {
  const short = String(prompt ?? '').slice(0, 40);
  if (kind === 'orchestrate') {
    // Canned decompose result. Two variants exercise the feasibility branch:
    //  - prompt matching the infeasible marker → feasible:false + reason (hold path)
    //  - otherwise → feasible:true + subtasks (materialize path)
    // Alternate plain / fenced JSON by prompt-length parity so the
    // fence-stripping path is exercised in tests too.
    const infeasible = /불가|infeasible|할 수 없|범위 밖|불가능/i.test(String(prompt ?? ''));
    const obj = infeasible
      ? {
          feasible: false,
          reason:  `요청 "${short}" 은(는) 담당 가능한 에이전트가 없어 기술적으로 수행할 수 없습니다. (MOCK)`,
          title:   `${short || '요청'} (불가 판정 MOCK)`,
          summary: '',
          subtasks: [],
        }
      : {
          feasible: true,
          reason:  '',
          title:   `${short || '요청'} 오케스트레이션 (MOCK)`,
          summary: '요청을 하위작업으로 분해했습니다. (MOCK)',
          subtasks: [
            { agent_id: 'cheetah', task: '관련 트렌드 주제 후보 수집', expected: '주제 후보 목록' },
            { agent_id: 'beaver',  task: '선정 주제로 how-to 초안 작성', expected: 'how-to 초안 마크다운' },
            { agent_id: 'nonexistent', task: '무효 에이전트 (드롭 대상)', expected: '없음' },
          ],
        };
    const json   = JSON.stringify(obj, null, 2);
    const fenced = String(prompt ?? '').length % 2 === 0;
    return [ fenced ? '어시스턴트 프리앰블입니다.\n```json\n' + json + '\n```' : json ];
  }
  if (agentId === 'spider') {
    return [
      '정찰 요청을 받았습니다. (MOCK)\n',
      'recon-gateway capture 실행 중...\n',
      'replay 판정 흐름을 따릅니다.\n',
      `입력 요약: "${short}"\n`,
      '분석 완료: CURL-ABLE ✅ — transportClass A.\n',
      '정찰 결과 JSON 준비 완료. (MOCK 응답)',
    ];
  }
  return [
    `(MOCK) ${agentId ?? 'assistant'} 응답 시작.\n`,
    `요청: "${short}"\n`,
    '처리 중...\n',
    '검토 완료.\n',
    '결과를 정리합니다.\n',
    '응답 완료. (MOCK)',
  ];
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Stream a mock response, writing each chunk to local sqlite + Supabase.
 * Returns the full assembled text.
 */
async function streamMock(job, messageId) {
  const chunks = mockChunks(job.agent_id, job.prompt);
  let full = '';
  for (const chunk of chunks) {
    full += chunk;
    appendDelta(messageId, chunk);           // sqlite: 로컬 진실원본(atomic append)
    await patchMessage(messageId, { content: full }); // Supabase: 절대값(경쟁 없음)
    await sleep(120);
  }
  return full;
}

// ─── Live stream (claude -p) ──────────────────────────────────────────────────

/**
 * Spawn `claude -p` with stream-json output and pipe assistant deltas
 * to both local sqlite and Supabase.
 * System prompt is prepended to the user prompt.
 * Returns the full assembled text.
 */
async function streamLive(job, messageId, opts = {}) {
  // 실행 디렉토리: dev 요청은 격리 워크트리 cwd(opts.cwd), 그 외는 blog-publisher ROOT.
  const cwd = opts.cwd || ROOT;
  const systemPrompt = systemPromptFor(job.agent_id);
  let fullPrompt = systemPrompt
    ? `${systemPrompt}\n\n---\n${job.prompt}`
    : job.prompt;
  // 워크트리 프리앰블(경로 고정·타 체크아웃 금지·커밋금지)을 최상단에 앞세운다.
  if (opts.promptPrefix) fullPrompt = `${opts.promptPrefix}\n\n---\n${fullPrompt}`;
  // 도구 화이트리스트: 라우팅된 에이전트의 선언 도구 ∩ SAFE_TOOLS.
  // plain 대화(agent_id=null)는 빈 목록 -> claude 가 어떤 도구도 실행 못 함(대화 전용).
  // ambient deny-list 에 의존하지 않고 여기서 명시적으로 차단한다.
  const tools = allowedToolsFor(job.agent_id);

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', fullPrompt, '--output-format', 'stream-json', '--verbose',
       '--include-partial-messages',
       '--allowedTools', tools.join(' ')],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvScrubbed() }
    );

    let full  = '';       // 스트리밍 델타 누적
    let lastFull = '';    // result/assistant 최종 스냅샷(델타 미수신 시 폴백)
    let buf   = '';
    let errBuf = '';
    // Supabase 미러: 절대 콘텐츠 single-flight 쓰기(경쟁 없는 last-write-wins).
    let flushing = false, flushDirty = false;
    const flush = async () => {
      if (flushing) { flushDirty = true; return; }
      flushing = true;
      try { await patchMessage(messageId, { content: full }); }
      catch (e) { log.warn('patchMessage flush error', e?.message); }
      flushing = false;
      if (flushDirty) { flushDirty = false; flush(); }
    };

    child.stdout.on('data', (raw) => {
      buf += raw.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete tail
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try { evt = JSON.parse(trimmed); } catch { continue; }

        // Claude Code stream-json 이벤트 형식 대응:
        //  - partial: {type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}
        //  - 일부 버전: {type:'content_block_delta', delta:{text}}
        //  - 최종 스냅샷(폴백): {type:'assistant', message:{content:[{type:'text',text}]}} / {type:'result', result}
        let delta = '';
        const inner = evt.type === 'stream_event' ? (evt.event ?? {}) : evt;
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
          delta = inner.delta.text ?? '';
        } else if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          lastFull = evt.message.content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('');
        } else if (evt.type === 'result' && typeof evt.result === 'string') {
          lastFull = evt.result;
        }

        if (delta) {
          full += delta;
          appendDelta(messageId, delta);   // sqlite: 로컬 진실원본
          flush();                          // Supabase: coalescing 절대 콘텐츠 쓰기
        }
      }
    });

    child.stderr.on('data', (raw) => {
      errBuf += raw.toString('utf8');
    });

    child.on('error', (err) => {
      log.error('claude spawn error', err?.message);
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        log.warn(`claude exited ${code}`, errBuf.slice(0, 200));
      }
      // 델타를 하나도 못 받았으면 최종 스냅샷(result/assistant)으로 폴백.
      if (!full && lastFull) {
        full = lastFull;
        appendDelta(messageId, full);
        flush();
      }
      if (!full && errBuf) {
        // stderr 원문은 시크릿·내부 경로 유출 위험 → persist·SSE 로 내보내지 않는다.
        // 서버 로그에만 원문을 남기고 스레드에는 일반 오류 메시지만 노출.
        log.error(`claude stderr (exit=${code})`, errBuf.slice(0, 2000));
        full = `⚠ 실행 오류 (exit=${code})`;
      }
      resolve(full);
    });
  });
}

// ─── Orchestrator decompose (kind='orchestrate') ────────────────────────────────

/** Fixed orchestrator system prompt embedding the live agent catalog, grouped by team. */
function buildOrchestratorPrompt(catalog) {
  const fmt = a => `- ${a.id} (${a.name}): ${a.role}`;
  const publish = catalog.filter(a => (a.team || 'publish') !== 'dev');
  const dev     = catalog.filter(a => a.team === 'dev');

  const rules = [
    '규칙:',
    '- 먼저 요청을 분류한다:',
    '  (a) 콘텐츠·운영 — 글 작성/주제 수집/품질 검증/발행/감사·관제 등 → 발행·관측팀.',
    '  (b) 사이트·기능·관리자 페이지·API·DB 개발/수정 → 개발팀.',
  ];
  if (dev.length) {
    rules.push(
      '- 개발팀 배정 시 표준 순서로 하위작업을 나열한다: planner(스펙) → architect(구조·데이터모델)',
      '  → designer(UI) → coder(구현) → tester·security-reviewer(코드 산출 후 병렬 검토) → verifier(스펙정합·회귀) → devops(마이그레이션 SQL·배포 준비물 작성 — 실제 커밋·push·배포는 승인 후 시스템이 자동 수행하므로 직접 하지 말 것).',
      '  요청 규모에 맞게 단계는 생략 가능하다(사소 수정: planner 생략 → coder → tester → verifier).',
      '- 개발 요청이면 격리 워크트리에서 작업하도록 계획한다: worktree 필드에 브랜치명을 제안한다(예: "feat/<짧은-슬러그>"). main 직접 수정 금지.',
      '- 개발팀이 존재하므로 사이트·기능·DB 개발 요청도 feasible=true 다. 정말 기술적으로 불가하거나 위험한 경우만 false.',
    );
  }
  rules.push(
    '- 보류(feasible=false) 조건: (1)기술적으로 불가능, (2)담당 가능한 에이전트 없음, (3)시스템 범위 밖,',
    '  또는 (4)자동으로 처리하기 위험한 경우 — 파괴적·비가역 변경, 보안·개인정보 위험, 큰 비용, 외부 약관/계약 위반 소지, 사람 판단이 꼭 필요.',
    '  보류 시 subtasks 는 빈 배열로 두고, reason 을 비전문가도 납득할 수 있게 쉬운 말로 설명한다(무엇이 왜 위험/불가한지 + 가능한 대안).',
    '- 가능하면 feasible=true 로 하고 subtasks 를 채운다.',
    '- 위 목록에 있는 agent_id 만 사용한다. 목록에 없는 id 는 절대 쓰지 않는다.',
    '- 각 하위작업은 정확히 하나의 에이전트에 배정한다. 필요한 만큼만, 논리적 순서로.',
    '- 오직 JSON 만 출력한다. 설명·인사말·마크다운·코드펜스 없이 JSON 객체 하나만.',
    '- 형식: {"feasible": boolean, "reason": string, "title": string, "summary": string, "worktree": string, "subtasks": [{"agent_id": string, "task": string, "expected": string}]}',
  );

  return [
    '너는 우리 회사 에이전트 오케스트레이터다.',
    '사용자의 자연어 요청을 분류하고, 실행가능성(feasibility)을 판정한 뒤,',
    '가능하면 아래 에이전트들에게 배정할 하위작업(subtask)으로 분해한다.',
    '',
    '발행·관측팀 (콘텐츠·주제·검증·발행·관제 — 이 agent_id 들 중에서만 배정):',
    publish.map(fmt).join('\n'),
    ...(dev.length ? [
      '',
      '개발팀 (사이트·기능·관리자 페이지·API·DB 개발 — 이 agent_id 들 중에서만 배정):',
      dev.map(fmt).join('\n'),
    ] : []),
    '',
    ...rules,
  ].join('\n');
}

/**
 * Spawn `claude -p <prompt> --output-format json --allowedTools ''` (no tools,
 * pure decomposition). Returns the `result` string from the JSON envelope, or
 * the raw stdout if the envelope can't be parsed (fence-strip happens later).
 */
function spawnClaudeJson(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--allowedTools', ''],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: childEnvScrubbed() }
    );
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) log.warn(`claude orchestrate exited ${code}`, err.slice(0, 200));
      try {
        const env = JSON.parse(out);
        resolve(typeof env.result === 'string' ? env.result : out);
      } catch {
        resolve(out); // hand raw stdout to the fence-stripping parser
      }
    });
  });
}

/**
 * Robustly parse an orchestrator decompose result into an object.
 * Strips ```json fences and leading/trailing prose around the JSON object.
 * Throws if no valid JSON object can be recovered.
 */
function parseOrchestratorJson(raw) {
  let s = String(raw ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

/**
 * Finalize an orchestrate job as failed while keeping the request in 'requested'
 * (승인 대기 유지) so the admin can retry. A parse/execution failure means the
 * orchestrator could not even render a feasibility verdict — that is NOT a
 * feasibility 'hold' (only an explicit feasible:false is a hold). Writes an
 * error note into both the streaming message and the request.plan.
 */
async function orchestrateFail(job, note, raw = '') {
  const content = `⚠ 오케스트레이션 분해 실패: ${note}`;
  await patchOrchestrationRequest(job.request_id, {
    status: 'requested',
    plan:   { error: note, raw_excerpt: String(raw ?? '').slice(0, 500) },
  });
  finishMessage(job.message_id, { status: 'error', error: note });
  markJob(job.id, 'error', note);
  await patchMessage(job.message_id, {
    streaming: false, status: 'error', content, error: note,
  });
  await markJobStatus(job.id, 'error', note);
  auditLine(job, 'error', `orchestrate_fail note_len=${note.length}`);
  log.warn(`orchestrate failed: job=${job.id} request=${job.request_id} — ${note}`);
  return 'error';
}

/**
 * Finalize an orchestrate job as an explicit feasibility HOLD. The orchestrator
 * judged the request technically infeasible / out of scope → status='hold' +
 * feasibility_reason, and the reason is recorded as the assistant message
 * (subtype='hold_reason', a 노란 콜아웃 in the thread). No subtasks are
 * materialized. The job itself completes ('done') — its job WAS to judge.
 */
async function orchestrateHold(job, plan) {
  const reason = (plan.reason && String(plan.reason).trim())
    || 'AI가 이 요청을 기술적으로 수행 불가하다고 판단했습니다 (사유 미기재).';
  const summary = plan.summary ? String(plan.summary) : '';
  await patchOrchestrationRequest(job.request_id, {
    status:             'hold',
    feasible:           false,
    feasibility_reason: reason,
    plan:               { feasible: false, reason, summary },
  });
  finishMessage(job.message_id, { status: 'ok', error: null });
  markJob(job.id, 'done', null);
  // Record the hold reason as the assistant message (yellow-callout in thread).
  await patchMessage(job.message_id, {
    streaming: false, status: 'ok', content: reason, subtype: 'hold_reason',
  });
  // 스레드 일관성: '보류' 상태칩도 별도 system 메시지로 남긴다
  // (웹의 status_change 칩과 동일 포맷: role=system·subtype=status_change).
  await insertChatMessage({
    id:         mkMessageId(),
    session_id: job.session_id,
    role:       'system',
    agent_id:   'system',
    subtype:    'status_change',
    content:    "'보류'으로 변경",
    status:     'ok',
    streaming:  false,
  });
  await markJobStatus(job.id, 'done', null);
  auditLine(job, 'done', 'orchestrate_hold infeasible');
  log.info(`orchestrate hold: job=${job.id} request=${job.request_id} — infeasible`);
  return 'hold';
}

/**
 * claude CLI 가 JSON 산출 대신 평문 오류를 뱉는 대표 케이스(크레딧 소진·인증 실패)를
 * 감지해 사용자 친화 메시지로 변환. 감지되면 그 메시지, 아니면 null(정상 파싱 진행).
 */
function detectClaudeCliError(raw) {
  const s = String(raw || '').trim();
  if (/credit balance is too low|credit balance/i.test(s)) {
    return 'Anthropic 크레딧이 소진되어 오케스트레이터(claude)가 실행되지 못했습니다. '
         + '크레딧을 충전한 뒤 이 요청을 재기획(또는 재제출)하면 정상적으로 분해됩니다.';
  }
  if (s.length < 500 && /invalid api key|authentication_error|unauthorized|please run .*login|not logged in/i.test(s)) {
    return 'claude 인증/로그인 문제로 오케스트레이터가 실행되지 못했습니다. '
         + '세션 로그인 상태를 확인한 뒤 재시도하세요.';
  }
  return null;
}

/**
 * Decompose a natural-language request into subtasks. Runner-side because the
 * subscription `claude` CLI lives in the WSL daemon (Vercel can't run it).
 * NEVER enqueues execute jobs — human approval on the web board is the only
 * execution trigger (human-in-the-loop invariant, AC 3).
 */
async function handleOrchestrate(job) {
  if (!job.request_id) {
    return orchestrateFail(job, 'orchestrate 잡에 request_id 가 없습니다.');
  }

  // Stream progress into the placeholder message (admin progress/error surface).
  let progress = '';
  const pushProgress = async (line) => {
    progress += line;
    appendDelta(job.message_id, line);              // sqlite local truth
    await patchMessage(job.message_id, { content: progress }); // Supabase absolute
  };
  await pushProgress('오케스트레이션 분해를 시작합니다...\n');

  // Run the decompose LLM (mock canned JSON, or live claude -p json).
  let raw;
  try {
    raw = MOCK_MODE
      ? mockChunks(job.agent_id, job.prompt, 'orchestrate').join('')
      : await spawnClaudeJson(`${buildOrchestratorPrompt(agentCatalog())}\n\n---\n사용자 요청:\n${job.prompt}`);
  } catch (err) {
    return orchestrateFail(job, `분해 실행 오류: ${err?.message ?? String(err)}`);
  }

  // claude CLI 가 JSON 대신 평문 에러(크레딧 소진·인증 등)를 뱉는 경우를 먼저 잡아
  // 헷갈리는 "JSON 파싱 실패" 대신 사용자가 바로 이해할 안내로 바꾼다.
  const cliErr = detectClaudeCliError(raw);
  if (cliErr) {
    return orchestrateFail(job, cliErr, raw);
  }

  // Parse (fence-strip robust).
  let plan;
  try {
    plan = parseOrchestratorJson(raw);
  } catch (err) {
    // Parse failure = no feasibility verdict rendered → keep 'requested' (retriable).
    return orchestrateFail(job, `분해 결과 JSON 파싱 실패: ${err?.message ?? String(err)}`, raw);
  }

  // Feasibility branch: an explicit feasible:false is the ONLY path to 'hold'.
  // Anything else (feasible:true, or missing → treated as feasible) proceeds to
  // decomposition; if it then yields no valid subtasks that is a fail (requested),
  // not a hold.
  if (plan.feasible === false) {
    return orchestrateHold(job, plan);
  }

  // Validate agent_ids against the authoritative .claude/agents/*.md key set.
  const agents  = loadAgents();
  const rawSubs = Array.isArray(plan.subtasks) ? plan.subtasks : [];
  const dropped = rawSubs.filter(s => !s || !agents.has(s.agent_id));
  const valid   = rawSubs.filter(s => s && agents.has(s.agent_id));
  if (valid.length === 0) {
    return orchestrateFail(job, '유효한 agent_id 를 가진 subtask 가 없습니다.', raw);
  }
  if (dropped.length) {
    await pushProgress(`무효 agent_id ${dropped.length}건 드롭.\n`);
  }

  // 서브태스크 상한: 모델 제어 과다 팬아웃 방지. 초과분은 잘라 로그로 남긴다.
  let capped = valid;
  if (valid.length > MAX_SUBTASKS) {
    await pushProgress(`서브태스크 ${valid.length}건 → 상한 ${MAX_SUBTASKS}건으로 절단.\n`);
    log.warn(`orchestrate subtasks truncated ${valid.length}→${MAX_SUBTASKS} request=${job.request_id}`);
    capped = valid.slice(0, MAX_SUBTASKS);
  }

  // 사용자 제목은 절대 덮어쓰지 않는다 — AI title 은 plan 스냅샷(ai_title)에만 보존.
  const aiTitle  = (plan.title && String(plan.title).trim()) || null;
  const summary  = plan.summary ? String(plan.summary) : '';
  // 개발 요청이면 격리 워크트리/브랜치를 계획에 명시(작업 위치). 비개발이면 null.
  const worktree = (plan.worktree && String(plan.worktree).trim()) || null;

  // 재분해 완료 → 승인 대기(requested) 로 복귀. status 를 명시하지 않으면 replan 후
  // 'replanning' 에 영구 고착된다(데드엔드). 초기 생성 흐름은 이미 requested 라 무해.
  // title 컬럼은 사용자 것 보존(미전송).
  await patchOrchestrationRequest(job.request_id, {
    status:             'requested',
    plan:               { summary, worktree, subtasks: capped, ai_title: aiTitle },
    feasible:           true,
    feasibility_reason: null,
    worktree,
  });

  // Materialize 멱등화: reap 재실행·replan 재분해 시 중복을 막으려 기존 서브태스크를
  // 먼저 지우고 다시 넣는다 (delete → insert 순서).
  await deleteOrchestrationSubtasks(job.request_id);

  // Materialize normalized subtask rows (exec_status 'pending').
  await insertOrchestrationSubtasks(capped.map((s, i) => ({
    request_id:  job.request_id,
    ordinal:     i,
    agent_id:    s.agent_id,
    task:        String(s.task ?? ''),
    expected:    s.expected ? String(s.expected) : null,
    exec_status: 'pending',
  })));

  // Finalize message (subtype 'ai_plan') + job.
  const done = `${progress}분해 완료: 하위작업 ${capped.length}개.${summary ? '\n' + summary : ''}`;
  finishMessage(job.message_id, { status: 'ok', error: null });
  markJob(job.id, 'done', null);
  await patchMessage(job.message_id, { streaming: false, status: 'ok', content: done, subtype: 'ai_plan' });
  await markJobStatus(job.id, 'done', null);
  auditLine(job, 'done', `orchestrate subtasks=${capped.length} dropped=${dropped.length}`);
  log.info(`orchestrate done: job=${job.id} request=${job.request_id} subtasks=${capped.length}`);
  return 'done';
}

// ─── Auto-deploy finalize (dev 요청: 승인→실행→커밋→푸시→배포) ───────────────────

// 한 요청을 이 데몬이 배포 처리 중인지 표시(중복 트리거 방지). 데몬은 단일 프로세스·
// 순차 처리라 경합은 없지만, reap 재실행 등에 대한 방어선.
const finalizing = new Set();

/**
 * 요청의 서브태스크가 전부 done 이면 상태를 'ready'(완료대기)로 올리고 브리핑을 남긴다.
 * ★ 여기서 배포하지 않는다 — 관리자가 콘솔에서 결과를 검토하고 '완료 처리'를 눌러야
 *   (dev 요청이면) 배포가 시작된다(finalize job → handleFinalize). 비-dev 는 완료 처리 시 그냥 done.
 * 게이트: mock 아님 · status='approved' · 서브태스크 최소 1개가 전부 done.
 */
async function markReadyIfComplete(requestId) {
  if (MOCK_MODE) return;
  if (finalizing.has(requestId)) return;

  const req = await getOrchestrationRequest(requestId);
  if (!req) return;
  if (req.status !== 'approved') return;       // 승인 상태에서만(이미 ready/done/반려면 스킵)

  const subs = await getOrchestrationSubtasks(requestId);
  if (!subs.length || !subs.every(s => s.exec_status === 'done')) return; // 아직 미완

  finalizing.add(requestId);
  try {
    // CAS: status 가 아직 'approved' 일 때만 'ready' 로 올린다. 마지막 서브태스크 done 직후
    // 잠금이 풀린 짧은 창에 관리자가 반려/기타 전환을 했다면(그때 status≠approved) 0행 갱신 →
    // 그 관리자 결정을 덮어쓰지 않고 완료대기 전이·브리핑을 모두 건너뛴다.
    const applied = await patchOrchestrationRequest(requestId, { status: 'ready' }, { expectStatus: 'approved' });
    if (!applied) {
      log.info(`[deploy] 완료대기 전이 스킵(관리자가 이미 상태 변경) request=${requestId}`);
      return;
    }
    if (req.session_id) {
      await insertChatMessage({
        id: mkMessageId(), session_id: req.session_id, role: 'system', agent_id: 'system',
        subtype: 'status_change', content: "'완료대기'으로 변경", status: 'ok', streaming: false,
      });
      await insertChatMessage({
        id: mkMessageId(), session_id: req.session_id, role: 'assistant', agent_id: 'system',
        subtype: 'done_result', content: buildReadyBriefing(req, subs), status: 'ok', streaming: false,
      });
    }
    log.info(`[deploy] 전 서브태스크 done → 완료대기(ready) request=${requestId}`);
  } catch (err) {
    log.error('markReadyIfComplete 예외', err?.message);
  } finally {
    finalizing.delete(requestId);
  }
}

/**
 * 에이전트 결과 excerpt 에서 한 줄 요약을 뽑는다.
 * 에이전트가 [설명]/[작업내용] 형식으로 보고하면(프리앰블 강제) [설명] 본문만 취해 진행 나레이션을 배제한다.
 * 형식 없는 구(舊) 결과는 앞부분만 잘라 폴백.
 */
function summarizeExcerpt(ex) {
  if (!ex) return '완료';
  const t = ex.replace(/\s+/g, ' ').trim();
  const i = t.indexOf('[설명]');
  if (i >= 0) {
    let after = t.slice(i + '[설명]'.length).trim();
    const stop = after.indexOf('[작업내용]');
    if (stop >= 0) after = after.slice(0, stop).trim();
    if (after) return after.slice(0, 160);
  }
  return t.slice(0, 120);
}

/** 완료대기 브리핑([설명]/[작업내용]) — 관리자가 검토 후 완료 처리하도록 안내. */
function buildReadyBriefing(req, subs) {
  const isDev = isDevRequest(req);
  const lines = [
    '[설명]',
    `요청하신 "${req.title || '작업'}"이 끝나 검토를 기다리고 있습니다. 아래 작업내용을 확인하신 뒤 **완료 처리**를 누르면 ` +
      (isDev ? '실제 사이트에 배포됩니다.' : '마무리됩니다.'),
    '',
    '[작업내용]',
  ];
  for (const s of subs) {
    lines.push(`- **${s.agent_id}**: ${summarizeExcerpt(s.result_excerpt)}`);
  }
  if (isDev && req.worktree) {
    lines.push('', `격리 브랜치 \`${req.worktree}\` 에 커밋되어 있고, 완료 처리 시 main 반영·배포가 자동 진행됩니다.`);
  }
  return lines.join('\n');
}

/**
 * 완료 처리(kind='finalize') 잡 처리 — 관리자가 완료대기에서 '완료 처리'를 눌러 투입한 배포.
 * 사람이 검토 후 명시 트리거한 것이므로 killswitch 를 우회한다(skipKillswitch). dev 요청만 실제 배포.
 */
async function handleFinalize(job) {
  const cfg = loadDeployConfig();
  const req = await getOrchestrationRequest(job.request_id);
  const subs = req ? await getOrchestrationSubtasks(job.request_id) : [];

  // placeholder 를 곧바로 채워 배포(최대 180s) 동안 빈 스트림이 보이지 않게 한다.
  await patchMessage(job.message_id, { streaming: true, status: 'ok', content: '🚀 배포를 진행하고 있습니다… (최대 3분)' });

  // 방어심화: dev팀 에이전트가 실제 배정된 요청만 배포(발행요청 오태깅 차단).
  const devTeam = new Set(agentCatalog().filter(a => a.team === 'dev').map(a => a.id));
  const isDevAssigned = subs.some(s => devTeam.has(s.agent_id));

  let result;
  if (!deployEnabled(cfg)) {
    // enabled=false 는 하드 오프스위치 — 완료 처리(skipKillswitch)여도 배포하지 않는다.
    result = { status: 'error', branch: null, note: '자동배포 설정이 비활성(enabled=false)이라 배포하지 않았습니다. 운영자에게 문의하세요.' };
  } else if (!req) {
    result = { status: 'error', branch: null, note: '요청을 찾을 수 없어 배포를 중단했습니다.' };
  } else if (!isDevRequest(req) || !isDevAssigned) {
    result = { status: 'error', branch: null, note: '개발 요청이 아니어서 배포 대상이 아닙니다.' };
  } else {
    try {
      log.info(`[deploy] 완료 처리 → 배포 시작 request=${job.request_id}`);
      result = await finalizeDeploy(cfg, { request: req, subtasks: subs, log, skipKillswitch: true });
    } catch (err) {
      log.error('finalizeDeploy 예외', err?.message);
      result = { status: 'error', branch: null, note: `배포 중 예외: ${err?.message}` };
    }
  }
  if (req) await writeFinalizeOutcome(req, subs, result);

  // finalize placeholder 메시지 마감(상세 결과는 writeFinalizeOutcome 가 별도 메시지로 남김).
  const line = result.status === 'deployed'
      ? (result.verified
          ? '🚀 배포 반영 완료(사이트 정상 응답 확인) — 상세는 아래 완료 보고를 확인하세요.'
          : '🚀 main 반영·배포 트리거 완료(자동검증 미수행) — 상세는 아래 완료 보고를 확인하세요.')
    : result.status === 'nochange' ? '변경 사항이 없어 배포할 내용이 없었습니다.'
    : `배포를 완료하지 못했습니다: ${result.note}`;
  finishMessage(job.message_id, { status: 'ok', error: null });
  await patchMessage(job.message_id, { streaming: false, status: 'ok', content: line });
  markJob(job.id, 'done');
  await markJobStatus(job.id, 'done', null);
  return 'done';
}

/**
 * 배포 결과를 스레드·상태에 반영한다.
 *  - error/committed_only: 현재 상태 유지(완료 처리 트리거였다면 'ready' 유지 = 재시도 가능) + 안내 메시지만.
 *  - deployed/nochange: status='done' + done_result(평문 요약) 메시지.
 */
async function writeFinalizeOutcome(req, subs, result) {
  const sessionId = req.session_id;
  // 오류·커밋만은 배포까지 못 간 상태 → 'done' 으로 내리지 않고 상태를 유지한다.
  // 완료 처리(finalize)에서 온 경우 'ready'(완료대기)가 유지되어 관리자가 다시 완료 처리로 재시도할 수 있다.
  if (result.status === 'error' || result.status === 'committed_only') {
    const prefix = result.status === 'committed_only' ? 'ℹ️ 배포 보류' : '⚠ 자동 반영 실패';
    if (sessionId) await insertChatMessage({
      id: mkMessageId(), session_id: sessionId, role: 'assistant', agent_id: 'system',
      subtype: null, content: `${prefix}: ${result.note}`, status: 'ok', streaming: false,
    });
    log.warn(`[deploy] finalize ${result.status} request=${req.id}: ${result.note}`);
    return;
  }

  // deployed / nochange → 완료 처리 + done_result.
  const content = buildDeployDoneContent({ request: req, subtasks: subs, result });
  await patchOrchestrationRequest(req.id, {
    status: 'done', decided_at: new Date().toISOString(), decided_by: 'orchestrator-auto',
  });
  if (sessionId) {
    await insertChatMessage({
      id: mkMessageId(), session_id: sessionId, role: 'system', agent_id: 'system',
      subtype: 'status_change', content: "'완료'으로 변경", status: 'ok', streaming: false,
    });
    await insertChatMessage({
      id: mkMessageId(), session_id: sessionId, role: 'assistant', agent_id: 'system',
      subtype: 'done_result', content, status: 'ok', streaming: false,
    });
  }
  log.info(`[deploy] finalize ${result.status} request=${req.id} branch=${result.branch || '-'}`);
}

/**
 * 서브태스크 실패로 파이프라인이 멈췄음을 스레드에 알린다(전부 done 이어야 자동 반영이 진행됨).
 * 실패한 잡 하나당 한 번 호출 — 조용한 무한 대기(approved 고착)를 관리자가 인지하게 한다.
 */
async function notifyPipelineHalt(job) {
  try {
    const req = await getOrchestrationRequest(job.request_id);
    if (!req || !req.session_id) return;
    await insertChatMessage({
      id: mkMessageId(), session_id: req.session_id, role: 'assistant', agent_id: 'system',
      subtype: null,
      content: `⚠ 하위작업(${job.agent_id || '?'})이 실패해 파이프라인이 멈췄습니다. 자동 반영(배포)은 모든 하위작업이 완료돼야 진행됩니다. 재기획하거나 원인을 확인해 주세요.`,
      status: 'ok', streaming: false,
    });
  } catch (err) {
    log.warn('notifyPipelineHalt 실패', err?.message);
  }
}

// ─── Job processor ────────────────────────────────────────────────────────────

async function processJob(job) {
  const kind = job.kind || 'chat';
  log.info(`processing job=${job.id} kind=${kind} agent=${job.agent_id ?? 'none'} session=${job.session_id}`);

  // Mirror job to local sqlite
  upsertJob(job);
  markJob(job.id, 'running');

  // Ensure assistant message placeholder exists locally
  ensureMessage({
    id:         job.message_id,
    session_id: job.session_id,
    role:       'assistant',
    agent_id:   job.agent_id ?? null,
    content:    '',
    streaming:  true,
    status:     'ok',
  });

  // Mark Supabase message as streaming (also resets content for re-runs).
  await patchMessage(job.message_id, { streaming: true, status: 'ok', content: '' });

  // Branch on job kind. 'orchestrate' = decompose (never spawns execute jobs).
  if (kind === 'orchestrate') {
    return await handleOrchestrate(job);
  }

  // 'finalize' = 관리자 '완료 처리' 배포 트리거(사람 게이트). claude 스폰 없이 배포만.
  if (kind === 'finalize') {
    return await handleFinalize(job);
  }

  // 'execute' and 'chat'/undefined both stream a response; only 'execute'
  // additionally finalizes its orchestration subtask row.
  let fullText = '';
  let jobStatus = 'done';
  let jobError  = null;

  // dev(사이트·기능·DB) 요청의 execute 잡은 격리 워크트리에서 실행한다(배포 레포 올바른
  // 트리에 반영). 발행팀·chat 은 devCtx=null → 기존 ROOT 실행. mock 은 워크트리 안 만듦.
  let devCtx = null;
  if (kind === 'execute' && job.request_id && !MOCK_MODE) {
    try {
      const cfg = loadDeployConfig();
      if (deployEnabled(cfg)) {
        const req = await getOrchestrationRequest(job.request_id);
        if (req && isDevRequest(req)) devCtx = prepareDevContext(cfg, req);
      }
    } catch (err) {
      log.warn('dev worktree 준비 실패 — ROOT 로 폴백', err?.message);
    }
  }

  try {
    if (MOCK_MODE) {
      fullText = await streamMock(job, job.message_id);
    } else {
      fullText = await streamLive(job, job.message_id,
        devCtx ? { cwd: devCtx.cwd, promptPrefix: devCtx.preamble } : {});
    }
  } catch (err) {
    log.error('job execution error', err?.message);
    jobStatus = 'error';
    jobError  = err?.message ?? String(err);
    fullText  = '';
  }

  // [설명]/[작업내용] 최종보고만 남기기 — 실행 중 나레이션(진행 문장)은 완료 시점에 잘라낸다.
  // 스트리밍 동안은 진행 상황이 그대로 보이고, 최종 확정본은 보고 섹션부터 시작한다.
  // ([설명] 마커가 없으면(구형 에이전트·오류 등) 전문 유지 — 정보 유실 방지)
  if (kind === 'execute' && jobStatus === 'done' && fullText) {
    const idx = fullText.indexOf('[설명]');
    if (idx > 0) {
      const lineStart = fullText.lastIndexOf('\n', idx) + 1; // "## [설명]" 헤딩 프리픽스 보존
      fullText = fullText.slice(lineStart);
    }
  }

  // Finalize local sqlite
  finishMessage(job.message_id, { status: jobStatus, error: jobError });
  markJob(job.id, jobStatus, jobError);

  // Finalize Supabase — content 를 sqlite 진실원본(fullText)으로 권위적 재동기화.
  // 스트리밍 중 coalescing 으로 일부 중간 쓰기가 합쳐졌어도 최종본은 항상 일치.
  // execute 잡의 완료 메시지는 subtype 'exec'(실행 로그로 스레드에 남김).
  await patchMessage(job.message_id, {
    streaming: false,
    status:    jobStatus,
    content:   fullText,
    ...(kind === 'execute' ? { subtype: 'exec' } : {}),
    ...(jobError ? { error: jobError } : {}),
  });
  await markJobStatus(job.id, jobStatus, jobError);

  // Execute jobs mirror their result onto the orchestration subtask row.
  // 전 서브태스크가 done 이어도 request.status 를 자동 done 으로 내리지 않는다
  // (완료 판정은 관리자 수동 몫 — human-in-the-loop).
  if (kind === 'execute' && job.subtask_id) {
    await patchOrchestrationSubtask(job.subtask_id, {
      exec_status:    jobStatus === 'done' ? 'done' : 'error',
      result_excerpt: (fullText || '').slice(0, 500),
    });
  }

  // 마지막 서브태스크가 done 이 되면 요청을 '완료대기'(ready)로 올린다(배포 안 함).
  // 배포는 관리자가 완료대기 카드를 검토하고 '완료 처리'를 눌러야 시작된다(사람 게이트 = 완료 처리).
  // (설계 변경 2026-07-09: 승인 즉시 자동배포 → 완료대기 후 수동 완료처리 배포).
  if (kind === 'execute' && job.request_id && jobStatus === 'done') {
    void markReadyIfComplete(job.request_id);
  }
  // 서브태스크가 실패하면 파이프라인이 멈춘다(전부 done 이어야 배포) — 관리자에게 알린다.
  if (kind === 'execute' && job.request_id && jobStatus === 'error') {
    void notifyPipelineHalt(job);
  }

  auditLine(job, jobStatus, fullText ? `content_len=${fullText.length}` : '');

  log.info(`job ${jobStatus}: job=${job.id} content_len=${fullText.length}`);
  return jobStatus;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

let lastReap = 0;

/**
 * Reap stale running jobs before claiming. Throttled to REAP_MS so the 1.5s
 * poll loop doesn't hammer PostgREST; force=true runs it immediately (startup).
 * Wrapped so a reap failure never kills the daemon.
 */
async function maybeReap(force = false) {
  if (!force && Date.now() - lastReap < REAP_MS) return;
  lastReap = Date.now();
  try {
    await reapStaleJobs(STALE_MS);
  } catch (err) {
    log.warn('reapStaleJobs error — daemon continues', err?.message);
  }
}

async function pollOnce() {
  // Requeue crashed/killed runner's stuck jobs before claiming (AC 9 resume).
  await maybeReap(ONCE_MODE);

  let job = null;
  try {
    job = await claimPendingJob();
  } catch (err) {
    log.warn('claimPendingJob error', err?.message);
  }
  if (!job) return false;

  // 네트워크 단절 등으로 잡 마무리(patchMessage/markJobStatus)가 실패해도
  // 데몬은 죽지 않는다 — 다음 폴에서 재시도/복구. (2026-07-06 인터넷 단절 사후조치)
  try {
    await processJob(job);
  } catch (err) {
    log.error('processJob error — daemon continues', err?.message);
  }
  return true;
}

async function main() {
  log.info(`agent-runner start (PID=${process.pid} mode=${MOCK_MODE ? 'mock' : 'live'} once=${ONCE_MODE})`);
  writeHeartbeat();

  // Startup reap: requeue jobs left 'running' by a crashed/killed prior daemon.
  if (!ONCE_MODE) await maybeReap(true);

  let lastHeartbeat = Date.now();

  while (running) {
    const didWork = await pollOnce();

    if (ONCE_MODE) {
      if (didWork) {
        log.info('--once: job processed, exiting');
      } else {
        log.info('--once: no pending job found, exiting');
      }
      break;
    }

    // Heartbeat check
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      writeHeartbeat();
      lastHeartbeat = Date.now();
    }

    if (!didWork) {
      // Sleep between polls, interruptible by SIGINT/SIGTERM
      await new Promise((resolve) => {
        const t     = setTimeout(resolve, POLL_MS);
        const check = setInterval(() => {
          if (!running) { clearTimeout(t); clearInterval(check); resolve(undefined); }
        }, 100);
        setTimeout(() => clearInterval(check), POLL_MS + 50);
      });
    }
  }

  log.info('agent-runner stopped');
  process.exit(0);
}

main().catch((err) => {
  log.error('agent-runner fatal', err?.message ?? String(err));
  process.exit(1);
});
