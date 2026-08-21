/**
 * hub/commands.mjs — CEO 안전 명령 처리기
 * 화이트리스트 3종(pause_resume·topic_decision·rerun)만 실행.
 * 허용 외 명령은 어떠한 부수효과도 없이 즉시 거부한다.
 *
 * 설계 원칙:
 *   - SAFE_COMMANDS 화이트리스트 밖 → 거부 (audit/store/killswitch 일체 미접촉)
 *   - 모든 허용 명령 → appendAudit 감사기록 + appendRecord store 기록
 *   - STATE_DIR_OVERRIDE / KILL_SWITCH_PATH 로 경로 격리 가능 (테스트용)
 *   - stdlib 전용, 외부 의존성 없음
 */

import { setLocalKill, clearLocalKill, isKilled } from '../watchdog/killswitch.mjs';
import { appendAudit, ACTIONS }                   from '../audit/append.mjs';
import { appendRecord }                           from './store-supabase.mjs';
import { makeLogger }                             from '../lib/log.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('hub/commands');

// ─── 화이트리스트 ─────────────────────────────────────────────────────────────

/**
 * CEO 안전 명령 3종 화이트리스트.
 * 키 존재 여부로 허용 판정. 값은 한국어 설명(listSafeCommands 재사용).
 */
export const SAFE_COMMANDS = Object.freeze({
  pause_resume:    '파이프라인 일시중단 / 재개',
  topic_decision:  '주제 승인 또는 거부',
  rerun:           '특정 런 재실행 요청 큐잉',
});

// ─── 허용 action 매핑 ────────────────────────────────────────────────────────

/**
 * 명령 종류 → 감사 ACTIONS 매핑.
 * topic_decision 은 choice 에 따라 분기하므로 여기서는 기본값만 정의.
 */
function resolveAuditAction(type, args) {
  switch (type) {
    case 'pause_resume':
      return ACTIONS.KILL;          // 중단·재개 모두 KILL 레코드
    case 'topic_decision':
      return args.choice === 'approve' ? ACTIONS.PUBLISH : ACTIONS.DISCARD;
    case 'rerun':
      return ACTIONS.RETRY;
    default:
      return null;
  }
}

// ─── 명령별 실행 로직 ─────────────────────────────────────────────────────────

/**
 * pause_resume 처리.
 * args.action: 'pause' → setLocalKill / 'resume' → clearLocalKill
 * 둘 다 아니면 거부(부수효과 없음).
 */
async function handlePauseResume(args) {
  const { action } = args;
  if (action !== 'pause' && action !== 'resume') {
    return {
      ok: false,
      rejected: true,
      reason: `pause_resume: args.action 은 'pause' 또는 'resume' 이어야 합니다 (수신: '${action}')`,
    };
  }

  if (action === 'pause') {
    setLocalKill('CEO 지시: 파이프라인 중단');
    log.info('CEO 지시: 파이프라인 중단 — 킬스위치 설정');
  } else {
    clearLocalKill();
    log.info('CEO 지시: 파이프라인 재개 — 킬스위치 해제');
  }

  // 처리 후 현재 킬스위치 상태 확인
  const killStatus = await isKilled();
  return { action, killStatus };
}

/**
 * topic_decision 처리.
 * args.choice: 'approve' | 'reject'
 * args.topic: 주제 식별자(선택)
 */
async function handleTopicDecision(args, actor) {
  const { choice, topic } = args;
  if (choice !== 'approve' && choice !== 'reject') {
    return {
      ok: false,
      rejected: true,
      reason: `topic_decision: args.choice 는 'approve' 또는 'reject' 이어야 합니다 (수신: '${choice}')`,
    };
  }

  // 통합 store 는 Supabase I/O(네트워크) 가능 — 쓰기 실패해도 명령 처리는 계속(감사로그·결과 반환).
  // appendRecord('command') 의 graceful 패턴과 동일하게 처리한다.
  let decisionRecord = null;
  try {
    decisionRecord = await appendRecord('decision', { topic: topic || null, choice, actor });
  } catch (err) {
    log.error(`decision store 기록 실패: ${err.message}`);
  }
  log.info(`주제 결정 기록: ${choice} (topic=${topic})`);
  return { choice, topic: topic || null, decision_id: decisionRecord?.id || null };
}

/**
 * rerun 처리.
 * args.target: run_date 또는 'last' 같은 식별자
 *
 * 실제 런 재트리거는 run-lion.mjs 연동 지점에서 처리 예정.
 * 여기서는 재시도 의도를 store 에 기록하는 역할만 한다.
 */
