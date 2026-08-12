/**
 * server/hub/briefing.ts — CEO 브리핑 생성기 (briefing.mjs 이식)
 * 최신 run.json 을 읽어 4섹션(yesterday·budget·alerts·decisions) 브리핑 생성.
 * RUNS_DIR_OVERRIDE 또는 process.cwd()/../../../runs 에서 run.json 탐색.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { paths, loadBudget } from './config';
import { makeLogger } from './logger';
import { appendRecord } from './store-supabase';

const log = makeLogger('hub/briefing');

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

function getLastAttempt(attempts: unknown[]): Record<string, unknown> | null {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  return attempts[attempts.length - 1] as Record<string, unknown>;
}

// ─── run.json 로더 ────────────────────────────────────────────────────────────

export function loadLatestRun(): Record<string, unknown> | null {
  if (!existsSync(paths.runs)) {
    log.warn(`runs 디렉토리 없음: ${paths.runs}`);
    return null;
  }

  let entries;
  try { entries = readdirSync(paths.runs, { withFileTypes: true }); }
  catch { return null; }

  const dateFolders = entries
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();

  for (const folder of dateFolders) {
    const p = path.join(paths.runs, folder, 'run.json');
    if (!existsSync(p)) continue;
    try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; }
    catch { /* 손상 파일 건너뜀 */ }
  }
  return null;
}

// ─── 브리핑 데이터 타입 ───────────────────────────────────────────────────────

export interface BriefingData {
  yesterday: { published: number; failed: number; discarded: number; titles: string[] };
  budget:    { hard_cap: unknown; spent: unknown; remaining: number | null; trend: null };
  alerts:    Array<{ type: string; severity: string; detail: string }>;
  decisions: Array<{ item: string; options: string[] }>;
}

// ─── 브리핑 빌드 ──────────────────────────────────────────────────────────────

export function buildBriefing(runJson: Record<string, unknown> | null): BriefingData {
  const run = (runJson && typeof runJson === 'object') ? runJson : {} as Record<string, unknown>;
  const drafts = Array.isArray(run.drafts) ? run.drafts as Record<string, unknown>[] : [];

  const publishedTitles: string[] = [];
  let failedCount    = 0;
  let discardedCount = 0;

  for (const draft of drafts) {
    const title = (draft.title as string) || (draft.draft_id as string) || '(제목 없음)';
    const lastAttempt = getLastAttempt(Array.isArray(draft.attempts) ? draft.attempts as unknown[] : []);

    if (!draft.slug) {
      discardedCount++;
    } else if (lastAttempt && lastAttempt.gate_pass === true) {
      publishedTitles.push(title);
    } else {
      failedCount++;
    }
  }

  const budgetConf = loadBudget() ?? {};
  const hardCap    = (budgetConf.daily_hard_cap as unknown) ?? null;
  const spent      = (run.cost ?? run.spend ?? run.tokens_used ?? null) as unknown;

  let remaining: number | null = null;
  if (hardCap !== null && spent !== null) {
    const capVal   = typeof hardCap === 'number' ? hardCap : ((hardCap as Record<string, unknown>).tokens as number ?? null);
    const spentVal = typeof spent   === 'number' ? spent   : null;
    if (capVal !== null && spentVal !== null) remaining = capVal - spentVal;
  }

  const alerts: BriefingData['alerts'] = [];
  if (run.status && run.status !== 'success') {
    alerts.push({ type: 'run_status', severity: run.status === 'partial' ? 'warn' : 'error', detail: `런 상태 비정상: ${run.status as string}` });
  }
  for (const draft of drafts) {
    const title    = (draft.title as string) || '(제목 없음)';
    const attempts = Array.isArray(draft.attempts) ? draft.attempts as Record<string, unknown>[] : [];
    const last     = getLastAttempt(attempts);
    if (last && last.gate_pass === false) {
      const failedGates = ((last.gate_gates as Record<string, unknown>[] ?? []).filter(g => !g.pass).map(g => g.gate as string)).join(', ');
      alerts.push({ type: 'draft_failed', severity: 'warn', detail: `초안 게이트 실패 — "${title}": [${failedGates || '알 수 없음'}]` });
    }
    if (attempts.length >= 2 && attempts.every(a => a.gate_pass === false)) {
      alerts.push({ type: 'gate_repeat_fail', severity: 'error', detail: `게이트 반복탈락(${attempts.length}회) — "${title}"` });
    }
  }

  const decisions: BriefingData['decisions'] = publishedTitles.map(title => ({
    item: `발행 후보 — "${title}"`, options: ['approve', 'reject'],
  }));

  return {
    yesterday: { published: publishedTitles.length, failed: failedCount, discarded: discardedCount, titles: publishedTitles },
    budget:    { hard_cap: hardCap, spent, remaining, trend: null },
    alerts,
    decisions,
  };
}

export function formatBriefingText(briefing: BriefingData): string {
  const { yesterday, budget, alerts, decisions } = briefing;
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`📋 CEO 일일 브리핑 — ${today}`, ''];

  lines.push('## 📰 1. 어제 발행 성과');
  lines.push(`- 발행 완료: ${yesterday.published}편`);
  for (const t of yesterday.titles) lines.push(`  • ${t}`);
  lines.push(`- 게이트 실패: ${yesterday.failed}편`);
  lines.push(`- 폐기: ${yesterday.discarded}편`, '');

  lines.push('## 💰 2. 예산 현황');
  lines.push(`- 일일 하드캡: ${budget.hard_cap ? JSON.stringify(budget.hard_cap) : '정보 없음'}`);
  lines.push(`- 이번 런 사용량: ${budget.spent !== null && budget.spent !== undefined ? String(budget.spent) : '데이터 없음'}`);
  lines.push(`- 잔여 추정: ${budget.remaining !== null ? budget.remaining : '—'}`);
  lines.push(`- 추세: 단기 데이터 부족`, '');

  lines.push('## 🚨 3. 알림');
  if (alerts.length === 0) {
    lines.push('- 이상 없음 ✅');
  } else {
    for (const a of alerts) {
      lines.push(`- ${a.severity === 'error' ? '🔴' : '🟡'} [${a.type}] ${a.detail}`);
    }
  }
  lines.push('');

  lines.push('## ✅ 4. 의사결정 대기');
  if (decisions.length === 0) {
    lines.push('- 대기 항목 없음');
  } else {
    for (const d of decisions) {
      lines.push(`- ${d.item}`);
      lines.push(`  선택: ${d.options.join(' / ')}`);
    }
  }
  return lines.join('\n');
}

export async function generateBriefing(): Promise<Record<string, unknown>> {
  const runJson  = loadLatestRun();
  const briefing = buildBriefing(runJson);

  if (!runJson) {
    briefing.alerts.push({ type: 'no_run', severity: 'warn', detail: '최근 런 없음 — runs/ 디렉토리에 유효한 run.json 없음' });
  }

  const text     = formatBriefingText(briefing);
  const run_date = (runJson?.date as string) || new Date().toISOString().slice(0, 10);

  const record = await appendRecord('briefing', { ...briefing, text, run_date });
  log.info(`브리핑 생성 완료 (run_date=${run_date}, published=${briefing.yesterday.published})`);
  return record;
}
