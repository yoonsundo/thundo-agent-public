#!/usr/bin/env node
/**
 * watchdog/pipeline-health.mjs — 🐕 Sheepdog: 자동화 파이프라인 관제·자가복구 엔진.
 *
 * "매일 자동으로 도는 것들"(cron 잡·상시 프로세스·크리덴셜)을 4시간마다 점검하고,
 * 안전하게 고칠 수 있는 문제는 **자동 복구**하며, 사람 손이 필요한 문제(예: OAuth 토큰
 * 만료)는 **알림**한다. 결정론 스크립트 — LLM 없이 사실만 점검한다.
 *
 * 설계 원칙:
 *  - 읽기 위주. 복구는 **화이트리스트된 안전·멱등 조치**만(프로세스 재기동·잡 재트리거).
 *    파괴적 동작(삭제·force·설정변경) 절대 금지.
 *  - 복구는 하루 1회로 제한(마커) — 4시간마다 같은 잡을 무한 재트리거하지 않는다.
 *  - 무거운(claude) 재실행은 detached 로 띄우고 "트리거함"만 보고(4시간 점검을 막지 않음).
 *  - 알림: 문제·복구가 있으면 상세 발송. 전부 정상이면 하루 1회 생존 하트비트만.
 *
 * env:
 *   HEALTH_DRY=1     복구·알림 안 함(점검 결과만 stdout). 테스트용.
 *   HEALTH_FORCE_SEND=1  전부 정상이어도 이번 실행에서 상태를 강제 발송.
 *
 * 사용: node --env-file=.env scripts/watchdog/pipeline-health.mjs
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { env } from '../lib/config.mjs';
import { makeLogger } from '../lib/log.mjs';
import { supabaseCreds } from '../lib/supabase-creds.mjs';
import { sendSlackWebhook } from '../notify/slack-webhook.mjs';
import { isMainModule } from '../lib/main-module.mjs';

const log = makeLogger('sheepdog');
const ROOT = process.cwd();
const DRY = !!process.env.HEALTH_DRY;
const MARKER_DIR = join(ROOT, 'state/health/remediated');

// ── 시간 헬퍼(KST) ───────────────────────────────────────────────────────────
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstToday() { return kstNow().toISOString().slice(0, 10); }
function kstHour() { return kstNow().getUTCHours(); }
function kstWeekday() { return kstNow().getUTCDay(); } // 0=일,6=토
function isWeekend() { const d = kstWeekday(); return d === 0 || d === 6; }
function ageMin(ts) { return (Date.now() - new Date(ts).getTime()) / 60000; }
function fileAgeMin(p) { try { return (Date.now() - statSync(p).mtimeMs) / 60000; } catch { return Infinity; } }

// ── 복구 마커(하루 1회 가드) ─────────────────────────────────────────────────
function markerPath(key) { return join(MARKER_DIR, `${key}-${kstToday()}.marker`); }
function remediatedToday(key) { return existsSync(markerPath(key)); }
function markRemediated(key, detail) {
  mkdirSync(MARKER_DIR, { recursive: true });
  writeFileSync(markerPath(key), JSON.stringify({ at: new Date().toISOString(), detail }) + '\n', 'utf8');
}

// ── 결과 헬퍼 ────────────────────────────────────────────────────────────────
const OK = 'ok', WARN = 'warn', FAIL = 'fail';
function R(name, level, msg, extra = {}) { return { name, level, msg, ...extra }; }

/** 안전한 detached 재트리거(무거운 claude 잡용). 점검을 막지 않는다. */
function triggerDetached(scriptPath, key) {
  if (DRY) return { tried: false, ok: false, detail: 'DRY — 트리거 생략' };
  try {
    const child = spawn('bash', [scriptPath], {
      cwd: ROOT, detached: true, stdio: 'ignore',
      env: { ...process.env, PATH: process.env.PATH },
    });
    child.unref();
    markRemediated(key, `detached ${scriptPath} pid=${child.pid}`);
    return { tried: true, ok: true, detail: `재트리거함(pid ${child.pid})` };
  } catch (e) {
    return { tried: true, ok: false, detail: `트리거 실패: ${e.message}` };
  }
}

