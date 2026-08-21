/**
 * hub/telegram-bot.mjs — CEO 창고 Telegram 양방향 봇
 * 기존 단방향 알림(notify/telegram.mjs)을 확장해 양방향 대화를 지원한다.
 *
 * 기능:
 *   pushBriefing    : 일일 브리핑을 Telegram 으로 발송
 *   handleIncoming  : 메시지 라우팅 (한국어 명령 → executeCommand, 질의 → answerQuery)
 *   pollMockInbox   : mock 전용 — .mock-out/hub-inbox.jsonl 미처리 메시지 처리
 *   pollLiveUpdates : live 전용 — Telegram getUpdates 롱폴링 1회 단위
 *
 * 설계 원칙:
 *   - 안전 명령 3종 화이트리스트(commands.mjs)만 실행 — 임의 명령 경로 없음
 *   - throw 대신 로깅+합리적 기본값 (방어적)
 *   - stdlib 전용, 외부 의존성 없음
 *   - STATE_DIR_OVERRIDE / KILL_SWITCH_PATH 로 경로 격리 가능 (테스트 지원)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateBriefing, formatBriefingText } from './briefing.mjs';
import { executeCommand, listSafeCommands }      from './commands.mjs';
import { answerQuery }                           from './query.mjs';
import { sendTelegram }                          from '../notify/telegram.mjs';
import { isMock, env, paths }                   from '../lib/config.mjs';
import { makeLogger }                            from '../lib/log.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('hub/telegram-bot');

// ─── 명령 키워드 매핑 ─────────────────────────────────────────────────────────

/**
 * 텍스트에서 명령을 부분일치로 감지한다.
 * 반환: { type, args } | null — 안전 3종 내에서만.
 */
function matchCommand(text) {
  const t = String(text ?? '');

  // 중단 계열
  if (['멈춰', '중단', '정지', '멈춤'].some(kw => t.includes(kw))) {
    return { type: 'pause_resume', args: { action: 'pause' } };
  }

  // 재개 계열
  if (['재개', '다시 시작', '시작해'].some(kw => t.includes(kw))) {
    return { type: 'pause_resume', args: { action: 'resume' } };
  }

  // 승인 계열
  if (['승인', '발행해'].some(kw => t.includes(kw))) {
    return { type: 'topic_decision', args: { choice: 'approve', topic: extractTopic(t) } };
  }

  // 거부 계열
  if (['거부', '반려', '폐기'].some(kw => t.includes(kw))) {
    return { type: 'topic_decision', args: { choice: 'reject', topic: extractTopic(t) } };
  }

  // 재실행 계열
  if (['재실행', '재시도', '다시 돌려'].some(kw => t.includes(kw))) {
    return { type: 'rerun', args: { target: 'last' } };
  }

  return null;
}

/**
 * 메시지에서 topic 힌트를 추출한다 (선택적).
 * 따옴표 ("…" / '…') 또는 '주제:' 뒤 텍스트를 우선 추출.
 * 추출 불가 시 null 반환.
 */
function extractTopic(text) {
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1].trim();

  const afterColon = text.match(/주제[:：]\s*(.+)/);
  if (afterColon) return afterColon[1].trim();

  return null;
}

/**
 * 명령 실행 결과를 한국어 reply 문자열로 변환한다.
 */
