/**
 * hub/briefing.mjs — CEO 업무 브리핑 생성기
 * 최신 run.json 을 읽어 4섹션(yesterday·budget·alerts·decisions) 브리핑 객체를 만들고
 * store 에 persist 한다. formatBriefingText 로 한국어 채팅 텍스트로 렌더링.
 *
 * 발행 여부 판단 기준 (주석):
 *   draft.slug 있고 최종 attempt gate_pass=true → "발행 후보(published)"로 집계.
 *   published/ 폴더 복사 여부는 run.json 만으로 단정 불가이므로 gate_pass 기준을 사용.
 *
 * 설계 원칙:
 *   - run.json 필드 누락/형식이상에도 throw 없이 합리적 기본값 반환
 *   - stdlib 전용, 외부 의존성 없음
 *   - STATE_DIR_OVERRIDE / RUNS_DIR_OVERRIDE 로 경로 격리 가능 (테스트 지원)
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths, loadBudget } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
import { appendRecord } from './store-supabase.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('hub/briefing');

// ─── 내부 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * draft.attempts 배열에서 마지막 시도 객체를 반환.
 * 비어있거나 배열이 아니면 null.
 */
function getLastAttempt(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  return attempts[attempts.length - 1];
}

/**
 * 날짜 폴더 내 run.json 경로 반환. 존재하지 않으면 null.
 */
function runJsonPath(dateFolder) {
  return join(paths.runs, dateFolder, 'run.json');
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * loadLatestRun() → 가장 최근 날짜 폴더의 run.json 객체, 없으면 null.
 * paths.runs 하위에서 YYYY-MM-DD 패턴 폴더를 내림차순 정렬해 첫 번째 유효한 파일을 반환.
 */
export function loadLatestRun() {
  if (!existsSync(paths.runs)) {
    log.warn(`runs 디렉토리 없음: ${paths.runs}`);
    return null;
  }

  let entries;
  try {
    entries = readdirSync(paths.runs, { withFileTypes: true });
  } catch (err) {
    log.warn('runs 디렉토리 읽기 실패', err);
    return null;
  }

  // YYYY-MM-DD 패턴 폴더만 추출, 내림차순 정렬(최신 우선)
  const dateFolders = entries
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map(e => e.name)
    .sort()
    .reverse();

  for (const folder of dateFolders) {
    const p = runJsonPath(folder);
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      log.warn(`run.json 파싱 실패: ${p}`, err);
      // 손상된 파일은 건너뛰고 다음 날짜 시도
    }
  }

  log.warn('유효한 run.json 을 찾지 못함');
  return null;
}

/**
 * buildBriefing(runJson, opts) → { yesterday, budget, alerts, decisions }
 *
 * @param {object|null} runJson  - 파싱된 run.json 객체 (null 허용)
 * @param {object}      opts     - 미래 확장용 옵션 (현재 미사용)
 * @returns {{ yesterday, budget, alerts, decisions }}
 */
export function buildBriefing(runJson, opts = {}) {
  const run = (runJson && typeof runJson === 'object') ? runJson : {};

  // ─── yesterday 섹션 ─────────────────────────────────────────────────────────
  const drafts = Array.isArray(run.drafts) ? run.drafts : [];

  const publishedTitles = [];
  const failedCount   = { n: 0 };
  const discardedCount = { n: 0 };

  for (const draft of drafts) {
    const title = draft.title || draft.draft_id || '(제목 없음)';
    const lastAttempt = getLastAttempt(draft.attempts);

    if (!draft.slug) {
      // slug 없음 → gate 진입 전 폐기
      discardedCount.n++;
    } else if (lastAttempt && lastAttempt.gate_pass === true) {
      // slug 있고 최종 gate 통과 → 발행 후보
      publishedTitles.push(title);
    } else {
      // gate 실패 또는 attempts 없음
      failedCount.n++;
    }
  }

  const yesterday = {
    published:  publishedTitles.length,
    failed:     failedCount.n,
    discarded:  discardedCount.n,
    titles:     publishedTitles,
  };

  // ─── budget 섹션 ────────────────────────────────────────────────────────────
  const budgetConf = loadBudget() || {};
  const hardCap = budgetConf.daily_hard_cap || null;

  // run.json 에 비용 전용 필드 없음 → null (run.json 스키마에 cost/spend 없음)
  const spent = run.cost ?? run.spend ?? run.tokens_used ?? null;

  let remaining = null;
  if (hardCap !== null && spent !== null) {
    // daily_hard_cap 이 객체(tokens/agent_calls)인 경우 tokens 기준 계산
    const capVal   = typeof hardCap === 'number' ? hardCap : (hardCap.tokens ?? null);
    const spentVal = typeof spent   === 'number' ? spent   : null;
    if (capVal !== null && spentVal !== null) {
      remaining = capVal - spentVal;
    }
  }

  const budget = {
    hard_cap:  hardCap,
    spent,
    remaining,
    trend:     null, // 단일 런 정보만으로 추세 산출 불가
  };

  // ─── alerts 섹션 ────────────────────────────────────────────────────────────
  const alerts = [];

  // 런 전체 상태 이상
  if (run.status && run.status !== 'success') {
    alerts.push({
      type:     'run_status',
      severity: run.status === 'partial' ? 'warn' : 'error',
      detail:   `런 상태 비정상: ${run.status}`,
    });
  }

  for (const draft of drafts) {
    const title       = draft.title || draft.draft_id || '(제목 없음)';
    const attempts    = Array.isArray(draft.attempts) ? draft.attempts : [];
    const lastAttempt = getLastAttempt(attempts);

    // 최종 gate 실패 draft
    if (lastAttempt && lastAttempt.gate_pass === false) {
      const failedGates = (lastAttempt.gate_gates || [])
        .filter(g => !g.pass)
        .map(g => g.gate)
        .join(', ');
      alerts.push({
        type:     'draft_failed',
        severity: 'warn',
        detail:   `초안 게이트 실패 — "${title}": 탈락 게이트 [${failedGates || '알 수 없음'}]`,
      });
    }

    // 게이트 반복탈락: 2회 이상 시도 + 모든 attempt gate_pass=false
    if (attempts.length >= 2 && attempts.every(a => a.gate_pass === false)) {
      alerts.push({
        type:     'gate_repeat_fail',
        severity: 'error',
        detail:   `게이트 반복탈락(${attempts.length}회 시도) — "${title}"`,
      });
    }
  }

  // ─── decisions 섹션 ─────────────────────────────────────────────────────────
  // 게이트 통과 draft → CEO 발행 승인 대기 항목
  // (published/ 복사 확인 불가로 gate_pass=true 전체를 대기로 표시)
  const decisions = publishedTitles.map(title => ({
    item:    `발행 후보 — "${title}"`,
    options: ['approve', 'reject'],
  }));

  return { yesterday, budget, alerts, decisions };
}