// ── 점검 항목 ────────────────────────────────────────────────────────────────

/**
 * 소스팩 관측 (ralplan v6 S2) — excerpt_coverage(추출)·pack_adoption(작가 채택)이
 * **연속 3일 0** 이면 경보. 게이트16 은 shadow/skip 구조라 두 지표가 조용히 0 이 되면
 * 사실대조가 무력화된 채 "성공"으로 보이기 때문(조용한 no-op 차단 — 아키텍트 must-fix 1).
 * config/source-pack.json enabled:false 면 의도적 비활성 — 점검 스킵.
 */
function checkSourcePack() {
  try {
    let enabled = true;
    try { enabled = JSON.parse(readFileSync(`${ROOT}/config/source-pack.json`, 'utf8')).enabled !== false; }
    catch { /* config 부재 → 기본 enabled */ }
    if (!enabled) return R('source-pack', OK, 'source-pack 비활성(enabled:false) — 점검 스킵');

    const days = [];
    for (let i = 1; i <= 3; i++) {   // 어제부터 3일(오늘은 아직 안 돌았을 수 있음)
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      try {
        const run = JSON.parse(readFileSync(`${ROOT}/runs/${d}/run.json`, 'utf8'));
        days.push({ d, cov: run.excerpt_coverage ?? null, adopt: run.pack_adoption ?? null });
      } catch { days.push({ d, cov: null, adopt: null }); }
    }
    const zeroish = (v) => v == null || /^0\//.test(String(v));
    const covDead = days.every(x => zeroish(x.cov));
    const adoptDead = days.every(x => zeroish(x.adopt));
    if (covDead && adoptDead) {
      return R('source-pack', WARN,
        `excerpt 추출·채택이 3일 연속 0/부재 — 게이트16 이 조용히 무력화 상태(runbook STEP2 source-extract 실행 여부 확인)`, { human: true });
    }
    if (adoptDead && !covDead) {
      return R('source-pack', WARN,
        `추출은 되는데 작가 채택(pack_adoption)이 3일 연속 0 — 작가 frontmatter source_pack 계약 확인`, { human: true });
    }
    const latest = days[0];
    return R('source-pack', OK, `excerpt_coverage=${latest.cov ?? '—'} · pack_adoption=${latest.adopt ?? '—'} (D-1 기준)`);
  } catch (e) {
    return R('source-pack', WARN, `source-pack 점검 예외: ${e.message}`);
  }
}

/** 1) cron 데몬 생존. (이 스크립트가 cron 으로 도는 한 보통 살아있지만, 수동 실행·재부팅 진단용) */
function checkCron() {
  try {
    execFileSync('pgrep', ['-x', 'cron'], { stdio: 'pipe' });
    return R('cron', OK, 'cron 데몬 실행 중');
  } catch {
    return R('cron', FAIL, 'cron 데몬 미실행 — 예약작업 전부 정지 위험(수동: sudo service cron start)', { human: true });
  }
}