function formatCommandReply(type, args, result) {
  if (!result.ok) {
    return `명령 거부됨: ${result.reason ?? '알 수 없는 이유'}`;
  }

  switch (type) {
    case 'pause_resume': {
      const action    = args.action === 'pause' ? '중단' : '재개';
      const status    = result.result?.killStatus;
      const statusStr = typeof status === 'boolean'
        ? (status ? ' (킬스위치 ON)' : ' (킬스위치 OFF)')
        : '';
      return `파이프라인 ${action} 명령 완료.${statusStr}`;
    }
    case 'topic_decision': {
      const choice = args.choice === 'approve' ? '승인' : '거부';
      const topic  = result.result?.topic ? `"${result.result.topic}"` : '주제';
      const did    = result.result?.decision_id ?? '-';
      return `${topic} ${choice} 기록 완료 (decision_id: ${did}).`;
    }
    case 'rerun': {
      const target = result.result?.target ?? 'last';
      return `재실행 요청 큐잉 완료 (target=${target}). run-lion 연동 후 처리됩니다.`;
    }
    default:
      return `명령 처리 완료 (type=${type}).`;
  }
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * pushBriefing(opts={}) — 일일 브리핑 생성 후 Telegram 발송.
 *
 * generateBriefing → formatBriefingText(또는 record.text) → sendTelegram('BRIEFING', …)
 *
 * @param {object} opts - generateBriefing 에 전달할 옵션
 * @returns {Promise<{ pushed: boolean, briefing_id: string|null }>}
 */
export async function pushBriefing(opts = {}) {
  try {
    const record = await generateBriefing(opts);
    // record.text 가 있으면 그대로 사용, 없으면 formatBriefingText 로 재생성
    const text = record.text || formatBriefingText(record);
    await sendTelegram('BRIEFING', { details: text });
    log.info(`브리핑 발송 완료 (briefing_id=${record.id})`);
    return { pushed: true, briefing_id: record.id };
  } catch (err) {
    log.error('브리핑 발송 실패', err?.message);
    return { pushed: false, briefing_id: null };
  }
}

/**
 * handleIncoming(text, ctx={}) — 들어온 메시지를 라우팅한다.
 *
 * 명령 키워드 부분일치 → executeCommand (안전 3종 화이트리스트 적용)
 * 매칭 없음 → answerQuery 로 Q&A 응답
 *
 * @param {string} text   - CEO 메시지
 * @param {object} ctx    - 컨텍스트 (actor 등 확장용)
 * @returns {Promise<{ kind: 'command'|'query', reply: string }>}
 */
export async function handleIncoming(text, ctx = {}) {
  const actor   = ctx.actor || 'ceo';
  const matched = matchCommand(text);

  if (matched) {
    // 안전 명령 3종 화이트리스트 — commands.mjs 내부에서도 재검사하지만 명시적으로 확인
    const safeCmds = listSafeCommands().map(c => c.key);
    if (!safeCmds.includes(matched.type)) {
      log.warn(`허용되지 않은 명령 차단: ${matched.type}`);
      return { kind: 'command', reply: '허용되지 않은 명령입니다. (안전 명령 3종만 지원)' };
    }

    let result;
    try {
      result = await executeCommand({ type: matched.type, args: matched.args, actor });
    } catch (err) {
      log.error('명령 실행 오류', err?.message);
      return {
        kind:  'command',
        reply: `명령 실행 중 오류가 발생했습니다: ${err?.message ?? '알 수 없는 오류'}`,
      };
    }

    const reply = formatCommandReply(matched.type, matched.args, result);
    return { kind: 'command', reply };
  }

  // 키워드 없음 → 질의 응답
  let qResult;
  try {
    qResult = answerQuery(text);
  } catch (err) {
    log.error('질의 응답 오류', err?.message);
    return { kind: 'query', reply: '질의 처리 중 오류가 발생했습니다.' };
  }

  return { kind: 'query', reply: qResult.answer };
}

// ─── mock 인박스 처리 ─────────────────────────────────────────────────────────

/**
 * pollMockInbox() — mock 전용.
 * .mock-out/hub-inbox.jsonl 의 각 줄 {text} 을 읽어
 * 아직 처리하지 않은 행만 handleIncoming 으로 처리한다.
 * 처리 커서를 .mock-out/hub-inbox.cursor 에 저장해 재처리를 방지한다.
 *
 * @returns {Promise<Array<{ text: string, kind: string, reply: string }>>}
 */
export async function pollMockInbox() {
  const mockDir    = paths.mockOut;
  const inboxPath  = join(mockDir, 'hub-inbox.jsonl');
  const cursorPath = join(mockDir, 'hub-inbox.cursor');

  if (!existsSync(inboxPath)) {
    log.warn('mock inbox 파일 없음:', inboxPath);
    return [];
  }

  // 커서 로드 (마지막 처리 행 인덱스, 0-based)
  let cursor = 0;
  if (existsSync(cursorPath)) {
    try {
      const raw = readFileSync(cursorPath, 'utf8').trim();
      cursor = parseInt(raw, 10) || 0;
    } catch {
      cursor = 0;
    }
  }

  // inbox 전체 읽기
  let lines;
  try {
    lines = readFileSync(inboxPath, 'utf8').trimEnd().split('\n').filter(Boolean);
  } catch (err) {
    log.error('inbox 읽기 실패', err?.message);
    return [];
  }

  const unprocessed = lines.slice(cursor);
  const results     = [];

  for (const line of unprocessed) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn('inbox 줄 파싱 실패 (건너뜀):', line);
      cursor++;
      continue;
    }

    const text = msg.text || '';
    let out;
    try {
      out = await handleIncoming(text);
    } catch (err) {
      log.error('handleIncoming 오류', err?.message);
      out = { kind: 'error', reply: `처리 오류: ${err?.message}` };
    }

    console.log(`[inbox] "${text}" → [${out.kind}] ${out.reply}`);
    results.push({ text, ...out });
    cursor++;
  }

  // 커서 저장
  try {
    if (!existsSync(mockDir)) mkdirSync(mockDir, { recursive: true });
    writeFileSync(cursorPath, String(cursor), 'utf8');
  } catch (err) {
    log.warn('커서 저장 실패', err?.message);
  }

  return results;
}

