/**
 * lib/log.mjs — 공용 구조화 로거
 * 레벨: DEBUG < INFO < WARN < ERROR
 * 출력: stderr(WARN/ERROR), stdout(INFO/DEBUG)
 * 포맷: [component YYYY-MM-DDTHH:mm:ss.sssZ] [LEVEL] message
 *
 * 사용:
 *   import { makeLogger } from './lib/log.mjs';
 *   const log = makeLogger('lion');
 *   log.info('시작');
 *   log.warn('예산 80% 소진');
 *   log.error('치명적 오류', err);
 */

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * 현재 로그 레벨 결정.
 * LOG_LEVEL 환경변수 또는 기본 INFO.
 */
function resolveLevel() {
  const raw = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
  return LEVELS[raw] ?? LEVELS.INFO;
}

/**
 * makeLogger(component) → { debug, info, warn, error }
 * component: 로그 접두어 (예: 'lion', 'reddit/fetch', 'gates')
 */
export function makeLogger(component) {
  const minLevel = resolveLevel();

  function fmt(level, msg, extra) {
    const ts = new Date().toISOString();
    let line = `[${component} ${ts}] [${level}] ${msg}`;
    if (extra !== undefined) {
      if (extra instanceof Error) {
        line += ` — ${extra.message}`;
        if (extra.stack && minLevel <= LEVELS.DEBUG) {
          line += `\n${extra.stack}`;
        }
      } else if (typeof extra === 'object') {
        try { line += ' ' + JSON.stringify(extra); } catch { /* ignore */ }
      } else {
        line += ` ${extra}`;
      }
    }
    return line;
  }

  return {
    debug(msg, extra) {
      if (minLevel > LEVELS.DEBUG) return;
      process.stdout.write(fmt('DEBUG', msg, extra) + '\n');
    },
    info(msg, extra) {
      if (minLevel > LEVELS.INFO) return;
      process.stdout.write(fmt('INFO', msg, extra) + '\n');
    },
    warn(msg, extra) {
      if (minLevel > LEVELS.WARN) return;
      process.stderr.write(fmt('WARN', msg, extra) + '\n');
    },
    error(msg, extra) {
      if (minLevel > LEVELS.ERROR) return;
      process.stderr.write(fmt('ERROR', msg, extra) + '\n');
    },
  };
}

/** 기본 로거 (component='app') */
export const log = makeLogger('app');