/** 2) agent-runner 상시 프로세스 하트비트. stale 면 재기동(안전·flock 싱글턴). */
function checkAgentRunner() {
  const hb = join(ROOT, 'state/hub/agent-runner-heartbeat.json');
  if (!existsSync(hb)) return R('agent-runner', WARN, '하트비트 파일 없음(미기동?)');
  let age;
  try { age = ageMin(JSON.parse(readFileSync(hb, 'utf8')).ts); }
  catch { return R('agent-runner', WARN, '하트비트 파싱 실패'); }
  if (age <= 20) return R('agent-runner', OK, `하트비트 신선(${age.toFixed(0)}분 전)`);
  // stale → 재기동(멱등: start-agent-runner.sh 는 flock 싱글턴)
  if (DRY) return R('agent-runner', FAIL, `하트비트 오래됨(${age.toFixed(0)}분) — DRY, 재기동 생략`);
  try {
    execFileSync('bash', [join(ROOT, 'scripts/hub/start-agent-runner.sh')], { stdio: 'pipe', timeout: 60000 });
    return R('agent-runner', WARN, `하트비트 ${age.toFixed(0)}분 stale → 재기동 실행`, {
      remediation: { tried: true, ok: true, detail: 'start-agent-runner.sh 재기동' },
    });
  } catch (e) {
    return R('agent-runner', FAIL, `하트비트 stale + 재기동 실패: ${e.message}`, { human: true });
  }
}

/** 3) claude CLI(구독) 동작. 안 되면 발행·보고·쇼츠 동시 붕괴 → 경고(자동복구 불가·보통 일시적). */
function checkClaude() {
  try {
    const out = execFileSync('claude', ['-p', 'reply with exactly: PONG', '--dangerously-skip-permissions'],
      { encoding: 'utf8', timeout: 90000 });
    if (/PONG/.test(out)) return R('claude-cli', OK, 'claude CLI 정상(PONG)');
    return R('claude-cli', WARN, `claude 응답 이상: ${out.slice(0, 60)}`);
  } catch (e) {
    return R('claude-cli', WARN, `claude CLI 실패(보통 일시적 timeout): ${String(e.message).slice(0, 80)}`);
  }
}

/** 4) 네트워크 도달성(github + supabase). */
async function checkNetwork() {
  const targets = [['github', 'https://github.com']];
  const su = env('SUPABASE_URL');
  if (su) targets.push(['supabase', su]);
  const bad = [];
  for (const [name, url] of targets) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (res.status >= 500) bad.push(`${name}(${res.status})`);
    } catch (e) { bad.push(`${name}(${String(e.message).slice(0, 30)})`); }
  }
  if (!bad.length) return R('network', OK, `네트워크 정상(${targets.map(t => t[0]).join('·')})`);
  return R('network', WARN, `네트워크 이상: ${bad.join(', ')}(일시적일 수 있음)`);
}

/** 5) YouTube OAuth 토큰(호기심 쇼츠 업로드). 만료면 사람이 재인증 필요 → 알림. */
async function checkYoutubeToken() {
  let cfg;
  try { cfg = JSON.parse(readFileSync(join(ROOT, 'config/shorts-curiosity.json'), 'utf8')); }
  catch { return R('youtube-token', OK, 'curiosity 설정 없음 — 스킵'); }
  const up = cfg.upload || {};
  if (!up.enabled) return R('youtube-token', OK, '업로드 비활성 — 스킵');
  const tf = (up.oauth_token_file || '').replace(/^~/, homedir());
  if (!tf || !existsSync(tf)) return R('youtube-token', WARN, `OAuth 토큰 파일 없음: ${up.oauth_token_file}`, { human: true });
  let t;
  try { t = JSON.parse(readFileSync(tf, 'utf8')); } catch { return R('youtube-token', WARN, 'OAuth 토큰 파싱 실패', { human: true }); }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 200) return R('youtube-token', OK, 'YouTube 토큰 유효(access token 발급됨)');
    const j = await res.json().catch(() => ({}));
    return R('youtube-token', FAIL,
      `YouTube 토큰 만료/무효 HTTP ${res.status}(${j.error || '?'}) — 쇼츠 업로드 불가. ` +
      `복구: node scripts/shorts/youtube-auth.mjs 재인증 필요(사람)`, { human: true });
  } catch (e) {
    return R('youtube-token', WARN, `토큰 확인 실패(네트워크?): ${String(e.message).slice(0, 50)}`);
  }
}

