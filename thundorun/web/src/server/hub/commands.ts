/**
 * server/hub/commands.ts — CEO 안전 명령 처리기 (commands.mjs 이식)
 *
 * 보안 계약 (변형 금지):
 *   - SAFE_COMMANDS 화이트리스트 3종(pause_resume·topic_decision·rerun) 외 명령은
 *     어떠한 부수효과도 없이 즉시 거부한다.
 *   - 허용 명령 → appendAudit 감사기록 + appendRecord store 기록.
 *   - 거부 경로: audit/store/killswitch 일체 미접촉 보장.
 */
import { setLocalKill, clearLocalKill, isKilled } from './killswitch';
import { appendAudit, ACTIONS }                   from './audit';
import { appendRecord }                            from './store-supabase';
import { makeLogger }                              from './logger';

const log = makeLogger('hub/commands');

// ─── 화이트리스트 (변형 금지) ──────────────────────────────────────────────────

/**
 * CEO 안전 명령 3종 화이트리스트.
 * 이 목록 외 type 은 부수효과 없이 거부.
 */
export const SAFE_COMMANDS = Object.freeze({
  pause_resume:    '파이프라인 일시중단 / 재개',
  topic_decision:  '주제 승인 또는 거부',
  rerun:           '특정 런 재실행 요청 큐잉',
} as const);

export type SafeCommandType = keyof typeof SAFE_COMMANDS;

// ─── 감사 action 매핑 ─────────────────────────────────────────────────────────

function resolveAuditAction(type: string, args: Record<string, unknown>): string {
  switch (type) {
    case 'pause_resume':   return ACTIONS.KILL;
    case 'topic_decision': return args.choice === 'approve' ? ACTIONS.PUBLISH : ACTIONS.DISCARD;
    case 'rerun':          return ACTIONS.RETRY;
    default:               return 'unknown';
  }
}

// ─── 명령별 처리 ──────────────────────────────────────────────────────────────

async function handlePauseResume(args: Record<string, unknown>) {
  const action = args.action as string;
  if (action !== 'pause' && action !== 'resume') {
    return {
      ok: false, rejected: true,
      reason: `pause_resume: args.action 은 'pause' 또는 'resume' 이어야 합니다 (수신: '${action}')`,
    };
  }
  if (action === 'pause') {
    setLocalKill('CEO 지시: 파이프라인 중단');
  } else {
    clearLocalKill();
  }
  const killStatus = await isKilled();
  return { action, killStatus };
}

async function handleTopicDecision(args: Record<string, unknown>, actor: string) {
  const { choice, topic } = args as { choice?: string; topic?: string };
  if (choice !== 'approve' && choice !== 'reject') {
    return {
      ok: false, rejected: true,
      reason: `topic_decision: args.choice 는 'approve' 또는 'reject' 이어야 합니다 (수신: '${choice ?? ''}')`,
    };
  }
  const decisionRecord = await appendRecord('decision', { topic: topic ?? null, choice, actor });
  log.info(`주제 결정 기록: ${choice} (topic=${topic})`);
  return { choice, topic: topic ?? null, decision_id: decisionRecord.id };
}

async function handleRerun(args: Record<string, unknown>) {
  const target = (args.target as string) ?? null;
  log.info(`재실행 큐잉 — target=${target}`);
  return { target, queued: true, note: '재시도 큐잉됨 — 파이프라인 연동 후 자동 처리' };
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

export interface CommandResult {
  ok: boolean;
  rejected?: boolean;
  reason?: string;
  type?: string;
  result?: unknown;
  command_id?: string | null;
}

/**
 * executeCommand({ type, args, actor }) → CommandResult
 * 화이트리스트 외 type → 즉시 거부 (어떠한 부수효과도 없음).
 * 허용 명령 → 처리 후 appendAudit + appendRecord 기록.
 */
export async function executeCommand({
  type,
  args = {},
  actor = 'ceo',
}: {
  type: string;
  args?: Record<string, unknown>;
  actor?: string;
}): Promise<CommandResult> {
  // ── 화이트리스트 검사 (거부 경로: 이하 부수효과 없음) ──────────────────────
  if (!Object.prototype.hasOwnProperty.call(SAFE_COMMANDS, type)) {
    log.warn(`허용되지 않은 명령 거부: '${type}' (actor=${actor})`);
    return { ok: false, rejected: true, reason: '허용되지 않은 명령' };
  }

  // ── 명령별 처리 ────────────────────────────────────────────────────────────
  let commandResult: Record<string, unknown>;
  switch (type) {
    case 'pause_resume':   commandResult = await handlePauseResume(args);        break;
    case 'topic_decision': commandResult = await handleTopicDecision(args, actor); break;
    case 'rerun':          commandResult = await handleRerun(args);               break;
    default:               commandResult = { ok: false, rejected: true, reason: '알 수 없는 명령' };
  }

  if (commandResult.rejected === true) return commandResult as unknown as CommandResult;

  // ── 감사 기록 ──────────────────────────────────────────────────────────────
  const auditAction = resolveAuditAction(type, args);
  let auditEntry;
  try {
    auditEntry = await appendAudit({
      actor,
      action: auditAction,
      reason: `CEO 명령: ${type} (args=${JSON.stringify(args)})`,
    });
  } catch (err) {
    log.error(`감사로그 기록 실패: ${(err as Error).message}`);
    return { ok: false, reason: `감사로그 기록 실패: ${(err as Error).message}` };
  }

  // ── store 기록 ─────────────────────────────────────────────────────────────
  let commandRecord;
  try {
    commandRecord = await appendRecord('command', {
      kind:      type,
      args,
      actor,
      audit_seq: auditEntry.seq,
      result:    commandResult,
    });
  } catch (err) {
    log.error(`command store 기록 실패: ${(err as Error).message}`);
  }

  const command_id = commandRecord?.id ?? null;
  log.info(`명령 처리 완료: ${type} (command_id=${command_id}, audit_seq=${auditEntry.seq})`);

  return { ok: true, type, result: commandResult, command_id };
}

export function listSafeCommands() {
  return [
    {
      key: 'pause_resume',
      description: SAFE_COMMANDS.pause_resume,
      args: [
        { name: 'action', type: 'string', required: true, values: ['pause', 'resume'], description: '파이프라인 중단 또는 재개' },
      ],
    },
    {
      key: 'topic_decision',
      description: SAFE_COMMANDS.topic_decision,
      args: [
        { name: 'choice', type: 'string', required: true,  values: ['approve', 'reject'], description: '주제 승인 또는 거부' },
        { name: 'topic',  type: 'string', required: false, description: '주제 식별자 (선택)' },
      ],
    },
    {
      key: 'rerun',
      description: SAFE_COMMANDS.rerun,
      args: [
        { name: 'target', type: 'string', required: false, description: "재실행 대상 run_date 또는 'last'" },
      ],
    },
  ];
}
