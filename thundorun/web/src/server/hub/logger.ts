/**
 * server/hub/logger.ts — 최소 console 기반 로거 (log.mjs 대체)
 * Edge Runtime 없음 — API route(Node.js)에서만 사용.
 */

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVELS: Record<Level, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function resolveLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase() as Level;
  return LEVELS[raw] ?? LEVELS.INFO;
}

export function makeLogger(component: string) {
  const minLevel = resolveLevel();

  function fmt(level: Level, msg: string, extra?: unknown): string {
    const ts = new Date().toISOString();
    let line = `[${component} ${ts}] [${level}] ${msg}`;
    if (extra !== undefined) {
      if (extra instanceof Error) line += ` — ${extra.message}`;
      else if (typeof extra === 'object') {
        try { line += ' ' + JSON.stringify(extra); } catch { /* ignore */ }
      } else {
        line += ` ${extra}`;
      }
    }
    return line;
  }

  return {
    debug(msg: string, extra?: unknown) {
      if (minLevel > LEVELS.DEBUG) return;
      process.stdout.write(fmt('DEBUG', msg, extra) + '\n');
    },
    info(msg: string, extra?: unknown) {
      if (minLevel > LEVELS.INFO) return;
      process.stdout.write(fmt('INFO', msg, extra) + '\n');
    },
    warn(msg: string, extra?: unknown) {
      if (minLevel > LEVELS.WARN) return;
      process.stderr.write(fmt('WARN', msg, extra) + '\n');
    },
    error(msg: string, extra?: unknown) {
      if (minLevel > LEVELS.ERROR) return;
      process.stderr.write(fmt('ERROR', msg, extra) + '\n');
    },
  };
}

export const log = makeLogger('hub');