// ─── live 폴링 ────────────────────────────────────────────────────────────────

/**
 * pollLiveUpdates(offset) — live 전용, 1회 폴링 단위.
 * 실제 무한루프 데몬은 CLI 쪽에서 구현 — 이 함수는 1회 getUpdates 단위.
 * TELEGRAM_BOT_TOKEN 없으면 경고 후 no-op.
 * 각 message.text → handleIncoming → sendTelegram('BOT_REPLY', …) 로 발송.
 *
 * @param {number} [offset=0] - Telegram getUpdates offset (처리 완료 update_id + 1)
 * @returns {Promise<number>}  - 다음 폴링에 사용할 새 offset
 */
export async function pollLiveUpdates(offset = 0) {
  const botToken = env('TELEGRAM_BOT_TOKEN');
  if (!botToken) {
    log.warn('TELEGRAM_BOT_TOKEN 없음 — live 폴링 불가');
    return offset;
  }

  const apiUrl = `https://api.telegram.org/bot${botToken}/getUpdates`;
  let updates;

  try {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        offset,
        timeout:         30,            // 롱폴링 30초
        allowed_updates: ['message'],
      }),
      signal: AbortSignal.timeout(40_000), // 네트워크 타임아웃 40초
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error(`getUpdates 실패 ${res.status}: ${body}`);
      return offset;
    }

    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) {
      log.warn('getUpdates 응답 이상:', JSON.stringify(data));
      return offset;
    }
    updates = data.result;
  } catch (err) {
    log.error('getUpdates 네트워크 오류', err?.message);
    return offset;
  }

  let nextOffset = offset;

  for (const update of updates) {
    nextOffset = Math.max(nextOffset, update.update_id + 1);
    const text = update.message?.text;
    if (!text) continue;

    let result;
    try {
      result = await handleIncoming(text, { actor: 'ceo' });
    } catch (err) {
      log.error('handleIncoming 오류', err?.message);
      result = { kind: 'error', reply: '처리 중 오류가 발생했습니다.' };
    }

    // reply 를 Telegram 으로 발송 (sendTelegram 은 TELEGRAM_CHAT_ID env 사용)
    try {
      await sendTelegram('BOT_REPLY', { details: result.reply });
    } catch (err) {
      log.error('reply 발송 오류', err?.message);
    }
  }

  return nextOffset;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
// 사용법:
//   node scripts/hub/telegram-bot.mjs push          — 브리핑 생성 후 Telegram 발송
//   node scripts/hub/telegram-bot.mjs poll          — 인박스 폴링 (mock/live 자동 감지)
//   node scripts/hub/telegram-bot.mjs say "멈춰"   — 단일 메시지 처리 후 reply 출력

if (isMainModule(import.meta.url)) {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  if (cmd === 'push') {
    pushBriefing()
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(err => { console.error(err.message); process.exit(1); });

  } else if (cmd === 'poll') {
    const fn = isMock() ? pollMockInbox() : pollLiveUpdates();
    Promise.resolve(fn)
      .then(r => console.log(JSON.stringify(r, null, 2)))
      .catch(err => { console.error(err.message); process.exit(1); });

  } else if (cmd === 'say') {
    if (!arg) {
      console.error('사용법: telegram-bot.mjs say "메시지"');
      process.exit(1);
    }
    handleIncoming(arg)
      .then(r => console.log(`[${r.kind}] ${r.reply}`))
      .catch(err => { console.error(err.message); process.exit(1); });

  } else {
    console.log('사용법: telegram-bot.mjs <push|poll|say> [메시지]');
    process.exit(0);
  }
}