/**
 * DB 스키마 실물 확인 — **파일이 아니라 운영 DB 에 컬럼이 있는지** 본다.
 *
 * 🔴 유닛테스트의 스키마 대조는 SQL **파일**을 읽는다. 파일만 고치고 마이그레이션을 안 돌리면
 *    테스트는 초록인데 운영은 계속 400 이다. 실제로 2026-08-22~25 나흘간 그 상태였고, 승인해야
 *    할 8건이 화면에 닿지 못했다. 파일 검사와 실물 검사는 서로를 대신하지 못한다.
 *
 * 한 테이블만 보지 않는 이유: `plan` 을 코드에만 추가한 그 방식(코드+SQL 수동 동기화)이
 * 이 저장소의 표준이라, 다음 사고는 다른 테이블에서 난다. 실제로 하루 전 `bgm_suggestions`
 * 가 같은 방식으로 cardnews 에 들어왔다 — 우연히 맞았을 뿐 구조가 막아 준 것이 아니다.
 *
 * 각 쓰기 경로가 **실제로 보내는 컬럼**을 그대로 `select` 한다. 하나라도 없으면 postgrest 가
 * 이름을 짚어 준다. 목록이 코드와 어긋나면 이 점검이 헛돌므로, 컬럼을 더할 때 여기도 고친다.
 */
const WRITE_COLUMNS = {
  cardnews_posts: ['post_id', 'backlog_id', 'subject', 'problem', 'book', 'author', 'caption',
    'cover_url', 'slide_urls', 'media_id', 'permalink', 'generator', 'generator_effective',
    'published_at', 'bgm_suggestions', 'active', 'status'],
  youtube_videos: ['youtube_id', 'title', 'subject', 'domain', 'youtube_url', 'thumbnail_url'],
  agent_reports: ['date', 'summary', 'agents'],
};

/** 화면이 무엇을 잃는지 — 사람이 읽고 급한지 판단할 수 있게. */
const TABLE_IMPACT = {
  board_approvals: '경영회의 결론이 승인함에 못 뜬다',
  cardnews_posts: '카드뉴스가 관리자 화면에 안 뜬다(발행 대기 유실)',
  youtube_videos: '쇼츠가 사이트 영상 목록에 안 뜬다',
  agent_reports: '일일 리포트가 /reports 에 안 뜬다',
};

async function checkDbSchema() {
  const { url, key } = supabaseCreds();
  if (!url || !key) return R('db-schema', OK, 'Supabase 크리덴셜 없음 — 스킵');

  /**
   * 승인함 컬럼은 **적재 코드에서 뽑는다.** 손으로 베껴 두면 목록이 코드와 어긋나는 순간
   * 이 점검이 헛돈다 — 이 사고가 정확히 '코드와 스키마가 어긋나서' 났으므로, 감시 장치까지
   * 같은 방식으로 어긋나게 두면 안 된다. 나머지 표는 아직 이런 진입점이 없어 목록으로 둔다.
   */
  let tables = WRITE_COLUMNS;
  try {
    const { toApprovalRows } = await import('../board/approvals.mjs');
    const sample = toApprovalRows('2026-01-01', [{ status: 'human', proposal_id: 'x:P1', change: 'c' }])[0];
    if (sample) tables = { board_approvals: Object.keys(sample), ...WRITE_COLUMNS };
  } catch { /* board 모듈이 없으면 나머지 표만 본다 */ }

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const broken = [];
  for (const [table, cols] of Object.entries(tables)) {
    try {
      const res = await fetch(`${url}/rest/v1/${table}?select=${cols.join(',')}&limit=0`,
        { headers, signal: AbortSignal.timeout(12000) });
      if (res.ok) continue;
      const body = await res.text().catch(() => '');
      // postgrest 는 두 가지로 말한다 — 읽기(42703)는 `column <표>.<컬럼> does not exist`,
      // 쓰기(PGRST204)는 `Could not find the '<컬럼>' column`. 둘 다 이름을 짚어 준다.
      const missing = body.match(/column [a-z_]+\.([a-z_][a-z0-9_]*) does not exist/)?.[1]
        ?? body.match(/'([a-z_][a-z0-9_]*)' column/)?.[1];
      broken.push({ table, status: res.status, missing });
    } catch (e) {
      return R('db-schema', WARN, `스키마 확인 실패(네트워크?): ${String(e.message).slice(0, 50)}`);
    }
  }

  if (!broken.length) {
    return R('db-schema', OK, `DB 스키마 정상 — ${Object.keys(tables).length}개 표의 쓰기 컬럼 전부 존재`);
  }
  const detail = broken.map(b =>
    `${b.table}${b.missing ? `(‘${b.missing}’ 없음)` : `(HTTP ${b.status})`} — ${TABLE_IMPACT[b.table] ?? '쓰기 실패'}`
  ).join(' / ');
  return R('db-schema', FAIL,
    `DB 스키마 불일치 ${broken.length}건: ${detail}. ` +
    '복구: node scripts/db/migrate.mjs <thundorun>/web/supabase/<표>.sql (사람)', { human: true });
}