/**
 * formatBriefingText(briefing) → 한국어 채팅용 멀티라인 텍스트.
 * 4섹션(어제 성과·예산·알림·의사결정) 제목 포함.
 *
 * @param {{ yesterday, budget, alerts, decisions }} briefing
 * @returns {string}
 */
export function formatBriefingText(briefing) {
  const { yesterday, budget, alerts, decisions } = briefing;
  const lines = [];

  // 헤더
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`📋 CEO 일일 브리핑 — ${today}`);
  lines.push('');

  // 1. 어제 발행 성과
  lines.push('## 📰 1. 어제 발행 성과');
  lines.push(`- 발행 완료: ${yesterday.published}편`);
  for (const t of (yesterday.titles || [])) {
    lines.push(`  • ${t}`);
  }
  lines.push(`- 게이트 실패: ${yesterday.failed}편`);
  lines.push(`- 폐기(slug 없음): ${yesterday.discarded}편`);
  lines.push('');

  // 2. 예산 현황
  lines.push('## 💰 2. 예산 현황');
  if (budget.hard_cap) {
    const cap = budget.hard_cap;
    const capStr = (typeof cap === 'object' && cap !== null)
      ? `토큰 ${(cap.tokens || 0).toLocaleString()} / 에이전트콜 ${cap.agent_calls || 0}`
      : String(cap);
    lines.push(`- 일일 하드캡: ${capStr}`);
  } else {
    lines.push('- 일일 하드캡: 정보 없음');
  }
  lines.push(`- 이번 런 사용량: ${budget.spent !== null ? budget.spent : '데이터 없음(run.json 비용 필드 없음)'}`);
  lines.push(`- 잔여 추정: ${budget.remaining !== null ? budget.remaining : '—'}`);
  lines.push(`- 추세: ${budget.trend !== null ? budget.trend : '단기 데이터 부족'}`);
  lines.push('');

  // 3. 알림
  lines.push('## 🚨 3. 알림');
  if (alerts.length === 0) {
    lines.push('- 이상 없음 ✅');
  } else {
    for (const a of alerts) {
      const icon = a.severity === 'error' ? '🔴' : '🟡';
      lines.push(`- ${icon} [${a.type}] ${a.detail}`);
    }
  }
  lines.push('');

  // 4. 의사결정 대기
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

/**
 * generateBriefing(opts) → store 에 persist 된 레코드 반환.
 * loadLatestRun → buildBriefing → formatBriefingText → appendRecord('briefing', ...).
 * run.json 없으면 빈 브리핑이라도 persist 하고 alerts 에 "최근 런 없음" 표시.
 *
 * @param {object} opts - 미래 확장용 옵션
 * @returns {object}    - persist 된 store 레코드
 */
export async function generateBriefing(opts = {}) {
  const runJson  = loadLatestRun();
  const briefing = buildBriefing(runJson, opts);

  // run.json 없음 경고 alerts 추가
  if (!runJson) {
    briefing.alerts.push({
      type:     'no_run',
      severity: 'warn',
      detail:   '최근 런 없음 — runs/ 디렉토리에 유효한 run.json 이 없습니다',
    });
  }

  const text     = formatBriefingText(briefing);
  const run_date = runJson?.date || new Date().toISOString().slice(0, 10);

  const record = await appendRecord('briefing', { ...briefing, text, run_date });
  log.info(`브리핑 생성 완료 (run_date=${run_date}, published=${briefing.yesterday.published}, alerts=${briefing.alerts.length})`);
  return record;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (isMainModule(import.meta.url)) {
  generateBriefing()
    .then((record) => console.log(formatBriefingText(record)))
    .catch((err) => { console.error(err?.message ?? String(err)); process.exit(1); });
}
