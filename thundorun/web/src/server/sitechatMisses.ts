/**
 * server/sitechatMisses.ts — 사이트챗 미답변 질문 수집 (서버 전용)
 *
 * 폴백 답변(kind='fallback')으로 끝난 방문자 질문을 sitechat_misses 에 기록한다.
 * Stage B(지식 검색) 착수 여부를 판단할 실측 데이터 — 계획
 * .omc/plans/ralplan-homepage-knowledge-chatbot.md §1 의 정량 기준 입력.
 *
 * 원칙:
 * - fire-and-forget: 기록 실패가 채팅 응답을 절대 깨지 않는다.
 * - 방문자 원문은 저장 전 정규화한다(제어문자 제거·공백 축약·길이 상한) — AC-16.
 * - 보존 90일: 기록 시점마다 만료 행을 지운다(주 679PV 트래픽이라 비용 무시 가능) — AC-17.
 */
import { getSupabase } from '@/lib/supabase';

const MAX_LEN = 500;          // route.ts 의 입력 상한과 동일
const RETENTION_DAYS = 90;    // AC-17 보존 정책

/**
 * 방문자 입력 정규화 — 제어문자 제거, 연속 공백 축약, 앞뒤 공백 제거, 길이 상한.
 * 순수 함수(테스트 용이).
 */
export function normalizeMissQuestion(raw: string): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LEN);
}

/**
 * 미답변 질문 기록 + 만료 행 정리. 어떤 실패도 밖으로 던지지 않는다.
 * 호출측은 await 하지 않고 `void recordMiss(q)` 로 흘려보낸다.
 */
export async function recordMiss(rawQuestion: string): Promise<void> {
  const question = normalizeMissQuestion(rawQuestion);
  if (!question) return;

  const db = getSupabase();
  if (!db) return;

  try {
    await db.from('sitechat_misses').insert({ question });

    // 보존 90일 — 삽입 경로에서 함께 정리(별도 cron 불필요한 트래픽 규모).
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    await db.from('sitechat_misses').delete().lt('asked_at', cutoff.toISOString());
  } catch {
    // 조용히 무시 — 수집은 부가 기능이고 응답 경로를 보호한다.
  }
}