function handleRerun(args) {
  const { target } = args;
  // 설계상 경계: 재시도 '의도 기록'까지가 이 명령의 책임이다. 실제 런 재트리거는
  // run-lion.mjs 가 command JSONL 의 rerun 레코드를 소비할 때 수행한다(범위 외, 의도적 분리).
  log.info(`재실행 큐잉 — target=${target}`);
  return { target: target || null, queued: true, note: '재시도 큐잉됨 — run-lion 연동 후 자동 처리' };
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * executeCommand({ type, args, actor }) → { ok, type, result, command_id } | { ok:false, rejected, reason }
 *
 * 화이트리스트 외 type → 즉시 거부 (audit·store·killswitch 미접촉 보장).
 * 허용 명령 → 처리 후 appendAudit + appendRecord 기록.
 */
export async function executeCommand({ type, args = {}, actor = 'ceo' } = {}) {
  // ── 화이트리스트 검사 (거부 경로: 이하 어떠한 부수효과도 없음) ──────────────
  if (!Object.prototype.hasOwnProperty.call(SAFE_COMMANDS, type)) {
    log.warn(`허용되지 않은 명령 거부: '${type}' (actor=${actor})`);
    return { ok: false, rejected: true, reason: '허용되지 않은 명령' };
  }

  // ── 명령별 처리 ──────────────────────────────────────────────────────────────
  let commandResult;
  switch (type) {
    case 'pause_resume': {
      commandResult = await handlePauseResume(args);
      break;
    }
    case 'topic_decision': {
      commandResult = await handleTopicDecision(args, actor);
      break;
    }
    case 'rerun': {
      commandResult = handleRerun(args);
      break;
    }
  }

  // 내부 처리에서 거부된 경우 (args 검증 실패 등)
  if (commandResult && commandResult.rejected === true) {
    return commandResult;
  }

  // ── 감사 기록 (a) ────────────────────────────────────────────────────────────
  const auditAction = resolveAuditAction(type, args);
  let auditEntry;
  try {
    auditEntry = appendAudit({
      actor,
      action: auditAction,
      reason: `CEO 명령: ${type} (args=${JSON.stringify(args)})`,
    });
  } catch (err) {
    log.error(`감사로그 기록 실패 — 명령 처리 중단: ${err.message}`);
    return { ok: false, rejected: false, reason: `감사로그 기록 실패: ${err.message}` };
  }

  // ── store 기록 (b) ───────────────────────────────────────────────────────────
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
    log.error(`command store 기록 실패: ${err.message}`);
    // 감사로그는 이미 append 됐으므로 경고만 남기고 진행
  }

  const command_id = commandRecord?.id || null;
  log.info(`명령 처리 완료: ${type} (command_id=${command_id}, audit_seq=${auditEntry.seq})`);

  return {
    ok: true,
    type,
    result: commandResult,
    command_id,
  };
}

/**
 * listSafeCommands() → 명령 메타 배열
 * 대시보드·봇이 버튼 생성 시 사용. 3종 고정.
 */
export function listSafeCommands() {
  return [
    {
      key:         'pause_resume',
      description: SAFE_COMMANDS.pause_resume,
      args:        [
        { name: 'action', type: 'string', required: true, values: ['pause', 'resume'], description: '파이프라인 중단 또는 재개' },
      ],
    },
    {
      key:         'topic_decision',
      description: SAFE_COMMANDS.topic_decision,
      args:        [
        { name: 'choice', type: 'string', required: true,  values: ['approve', 'reject'], description: '주제 승인 또는 거부' },
        { name: 'topic',  type: 'string', required: false, description: '주제 식별자 (선택)' },
      ],
    },
    {
      key:         'rerun',
      description: SAFE_COMMANDS.rerun,
      args:        [
        { name: 'target', type: 'string', required: false, description: "재실행 대상 run_date 또는 'last'" },
      ],
    },
  ];
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
// 사용법: node commands.mjs <type> [arg...]
//   node commands.mjs pause_resume pause
//   node commands.mjs pause_resume resume
//   node commands.mjs topic_decision approve t1
//   node commands.mjs rerun last
//   node commands.mjs list

if (isMainModule(import.meta.url)) {
  const [, , type, arg1, arg2] = process.argv;

  if (!type || type === 'list') {
    console.log('안전 명령 목록:');
    console.log(JSON.stringify(listSafeCommands(), null, 2));
    process.exit(0);
  }

  // 명령별 args 조립
  let args = {};
  if (type === 'pause_resume')   args = { action: arg1 };
  if (type === 'topic_decision') args = { choice: arg1, topic: arg2 };
  if (type === 'rerun')          args = { target: arg1 };

  executeCommand({ type, args, actor: 'ceo-cli' })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    })
    .catch(err => {
      console.error('명령 실행 오류:', err.message);
      process.exit(2);
    });
}