/** 6) 디스크 여유(가득 차면 조용한 실패). */
function checkDisk() {
  try {
    const out = execFileSync('df', ['-P', ROOT], { encoding: 'utf8' });
    const line = out.trim().split('\n').pop();
    const usePct = parseInt((line.match(/(\d+)%/) || [])[1] || '0', 10);
    if (usePct >= 92) return R('disk', WARN, `디스크 사용 ${usePct}% — 정리 필요`, { human: true });
    return R('disk', OK, `디스크 여유 OK(${usePct}% 사용)`);
  } catch { return R('disk', OK, '디스크 확인 스킵'); }
}

/**
 * 7) 영속화 도달 확인 — "잡이 돌았는가"가 아니라 "결과가 원격에 남았는가".
 *
 * 2026-07-15~23, daily cron 의 git push 가 대용량 파일 때문에 매일 거부됐는데
 * 이 관제는 9일 내내 "파이프라인 전부 정상"을 보고했다. 모든 체크가 잡의 **실행 여부**만
 * 봤고 **결과의 도달 여부**는 아무도 안 봤기 때문이다. 발행은 실제로 되고 있었으므로
 * 산출물 기반 체크(published/ 오늘것)마저 green 이었다.
 *
 * 그래서 이 체크는 로컬 커밋이 origin/main 에 실제로 반영됐는지를 본다.
 * 재트리거하지 않는다 — push 거부는 사람이 원인을 봐야 하는 종류다(가드가 막았거나 용량 초과).
 */
