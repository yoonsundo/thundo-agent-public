// scripts/lib/claude-cli.mjs — 구독(Claude Code) 기반 LLM 호출. API 종량제(ANTHROPIC_API_KEY)
// 대체용. claude -p 를 spawn 해 완성 텍스트를 반환하며, 자식 env 에서 ANTHROPIC_API_KEY 를
// 제거해 **구독(OAuth) 인증을 강제**한다(종량제 크레딧 소모 방지).
//
// 왜: `claude` CLI 는 env 에 ANTHROPIC_API_KEY 가 있으면 그걸 우선(종량제 과금),
// 없으면 ~/.claude/.credentials.json 구독 로그인을 쓴다. 그래서 키를 지운 env 로 스폰한다.
import { spawn } from 'node:child_process';

/** 구독 강제 env: ANTHROPIC_API_KEY(및 추가 지정) 제거. PATH·HOME 등 나머지는 보존. */
export function subscriptionEnv(extraStrip = []) {
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', ...extraStrip]) delete env[k];
  return env;
}

/** 임의 모델명 → claude CLI 별칭(sonnet|opus|haiku). 기본 sonnet. */
export function toModelAlias(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus'))  return 'opus';
  return 'sonnet';
}

/** 일시적(재시도 가치 있는) 전송 오류인지 판정 — 연결 끊김·타임아웃·과부하·5xx·비정상 종료. */
export function isTransientClaudeError(msg) {
  const s = String(msg || '').toLowerCase();
  return /timeout|connection closed|mid-response|econnreset|etimedout|socket hang up|network|overloaded|rate.?limit|too many requests|\b(429|500|502|503|504|529)\b|claude exit (1|null|137|143)/.test(s);
}

/** 단일 시도: claude -p 를 spawn 해 완성 텍스트 1건 생성. */
function attemptClaudeText({ prompt, system, model, allowedTools, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--allowedTools', allowedTools];
    if (system) args.push('--append-system-prompt', system);
    if (model)  args.push('--model', toModelAlias(model));
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env: subscriptionEnv() });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timeout')); }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(`claude error(${j.subtype || '?'}): ${(j.result || '').slice(0, 300)}`));
        resolve(j.result ?? '');
      } catch {
        resolve(out.trim()); // JSON 아니면 원문(폴백)
      }
    });
  });
}

/**
 * claude -p 로 완성 텍스트 1건 생성(구독 인증, 도구 없음=순수 생성).
 * 일시적 전송 오류(연결 끊김·타임아웃·과부하 등)는 지수 백오프로 자동 재시도한다.
 * 콘텐츠 오류(refusal 등 비-일시적)는 즉시 실패(토큰 낭비 방지).
 * @param {object} o
 * @param {string} o.prompt      사용자 프롬프트(전체 지시 포함)
 * @param {string} [o.system]    추가 시스템 프롬프트(선택)
 * @param {string} [o.model]     모델(별칭으로 정규화). 미지정 시 CLI 기본
 * @param {string} [o.allowedTools] 허용 도구 CSV(기본 ''=도구 없음)
 * @param {number} [o.timeoutMs] 타임아웃(기본 180s)
 * @param {number} [o.retries]   일시적 오류 시 추가 재시도 횟수(기본 2 → 총 3회 시도). env CLAUDE_RETRIES 로 오버라이드
 * @param {number} [o.retryBaseMs] 백오프 기준(기본 2000ms → 2s·4s)
 * @returns {Promise<string>} 모델 출력 텍스트
 */
export async function claudeText({ prompt, system, model, allowedTools = '', timeoutMs = 180_000, retries, retryBaseMs = 2000 }) {
  const parsed = Number.isFinite(retries) ? retries : parseInt(process.env.CLAUDE_RETRIES || '2', 10);
  const maxRetries = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2; // 잘못된 값(NaN·음수)은 기본 2로 — 재시도 도우미가 하드실패하지 않도록
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await attemptClaudeText({ prompt, system, model, allowedTools, timeoutMs });
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries && isTransientClaudeError(e.message)) {
        const wait = retryBaseMs * Math.pow(2, attempt);
        console.error(`[claude-cli] 일시적 오류 재시도 ${attempt + 1}/${maxRetries} (${wait}ms 후): ${String(e.message).slice(0, 120)}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
