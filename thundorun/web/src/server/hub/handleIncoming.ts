/**
 * server/hub/handleIncoming.ts — 인입 메시지 라우터 (handleIncoming 단순화 이식)
 * 사용자 메시지를 명령 vs 질의로 분류해 각 핸들러로 위임.
 * store 에 메시지 기록(role=user + role=assistant) 후 응답 반환.
 */
import { appendRecord }    from './store-supabase';
import { executeCommand, SAFE_COMMANDS }  from './commands';
import { answerQuery }     from './query';
import { makeLogger }      from './logger';

const log = makeLogger('hub/handleIncoming');

// ─── 명령 키워드 탐지 ─────────────────────────────────────────────────────────

interface CommandMatch {
  type: keyof typeof SAFE_COMMANDS;
  args: Record<string, unknown>;
}

function matchCommand(text: string): CommandMatch | null {
  const lower = text.toLowerCase();

  // pause_resume
  if (/파이프라인.*(중단|멈춰|정지|pause)/.test(lower) || /중단.*파이프라인/.test(lower)) {
    return { type: 'pause_resume', args: { action: 'pause' } };
  }
  if (/파이프라인.*(재개|재시작|resume)/.test(lower) || /재개.*파이프라인/.test(lower)) {
    return { type: 'pause_resume', args: { action: 'resume' } };
  }

  // topic_decision — approve
  if (/주제.*(승인|ok|okay|좋아|허락)/.test(lower) || /(승인|approve).*주제/.test(lower)) {
    const topicMatch = text.match(/"([^"]+)"/);
    return { type: 'topic_decision', args: { choice: 'approve', topic: topicMatch ? topicMatch[1] : undefined } };
  }
  // topic_decision — reject
  if (/주제.*(거부|reject|안 돼|불허|거절)/.test(lower) || /(거부|reject).*주제/.test(lower)) {
    const topicMatch = text.match(/"([^"]+)"/);
    return { type: 'topic_decision', args: { choice: 'reject', topic: topicMatch ? topicMatch[1] : undefined } };
  }

  // rerun
  if (/(재실행|다시 실행|rerun|재시도|retry)/.test(lower)) {
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
    return { type: 'rerun', args: { target: dateMatch ? dateMatch[1] : 'last' } };
  }

  return null;
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

export interface IncomingResult {
  ok: boolean;
  kind: 'command' | 'query';
  response: string;
  detail?: unknown;
}

/**
 * handleIncoming({ content, actor }) → IncomingResult
 * 1) store 에 user 메시지 기록
 * 2) 명령 키워드 탐지 → executeCommand
 *    또는 질의 → answerQuery
 * 3) store 에 assistant 응답 기록
 * 4) 결과 반환
 */
export async function handleIncoming({
  content,
  actor = 'ceo',
}: {
  content: string;
  actor?: string;
}): Promise<IncomingResult> {
  if (!content?.trim()) {
    return { ok: false, kind: 'query', response: '메시지 내용이 비어있습니다.' };
  }

  // 1) user 메시지 저장
  await appendRecord('message', { role: 'user', content, actor }).catch(err =>
    log.warn('user 메시지 저장 실패', err)
  );

  const cmdMatch = matchCommand(content);
  let result: IncomingResult;

  if (cmdMatch) {
    // 2a) 명령 처리
    const cmdResult = await executeCommand({ type: cmdMatch.type, args: cmdMatch.args, actor });
    const response = cmdResult.ok
      ? `명령 처리 완료: ${cmdMatch.type} (id: ${cmdResult.command_id ?? '—'})`
      : `명령 거부됨: ${cmdResult.reason ?? '알 수 없는 오류'}`;
    result = { ok: cmdResult.ok, kind: 'command', response, detail: cmdResult };
  } else {
    // 2b) 질의 응답
    const queryResult = await answerQuery(content);
    result = { ok: queryResult.ok, kind: 'query', response: queryResult.answer, detail: { intent: queryResult.intent, source: queryResult.source } };
  }

  // 3) assistant 응답 저장
  await appendRecord('message', { role: 'assistant', content: result.response, kind: result.kind }).catch(err =>
    log.warn('assistant 응답 저장 실패', err)
  );

  log.info(`인입 처리: kind=${result.kind} ok=${result.ok}`);
  return result;
}