function checkGitPersist(netOk) {
  // "확인 못 했다"를 초록으로 칠하지 않는다 — 이 체크의 존재 이유가 그거다.
  if (!netOk) return R('git-persist', WARN, '네트워크 이상 — 영속화 확인 불가(미확인)', { human: false });

  // 의도된 일시정지(배포 기간 등)인지 먼저 본다. 이걸 모르면 3일째에 엉뚱한 진단을 낸다.
  const paused = existsSync(join(ROOT, 'state/.daily-push-disabled'));
  try {
    execFileSync('git', ['fetch', 'origin', '--quiet'], { cwd: ROOT, timeout: 60_000, stdio: 'ignore' });
    const ahead = parseInt(
      execFileSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim() || '0',
      10,
    );
    if (ahead === 0) return R('git-persist', OK, '로컬 커밋 전부 원격 반영됨');
    if (paused) {
      // 일시정지는 조용히 넘기지 않는다 — 마커를 빼먹으면 그것도 무증상 정지가 된다.
      return R('git-persist', WARN,
        `의도된 일시정지 중(state/.daily-push-disabled) — 로컬 ${ahead}커밋 미반영. 배포 끝났으면 마커 삭제`,
        { human: false });
    }
    // 개수가 아니라 **나이**로 판정한다.
    // 개수 임계는 두 상황을 못 가른다: (a) 일일 push 가 막힘 (b) 사람·에이전트가 방금 커밋함.
    // 이 저장소는 ralph 루프가 일상적으로 커밋하므로 개수 기준이면 작업 중에 계속 오경보가 나고,
    // 오경보로 무시당한 채널은 gitignore 된 로그와 다를 게 없다(이번 사고의 재발 경로).
    // 나이 기준이면: 진행 중인 세션(수십 분)은 안 울리고, 일일 커밋(12시경)이 push 안 되면
    // 그날 저녁 점검에서 8시간을 넘겨 **당일에** 잡힌다.
    const oldestCt = parseInt(
      (execFileSync('git', ['log', 'origin/main..HEAD', '--format=%ct'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
        .trim().split('\n').filter(Boolean).pop()) || '0', 10,
    );
    const ageH = oldestCt ? (Date.now() / 1000 - oldestCt) / 3600 : 0;
    if (ageH >= 8) {
      return R('git-persist', WARN,
        `로컬 ${ahead}커밋이 ${ageH.toFixed(1)}시간째 origin/main 에 미반영 — push 가 막혔을 수 있음(runs/cron-*.log 확인)`,
        { human: true });
    }
    return R('git-persist', OK, `로컬 ${ahead}커밋 미반영(${ageH.toFixed(1)}h — 작업 중으로 판단)`);
  } catch (e) {
    // 조용히 OK 로 넘기지 않는다 — 이 체크가 존재하는 이유가 바로 "조용한 초록불"이다.
    return R('git-persist', WARN, `영속화 확인 실패: ${e.message}`, { human: false });
  }
}

/**
 * 8) 일일 잡 실행 여부. 예정시각이 지났는데 오늘 산출/로그가 없으면 재트리거(claude·네트워크 정상 시).
 * jobs: {key, label, due(KST시), fresh():bool, script, heavy, weekdayOnly}
 */
function checkDailyJobs(claudeOk, netOk) {
  const today = kstToday();
  const hour = kstHour();
  const wd = isWeekend();
  const results = [];

  const jobs = [
    {
      key: 'blog-daily', label: '블로그 일일발행', due: 10, heavy: true,
      script: 'scripts/daily-claude-cron.sh',
      fresh: () => globCount(join(ROOT, 'published'), `${today}-`) > 0
        || fileAgeMin(join(ROOT, `runs/cron-${today}.log`)) < 24 * 60,
    },
    {
      key: 'curiosity', label: '호기심 쇼츠', due: 11, heavy: true,
      script: 'scripts/shorts-curiosity/curiosity-slot-cron.sh',
      fresh: () => uploadedTodayCuriosity(today),
    },
    {
      key: 'parrot', label: 'Parrot 관제', due: 10, heavy: true, weekdayOnly: true,
      script: 'scripts/report/parrot-cron.sh',
      fresh: () => existsSync(join(ROOT, `runs/parrot-${today}.log`)),
    },
    {
      // fresh 는 **오늘 로그 존재**만 본다. 예전엔 `state/infra-observer.json` 24h 이내를 OR 로
      // 인정했는데, 어제 10:20 실행분이 오늘 10:00 점검에서 23.7h 라 "오늘 실행 확인" 거짓초록을
      // 냈다(2026-08-13 재부팅 때 실측). 하루 1회 잡의 신선도 판정에 24h 슬라이딩 창은 맞지 않는다.
      key: 'infra', label: 'Woodpecker 인프라', due: 10, heavy: false,
      script: 'scripts/report/infra-cron.sh',
      fresh: () => existsSync(join(ROOT, `runs/infra-${today}.log`)),
    },
    // ↓ 아래 3종은 2026-08-13 추가. 잡 목록에 없어서 **아무도 보충하지 않던** 사각지대였다
    //   (재부팅으로 09:05·09:08·02:00 을 놓치면 그날은 그냥 결방 — 사람이 눈치채야 했다).
    {
      key: 'site', label: 'Goose 사이트 관제', due: 10, heavy: false,
      script: 'scripts/report/site-cron.sh',
      fresh: () => existsSync(join(ROOT, `runs/site-${today}.log`)),
    },
    {
      key: 'insight', label: 'Mole 인사이트', due: 10, heavy: false,
      script: 'scripts/report/insight-cron.sh',
      fresh: () => existsSync(join(ROOT, `runs/insight-${today}.log`)),
    },
    {
      // 02:00 잡. 06:00·10:00 점검이 결손을 잡는다. 체인 자체가 flock 로 중복 방지.
      key: 'curiosity-analytics', label: '호기심 성과수집', due: 3, heavy: false,
      script: 'scripts/shorts-curiosity/analytics-cron.sh',
      fresh: () => existsSync(join(ROOT, `runs/curiosity-analytics-${today}.log`)),
    },
  ];

  for (const j of jobs) {
    try {
      if (j.weekdayOnly && wd) { results.push(R(`job:${j.key}`, OK, `${j.label} 주말 스킵`)); continue; }
      if (hour < j.due) { results.push(R(`job:${j.key}`, OK, `${j.label} 예정시각(${j.due}시) 전 — 대기`)); continue; }
      if (j.fresh()) { results.push(R(`job:${j.key}`, OK, `${j.label} 오늘 실행 확인`)); continue; }
      // 오늘 실행 흔적 없음 → 복구 시도
      if (remediatedToday(`job:${j.key}`)) {
        results.push(R(`job:${j.key}`, WARN, `${j.label} 오늘 미실행 — 이미 재트리거함(대기중)`));
        continue;
      }
      if (!claudeOk && j.heavy) {
        results.push(R(`job:${j.key}`, WARN, `${j.label} 오늘 미실행 — claude 비정상이라 재트리거 보류`, { human: false }));
        continue;
      }
      if (!netOk) {
        results.push(R(`job:${j.key}`, WARN, `${j.label} 오늘 미실행 — 네트워크 이상, 재트리거 보류`));
        continue;
      }
      const rem = triggerDetached(join(ROOT, j.script), `job:${j.key}`);
      results.push(R(`job:${j.key}`, WARN, `${j.label} 오늘 미실행 → 재트리거`, { remediation: rem }));
    } catch (e) {
      results.push(R(`job:${j.key}`, WARN, `${j.label} 점검 오류: ${e.message}`));
    }
  }
  return results;
}

// ── 보조: 산출물 감지 ───────────────────────────────────────────────────────
function globCount(dir, prefix) {
  try { return readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.md')).length; }
  catch { return 0; }
}
function uploadedTodayCuriosity(today) {
  try {
    const idx = JSON.parse(readFileSync(join(ROOT, 'state/shorts-curiosity-index.json'), 'utf8'));
    return Object.values(idx).some(v => v && v.status === 'uploaded' && String(v.uploaded_at || v.at || '').startsWith(today));
  } catch { return false; }
}

// ── 알림 ─────────────────────────────────────────────────────────────────────
const ICON = { ok: '✅', warn: '⚠️', fail: '🔴' };
function worstLevel(results) {
  if (results.some(r => r.level === FAIL)) return FAIL;
  if (results.some(r => r.level === WARN)) return WARN;
  return OK;
}
function renderReport(results) {
  const worst = worstLevel(results);
  const head = worst === OK ? '✅ 파이프라인 전부 정상' : worst === FAIL ? '🔴 파이프라인 이상(사람 조치 필요 항목 있음)' : '⚠️ 파이프라인 주의(자동복구 시도됨)';
  const lines = [`🐕 *Sheepdog 관제* — ${kstToday()} ${String(kstHour()).padStart(2, '0')}시 KST`, head, ''];
  const human = [], remed = [];
  for (const r of results) {
    lines.push(`${ICON[r.level]} *${r.name}* — ${r.msg}`);
    if (r.remediation?.tried) remed.push(`• ${r.name}: ${r.remediation.detail}`);
    if (r.human && r.level !== OK) human.push(`• ${r.name}: ${r.msg}`);
  }
  if (remed.length) { lines.push('', '🔧 *자동 조치*', ...remed); }
  if (human.length) { lines.push('', '🙋 *사람 조치 필요*', ...human); }
  return lines.join('\n');
}

async function sendAlert(text) {
  // Slack CRW 웹훅(운영 브리핑 공용 채널) + Telegram 직접(있으면).
  const outs = [];
  try { outs.push(await sendSlackWebhook({ text })); } catch (e) { outs.push({ channel: 'slack', status: 'error', reason: e.message }); }
  const tgTok = env('TELEGRAM_BOT_TOKEN'), tgChat = env('TELEGRAM_CHAT_ID');
  if (tgTok && tgChat) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${tgTok}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000),
      });
      outs.push({ channel: 'telegram', status: res.ok ? 'ok' : `err ${res.status}` });
    } catch (e) { outs.push({ channel: 'telegram', status: 'error', reason: String(e.message).slice(0, 40) }); }
  }
  return outs;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  log.info(`관제 시작 — ${kstToday()} ${kstHour()}시 KST${DRY ? ' (DRY)' : ''}`);
  const results = [];

  results.push(safe(checkCron));
  results.push(safe(checkAgentRunner));
  const claude = safe(checkClaude); results.push(claude);
  const net = await safeAsync(checkNetwork); results.push(net);
  results.push(await safeAsync(checkYoutubeToken));
  results.push(await safeAsync(checkDbSchema));
  results.push(safe(checkDisk));
  const claudeOk = claude.level === OK;
  const netOk = net.level === OK;
  results.push(safe(() => checkGitPersist(netOk)));
  try { for (const r of checkDailyJobs(claudeOk, netOk)) results.push(r); }
  catch (e) { results.push(R('daily-jobs', WARN, `일일잡 점검 예외: ${e.message}`)); }
  results.push(safe(checkSourcePack));

  const worst = worstLevel(results);
  const report = renderReport(results);
  console.log('\n' + report + '\n');

  // 발송 정책: 문제/복구 있으면 상세 발송. 전부 정상이면 하루 1회 생존 하트비트만.
  if (DRY) { log.info('DRY — 발송 생략'); return; }
  let send = worst !== OK || !!process.env.HEALTH_FORCE_SEND;
  if (!send) {
    const hb = join(MARKER_DIR, `ok-heartbeat-${kstToday()}.marker`);
    if (!existsSync(hb)) { send = true; writeFileSync(hb, new Date().toISOString() + '\n'); }
  }
  if (send) {
    const outs = await sendAlert(report);
    log.info(`발송: ${JSON.stringify(outs)}`);
  } else {
    log.info('전부 정상 + 오늘 하트비트 이미 보냄 → 조용히 종료');
  }
  // fail 이 있으면 exit 1(cron 로그·감시에 신호)
  process.exitCode = worst === FAIL ? 1 : 0;
}

function safe(fn) { try { return fn(); } catch (e) { return R(fn.name, WARN, `점검 예외: ${e.message}`); } }
async function safeAsync(fn) { try { return await fn(); } catch (e) { return R(fn.name, WARN, `점검 예외: ${e.message}`); } }

/**
 * ⚠ 실행 가드. 이게 없으면 **import 만 해도 본체가 돈다** — 이 파일들은 알림을 보내거나
 *    상태 파일을 쓰므로, 테스트나 진단이 잠깐 import 하는 것만으로 실제 채널에 발송된다
 *    (2026-09-07 실제로 발생: 함수 하나 확인하려고 import 했다가 3개 채널로 브리핑이 나갔다).
 */
if (isMainModule(import.meta.url)) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(2); });
}
