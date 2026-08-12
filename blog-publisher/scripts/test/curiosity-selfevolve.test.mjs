#!/usr/bin/env node
/**
 * curiosity-selfevolve.test.mjs — 호기심 채널 자가발전 엔진(scripts/shorts-curiosity/evolve.mjs) 검증
 *
 * 네트워크·크리덴셜 불필요. 실제 config/state 를 절대 건드리지 않는다:
 *   - config: 임시 디렉터리에 복사본 → CURIOSITY_CONFIG_OVERRIDE
 *   - state : 임시 디렉터리 → STATE_DIR_OVERRIDE (analytics·index·backlog·백업·로그 전부 격리)
 *
 * 검증:
 *   (a) analytics 부재·표본부족(영상<10·1일치·성장신호無) → config 무변경 + exit 0
 *   (b) 충분한 합성 표본(20편·3일·reveal 우세) → whatif_ratio↓ + weights 조정 + 핵심4축 합 1.0 유지
 *   (c) 화이트리스트 밖 키(upload.enabled·gates·tts·imagen) 변경 시도 거부 + evolve-log 기록
 *   (d) 백업 파일 + evolve-log.jsonl + insights.json 생성
 *   (e) EVOLVE_DRY_RUN=1 → config 무변경(계산은 수행)
 *   (f) 급변 방지 상한 — 극단 데이터에도 회당 변화가 상한 내
 *   (g) pick.weights 리프 경로 위생(범위·유한수·축 신설 금지) + 합 1.0 불변식 재강제(회귀)
 *
 * exit 0 = 전체 통과 / 1 = 실패
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adjustWeights, isAllowedPath, applyProposals, enforceWeightInvariant, CAPS } from '../shorts-curiosity/evolve.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const EVOLVE = join(REPO, 'scripts', 'shorts-curiosity', 'evolve.mjs');
const REAL_CONFIG = join(REPO, 'config', 'shorts-curiosity.json');
const CORE = ['surprise', 'scrollstop', 'relatability', 'freshness'];
const DAY = 24 * 60 * 60 * 1000;

let passN = 0, failN = 0;
const tmpRoots = [];
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
}

// ─── 격리 픽스처 ──────────────────────────────────────────────────────────────

function setup({ analytics = null, index = {}, backlog = [], configMutate = null } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'curio-evolve-'));
  tmpRoots.push(tmp);
  const cfgPath = join(tmp, 'shorts-curiosity.json');
  const cfg = JSON.parse(readFileSync(REAL_CONFIG, 'utf8'));
  if (configMutate) configMutate(cfg);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); // 실제 config 기반 격리 복사본
  const state = join(tmp, 'state');
  mkdirSync(join(state, 'shorts-curiosity'), { recursive: true });
  mkdirSync(join(state, 'shorts-backlog'), { recursive: true });
  if (analytics) {
    writeFileSync(join(state, 'shorts-curiosity', 'analytics.jsonl'),
      analytics.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  }
  writeFileSync(join(state, 'shorts-curiosity-index.json'), JSON.stringify(index, null, 2), 'utf8');
  writeFileSync(join(state, 'shorts-backlog', 'backlog.jsonl'),
    backlog.map(o => JSON.stringify(o)).join('\n') + (backlog.length ? '\n' : ''), 'utf8');
  return { tmp, cfgPath, state, before: readFileSync(cfgPath, 'utf8') };
}

function runEvolve(fx, extraEnv = {}) {
  const r = spawnSync(process.execPath, [EVOLVE], {
    cwd: REPO, encoding: 'utf8',
    env: {
      ...process.env,
      CURIOSITY_CONFIG_OVERRIDE: fx.cfgPath,
      STATE_DIR_OVERRIDE: fx.state,
      RUN_MODE: 'mock',
      LOG_LEVEL: 'WARN',                 // info 억제 → stdout 은 요약 JSON 만
      EVOLVE_DRY_RUN: '',                // 상속 방지
      EVOLVE_EXTRA_PROPOSALS: '',
      ...extraEnv,
    },
  });
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines[lines.length - 1]); } catch { /* 파싱 실패는 호출부에서 판정 */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

const cfgOf = (fx) => JSON.parse(readFileSync(fx.cfgPath, 'utf8'));
const unchanged = (fx) => readFileSync(fx.cfgPath, 'utf8') === fx.before;
const evolveLogLines = (fx) => {
  const p = join(fx.state, 'shorts-curiosity', 'evolve-log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
};

/**
 * 합성 애널리틱스 생성.
 * 20편 = reveal 12편(역사·인체·심리 각 4, origin=reddit) + whatif 8편(우주·일상 각 4, origin=llm).
 * 게시일을 10~29일 전으로 흩어 "오래된 영상이 누적조회로 유리"한 상황을 만든다
 * (정규화가 없으면 whatif 쪽 옛 영상이 이기도록 whatif 를 더 오래된 영상으로 배치).
 */
function synth({ revealVpd = 300, whatifVpd = 60, days = 3, videos = 20, growing = true, domainMult = { 역사: 1.6, 인체: 1.0, 심리: 0.5 } } = {}) {
  const now = Date.now();
  const plan = [];
  const revealDomains = ['역사', '인체', '심리'];
  const whatifDomains = ['우주', '일상'];
  for (let i = 0; i < videos; i++) {
    const isReveal = i < Math.round(videos * 0.6);
    const domain = isReveal ? revealDomains[i % revealDomains.length] : whatifDomains[i % whatifDomains.length];
    // whatif 를 더 오래된 영상으로(누적조회 유리) → 경과일 정규화 없으면 헛결론이 나는 배치
    const ageDays = isReveal ? 10 + (i % 5) : 30 + (i % 8);
    const vpd = (isReveal ? revealVpd * (domainMult[domain] ?? 1) : whatifVpd);
    plan.push({
      id: `it${i}`, youtube_id: `yt${String(i).padStart(2, '0')}`,
      subject: isReveal ? `반전 사실 ${i}번 이야기` : `만약 ${i}번 상황이었다면 어떻게 됐을까 하는 긴 제목의 가상 추론`,
      domain, angle: isReveal ? 'reveal' : 'whatif', origin: isReveal ? 'reddit' : 'llm',
      ageDays, vpd,
      er: isReveal ? 0.02 : 0.05,       // 조회 상위군(reveal)의 참여율이 낮음 → relatability↑ 규칙 발동
      publishedAt: new Date(now - ageDays * DAY).toISOString(),
    });
  }

  const analytics = [];
  const index = {};
  const backlog = [];
  for (const p of plan) {
    for (let d = days - 1; d >= 0; d--) {
      const ts = new Date(now - d * DAY).toISOString();
      const age = p.ageDays - d;
      const views = Math.max(1, Math.round(p.vpd * (growing ? age : p.ageDays)));
      analytics.push({
        ts, youtube_id: p.youtube_id, subject: p.subject, title: p.subject,
        published_at: p.publishedAt,
        views, likes: Math.round(views * p.er), comments: Math.round(views * p.er * 0.1),
      });
    }
    index[p.id] = {
      status: 'uploaded', at: p.publishedAt, uploaded_at: p.publishedAt,
      subject: p.subject, youtube_id: p.youtube_id, domain: p.domain, angle: p.angle,
    };
    backlog.push({ id: p.id, subject: p.subject, domain: p.domain, angle: p.angle, origin: p.origin, created_at: p.publishedAt });
  }
  return { analytics, index, backlog };
}

const coreSum = (w) => CORE.reduce((a, k) => a + Number(w[k] || 0), 0);

// ═══ (a) 표본 부족 4종 → 무변경 + exit 0 ══════════════════════════════════════
console.log('\n[a] 표본 부족 가드');
{
  const fx = setup();                                    // analytics 파일 자체가 없음
  const r = runEvolve(fx);
  ok('a1 analytics 부재 → exit 0', r.code === 0, `code=${r.code} stderr=${(r.stderr || '').slice(0, 200)}`);
  ok('a1 changed=false / reason=no-analytics', r.json && r.json.changed === false && r.json.reason === 'no-analytics', JSON.stringify(r.json));
  ok('a1 config 무변경', unchanged(fx));
}
{
  const s = synth({ videos: 5 });
  const fx = setup(s);
  const r = runEvolve(fx);
  ok('a2 영상 5편(<10) → exit 0 + too-few-videos', r.code === 0 && r.json?.reason === 'too-few-videos', JSON.stringify(r.json));
  ok('a2 config 무변경', unchanged(fx));
}
{
  const s = synth({ days: 1 });                          // 스냅샷 날짜 1일치
  const fx = setup(s);
  const r = runEvolve(fx);
  ok('a3 1일치 스냅샷 → exit 0 + single-day-snapshots', r.code === 0 && r.json?.reason === 'single-day-snapshots', JSON.stringify(r.json));
  ok('a3 config 무변경', unchanged(fx));
}
{
  const s = synth({ growing: false });                   // 조회수 정체(mock 합성 스냅샷 형태)
  const fx = setup(s);
  const r = runEvolve(fx);
  ok('a4 성장신호 없음 → exit 0 + no-growth-signal', r.code === 0 && r.json?.reason === 'no-growth-signal', JSON.stringify(r.json));
  ok('a4 config 무변경', unchanged(fx));
}
{
  const fx = setup(synth({ revealVpd: 1, whatifVpd: 1000 }));
  const r = runEvolve(fx);
  const after = cfgOf(fx);
  const notes = evolveLogLines(fx).at(-1)?.notes || [];
  ok('a5 whatif_ratio=0은 고성과 표본에도 자동 재활성화하지 않음',
    r.code === 0 && after.backlog.angles.whatif_ratio === 0
      && !r.json?.applied?.some(a => a.path === 'backlog.angles.whatif_ratio'),
    JSON.stringify(r.json?.applied));
  ok('a5 자동 재활성화 금지 사유 기록', notes.some(n => /사용자가 끔/.test(n)), JSON.stringify(notes));
}

// ═══ (b) 충분한 표본 → 실제 조정 ══════════════════════════════════════════════
console.log('\n[b] 충분한 표본 → 파라미터 조정');
let fxB;
{
  fxB = setup({ ...synth(), configMutate: cfg => { cfg.backlog.angles.whatif_ratio = 0.35; } });
  const before = JSON.parse(fxB.before);
  const r = runEvolve(fxB);
  const after = cfgOf(fxB);
  ok('b1 exit 0 + changed=true', r.code === 0 && r.json?.changed === true, `code=${r.code} ${JSON.stringify(r.json)}`);
  ok('b2 whatif_ratio 하락(reveal 우세)',
    after.backlog.angles.whatif_ratio < before.backlog.angles.whatif_ratio,
    `${before.backlog.angles.whatif_ratio} → ${after.backlog.angles.whatif_ratio}`);
  ok('b3 pick.weights 조정됨',
    CORE.some(k => after.pick.weights[k] !== before.pick.weights[k]),
    JSON.stringify(after.pick.weights));
  ok('b4 핵심4축 합 보존(=기존 합 1.0)',
    Math.abs(coreSum(after.pick.weights) - coreSum(before.pick.weights)) < 1e-9 && Math.abs(coreSum(after.pick.weights) - 1) < 1e-9,
    `before=${coreSum(before.pick.weights)} after=${coreSum(after.pick.weights)}`);
  ok('b5 reddit_bonus 는 가산항으로 별도 유지(정규화 대상 아님)',
    typeof after.pick.weights.reddit_bonus === 'number' && after.pick.weights.reddit_bonus >= 0 && after.pick.weights.reddit_bonus <= 0.15,
    String(after.pick.weights.reddit_bonus));
  ok('b6 화이트리스트 밖 키 불변(upload/gates/tts/imagen)',
    JSON.stringify(after.upload) === JSON.stringify(before.upload)
    && JSON.stringify(after.gates) === JSON.stringify(before.gates)
    && JSON.stringify(after.tts) === JSON.stringify(before.tts)
    && JSON.stringify(after.imagen) === JSON.stringify(before.imagen));
  ok('b7 config 는 유효 JSON 이고 스키마 유지', after.schema === before.schema && Array.isArray(after.channel.domains));
  ok('b8 경과일 정규화 동작(옛 whatif 영상이 이기지 않음)',
    r.json?.applied?.some(a => a.path === 'backlog.angles.whatif_ratio' && a.to < a.from), JSON.stringify(r.json?.applied));
  // 조정 대상 형제 키 보존 — 다른 에이전트가 같은 config 에 추가한 키(pick.similarity·daily_target 등)를
  // 통째 재작성으로 날려먹지 않는지(교차 회귀 방어).
  const siblingsKept = Object.keys(before.pick).every(k => JSON.stringify(after.pick[k]) === JSON.stringify(before.pick[k]) || k === 'weights')
    && Object.keys(before).every(k => k === 'pick' || k === 'backlog' || k === 'channel' || JSON.stringify(after[k]) === JSON.stringify(before[k]));
  ok('b9 비대상 형제 키 전부 보존', siblingsKept,
    `beforePickKeys=${Object.keys(before.pick).join(',')} afterPickKeys=${Object.keys(after.pick).join(',')}`);
  // 자동 reddit_bonus 조정은 리프 경로(pick.weights.reddit_bonus)를 쓴다 — 리프 위생 강화 후에도 살아있어야 한다.
  ok('b10 reddit_bonus 자동 가점 상승(리프 경로 회귀)',
    Math.abs(after.pick.weights.reddit_bonus - (before.pick.weights.reddit_bonus + CAPS.REDDIT_BONUS_STEP)) < 1e-9,
    `${before.pick.weights.reddit_bonus} → ${after.pick.weights.reddit_bonus}`);
}

// ═══ (d) 백업·evolve-log·insights ════════════════════════════════════════════
console.log('\n[d] 롤백 가능성 산출물');
{
  // 백업은 대상 config 옆(오버라이드 시) — 오버라이드 런이 실 state 를 오염시키지 않는다는 계약.
  const backupDir = join(fxB.tmp, 'config-backup');
  const backups = existsSync(backupDir) ? readdirSync(backupDir).filter(f => f.endsWith('.json')) : [];
  ok('d1 타임스탬프 백업 생성(대상 config 옆)', backups.length === 1, backups.join(','));
  ok('d1b 오버라이드 런은 state 백업 디렉터리를 만들지 않음', !existsSync(join(fxB.state, 'shorts-curiosity', 'config-backup')));
  ok('d2 백업 내용 == 변경 전 config', backups.length === 1 && readFileSync(join(backupDir, backups[0]), 'utf8') === fxB.before);
  const logs = evolveLogLines(fxB);
  ok('d3 evolve-log.jsonl append', logs.length === 1 && logs[0].changed === true, JSON.stringify(logs.map(l => l.reason)));
  ok('d4 로그에 before/after·근거·표본수 포함',
    logs[0]?.applied?.length > 0
    && logs[0].applied.every(a => 'from' in a && 'to' in a && typeof a.reason === 'string' && a.reason.length > 0)
    && logs[0].samples?.videos === 20 && logs[0].samples?.snapshot_days >= 2,
    JSON.stringify(logs[0]?.samples));
  ok('d5 로그에 백업 경로 기록', typeof logs[0]?.backup === 'string' && logs[0].backup.includes('config-backup'));
  const insPath = join(fxB.state, 'shorts-curiosity', 'insights.json');
  const ins = existsSync(insPath) ? JSON.parse(readFileSync(insPath, 'utf8')) : null;
  ok('d6 insights.json 생성', !!ins && ins.schema === 'shorts-curiosity/insights/v1');
  ok('d7 insights 에 상위 도메인·제목길이·앵글·가이던스',
    ins?.top_domains?.length > 0 && ins?.title_length?.length > 0 && ins?.angles?.length >= 2 && ins?.guidance?.length >= 3,
    JSON.stringify({ dom: ins?.top_domains?.length, ttl: ins?.title_length?.length, ang: ins?.angles?.length, g: ins?.guidance?.length }));
  ok('d8 insights 상위 도메인이 실제 최고 성과 도메인(역사)', ins?.top_domains?.[0]?.key === '역사', JSON.stringify(ins?.top_domains?.map(d => d.key)));
}

// ═══ (c) 화이트리스트 가드 ════════════════════════════════════════════════════
console.log('\n[c] 화이트리스트 가드');
{
  const fx = setup(synth());
  const forbidden = [
    { path: 'upload.enabled', to: false, reason: 'guard test' },
    { path: 'gates.min_sec', to: 1, reason: 'guard test' },
    { path: 'tts.google.key_file', to: '/tmp/evil.json', reason: 'guard test' },
    { path: 'imagen.enabled', to: false, reason: 'guard test' },
    { path: 'upload.oauth_token_file', to: '/tmp/evil-oauth.json', reason: 'guard test' },
  ];
  const r = runEvolve(fx, { EVOLVE_EXTRA_PROPOSALS: JSON.stringify(forbidden) });
  const after = cfgOf(fx);
  const before = JSON.parse(fx.before);
  ok('c1 exit 0(거부는 실패 아님)', r.code === 0, `code=${r.code}`);
  ok('c2 전건 거부', r.json?.rejected?.length === forbidden.length, JSON.stringify(r.json?.rejected));
  ok('c3 upload.enabled 불변', after.upload.enabled === before.upload.enabled && after.upload.enabled === true);
  ok('c4 gates/tts/imagen/크리덴셜 경로 불변',
    after.gates.min_sec === before.gates.min_sec
    && after.tts.google.key_file === before.tts.google.key_file
    && after.imagen.enabled === before.imagen.enabled
    && after.upload.oauth_token_file === before.upload.oauth_token_file);
  ok('c5 거부 사유가 evolve-log 에 남음',
    evolveLogLines(fx)[0]?.rejected?.length === forbidden.length
    && evolveLogLines(fx)[0].rejected.every(x => typeof x.why === 'string' && x.why.length > 0),
    JSON.stringify(evolveLogLines(fx)[0]?.rejected));
  ok('c6 거부 사유가 stderr 로그에도 남음', /제안 거부: upload\.enabled/.test(r.stderr || ''), (r.stderr || '').slice(0, 200));
  ok('c7 허용 키 조정은 정상 진행(가드가 전체를 막지 않음)', r.json?.applied?.length > 0, JSON.stringify(r.json?.applied));
  // 유닛: 경로 판정
  ok('c8 isAllowedPath 화이트리스트만 true',
    isAllowedPath('pick.weights') && isAllowedPath('pick.weights.surprise') && isAllowedPath('backlog.angles.whatif_ratio')
    && isAllowedPath('channel.domains')
    && !isAllowedPath('upload.enabled') && !isAllowedPath('gates.min_sec') && !isAllowedPath('tts.provider')
    && !isAllowedPath('imagen.key_file') && !isAllowedPath('pick.weights.surprise.deep') && !isAllowedPath('pick'));
}

// ═══ (e) EVOLVE_DRY_RUN ══════════════════════════════════════════════════════
console.log('\n[e] EVOLVE_DRY_RUN');
{
  const fx = setup(synth());
  const r = runEvolve(fx, { EVOLVE_DRY_RUN: '1' });
  ok('e1 exit 0 + dry_run=true + changed=false', r.code === 0 && r.json?.dry_run === true && r.json?.changed === false, JSON.stringify(r.json));
  ok('e2 config 무변경', unchanged(fx));
  ok('e3 계산은 수행(applied 산출)', r.json?.applied?.length > 0, JSON.stringify(r.json?.applied));
  ok('e4 백업·insights 미생성',
    !existsSync(join(fx.tmp, 'config-backup'))
    && !existsSync(join(fx.state, 'shorts-curiosity', 'config-backup'))
    && !existsSync(join(fx.state, 'shorts-curiosity', 'insights.json')));
  ok('e5 evolve-log 은 dry_run 표시로 기록', evolveLogLines(fx)[0]?.dry_run === true);
}

// ═══ (f) 급변 방지 상한 ═══════════════════════════════════════════════════════
console.log('\n[f] 급변 방지 상한');
{
  const fx = setup({
    ...synth({ revealVpd: 100000, whatifVpd: 1, domainMult: { 역사: 40, 인체: 1, 심리: 0.02 } }),
    configMutate: cfg => { cfg.backlog.angles.whatif_ratio = 0.35; },
  });
  const before = JSON.parse(fx.before);
  const r = runEvolve(fx);
  const after = cfgOf(fx);
  const dRatio = Math.abs(after.backlog.angles.whatif_ratio - before.backlog.angles.whatif_ratio);
  ok('f1 whatif_ratio 절대 스텝 상한 준수', dRatio > 0 && dRatio <= CAPS.WHATIF_STEP_MAX + 1e-9, `Δ=${dRatio}`);
  const breach = CORE.filter(k => {
    const b = before.pick.weights[k], a = after.pick.weights[k];
    return Math.abs(a - b) / b > CAPS.WEIGHT_REL_STEP + 5e-4;   // 4자리 반올림 흡수 오차 허용
  });
  ok('f2 weights 상대변화 상한 준수', breach.length === 0, `breach=${breach.join(',')} after=${JSON.stringify(after.pick.weights)}`);
  ok('f3 합 보존 유지', Math.abs(coreSum(after.pick.weights) - 1) < 1e-9, String(coreSum(after.pick.weights)));
  const dReddit = Math.abs((after.pick.weights.reddit_bonus ?? 0) - (before.pick.weights.reddit_bonus ?? 0));
  ok('f4 reddit_bonus 절대 스텝 상한 준수', dReddit <= CAPS.REDDIT_BONUS_STEP + 1e-9, `Δ=${dReddit}`);
  const removed = before.channel.domains.filter(d => !after.channel.domains.includes(d));
  const added = after.channel.domains.filter(d => !before.channel.domains.includes(d));
  ok('f5 domains 추가·제거 각 1개 이하', removed.length <= 1 && added.length <= 1, `removed=${removed} added=${added}`);
  ok('f6 domains 최소 크기 유지', after.channel.domains.length >= CAPS.DOMAIN_MIN, String(after.channel.domains.length));
  // 유닛: adjustWeights 자체 상한·합 보존(극단 units)
  const w0 = { surprise: 0.34, scrollstop: 0.21, relatability: 0.30, freshness: 0.15, reddit_bonus: 0.05 };
  const w1 = adjustWeights(w0, { surprise: 5, scrollstop: -5, relatability: 3, freshness: -3 });
  ok('f7 adjustWeights 상한 준수(극단 units)',
    CORE.every(k => Math.abs(w1[k] - w0[k]) / w0[k] <= CAPS.WEIGHT_REL_STEP + 5e-4), JSON.stringify(w1));
  ok('f8 adjustWeights 합 보존', Math.abs(coreSum(w1) - coreSum(w0)) < 1e-9, String(coreSum(w1)));
  ok('f9 adjustWeights 무변경 units → 원본 유지', CORE.every(k => adjustWeights(w0, {})[k] === w0[k]));
}

// ═══ (g) 리프 경로 위생 + 합 1.0 불변식 ═══════════════════════════════════════
// 회귀 근거: isAllowedPath 가 pick.weights 하위 리프를 허용하는데(설계 의도) 위생 검사는 객체
// 통째 제안만 검사해, 수동 채널(EVOLVE_EXTRA_PROPOSALS)로 pick.weights.surprise=99 를 밀어넣으면
// 합이 99.71 로 붕괴됐다. 자동 경로는 안전했지만 깨진 weights 는 이후 매일의 선정을 오염시킨다.
console.log('\n[g] 리프 경로 위생 + 합 불변식');
{
  const REAL = JSON.parse(readFileSync(REAL_CONFIG, 'utf8'));
  const origW = REAL.pick.weights;

  // g1 유닛: 보고된 결함의 직접 재현 — 99 는 거부되고 weights 가 원본 그대로여야 한다.
  {
    const { next, applied, rejected } = applyProposals(REAL, [{ path: 'pick.weights.surprise', to: 99 }]);
    ok('g1 pick.weights.surprise=99 거부', applied.length === 0 && rejected.length === 1, JSON.stringify({ applied, rejected }));
    ok('g1 weights 원본 유지 + 합 1.0', Math.abs(coreSum(next.pick.weights) - 1) < 1e-9 && next.pick.weights.surprise === origW.surprise,
      JSON.stringify(next.pick.weights));
  }
  // g2 유닛: 범위 내 리프는 적용되고 나머지 축이 비례 축소돼 합이 보존된다.
  {
    const { next, applied, rejected } = applyProposals(REAL, [{ path: 'pick.weights.surprise', to: 0.5 }]);
    const w = next.pick.weights;
    ok('g2 범위 내 리프(0.5) 적용', applied.length === 1 && rejected.length === 0, JSON.stringify(rejected));
    ok('g2 지정축 값 유지 + 합 1.0', w.surprise === 0.5 && Math.abs(coreSum(w) - 1) < 1e-9, JSON.stringify(w));
    ok('g2 자유축 비례 축소(모두 하한 이상·유한수)',
      ['scrollstop', 'relatability', 'freshness'].every(k => Number.isFinite(w[k]) && w[k] >= CAPS.WEIGHT_FLOOR && w[k] < origW[k]),
      JSON.stringify(w));
    ok('g2 5개 축 전부 잔존(축 소실 없음)',
      [...CORE, 'reddit_bonus'].every(k => Number.isFinite(Number(w[k]))), Object.keys(w).join(','));
    ok('g2 applied.to 가 최종 기록값과 일치(로그 정직성)', applied[0].to === w.surprise, JSON.stringify(applied[0]));
  }
  // g3 유닛: 음수·비유한·문자열 리프 거부
  {
    const attacks = [
      { path: 'pick.weights.surprise', to: -0.1 },
      { path: 'pick.weights.relatability', to: 0 },
      { path: 'pick.weights.freshness', to: JSON.parse('1e999') },   // → Infinity
      { path: 'pick.weights.scrollstop', to: 'abc' },
      { path: 'pick.weights.surprise', to: null },
    ];
    const { next, applied, rejected } = applyProposals(REAL, attacks);
    ok('g3 음수·0·Infinity·문자열·null 리프 전건 거부', applied.length === 0 && rejected.length === attacks.length, JSON.stringify(rejected.map(r => r.why)));
    ok('g3 weights 무변경 + 합 1.0', JSON.stringify(next.pick.weights) === JSON.stringify(origW) && Math.abs(coreSum(next.pick.weights) - 1) < 1e-9);
  }
  // g4 유닛: 유령 축 신설 금지 / 객체 제안의 축 소실·범위 위반 거부
  {
    const r1 = applyProposals(REAL, [{ path: 'pick.weights.bogus', to: 0.2 }]);
    ok('g4 알 수 없는 축 신설 거부', r1.applied.length === 0 && r1.rejected.length === 1 && !('bogus' in r1.next.pick.weights), JSON.stringify(r1.rejected));
    const noFreshness = { surprise: 0.4, scrollstop: 0.3, relatability: 0.3 };
    const r2 = applyProposals(REAL, [{ path: 'pick.weights', to: noFreshness }]);
    ok('g4 객체 제안 축 소실 거부', r2.applied.length === 0 && r2.rejected.length === 1, JSON.stringify(r2.rejected));
    const overCeil = { surprise: 0.95, scrollstop: 0.02, relatability: 0.02, freshness: 0.01 };
    const r3 = applyProposals(REAL, [{ path: 'pick.weights', to: overCeil }]);
    ok('g4 객체 제안 범위 위반 거부', r3.applied.length === 0 && r3.rejected.length === 1, JSON.stringify(r3.rejected));
    ok('g4 거부 후 weights 원본 유지', JSON.stringify(r3.next.pick.weights) === JSON.stringify(origW));
  }
  // g5 유닛: 여러 축 동시 지정으로 합 초과를 노려도 합은 1.0
  {
    const { next, applied } = applyProposals(REAL, [
      { path: 'pick.weights.surprise', to: 0.6 },
      { path: 'pick.weights.relatability', to: 0.6 },
    ]);
    const w = next.pick.weights;
    ok('g5 지정축 합 과대에도 합 1.0 보존', Math.abs(coreSum(w) - 1) < 1e-9, JSON.stringify(w));
    ok('g5 4축 전부 유한·양수', CORE.every(k => Number.isFinite(w[k]) && w[k] > 0), JSON.stringify(w));
    ok('g5 적용 기록이 최종값으로 정정됨', applied.every(a => a.to === w[a.path.split('.').pop()]), JSON.stringify(applied));
  }
  // g6 유닛: reddit_bonus 범위·whatif_ratio 범위
  {
    const r1 = applyProposals(REAL, [{ path: 'pick.weights.reddit_bonus', to: 0.9 }]);
    ok('g6 reddit_bonus 범위 밖 거부', r1.applied.length === 0 && r1.next.pick.weights.reddit_bonus === origW.reddit_bonus, JSON.stringify(r1.rejected));
    const r2 = applyProposals(REAL, [{ path: 'pick.weights.reddit_bonus', to: 0.06 }]);
    ok('g6 reddit_bonus 범위 내 적용(합 정규화 대상 아님)',
      r2.applied.length === 1 && r2.next.pick.weights.reddit_bonus === 0.06 && Math.abs(coreSum(r2.next.pick.weights) - 1) < 1e-9);
    const r3 = applyProposals(REAL, [{ path: 'backlog.angles.whatif_ratio', to: 0.9 }, { path: 'backlog.angles.whatif_ratio', to: 'abc' }]);
    ok('g6 whatif_ratio 범위 밖·비수치 거부',
      r3.applied.length === 0 && r3.rejected.length === 2 && r3.next.backlog.angles.whatif_ratio === REAL.backlog.angles.whatif_ratio,
      JSON.stringify(r3.rejected.map(x => x.why)));
    const r4 = applyProposals(REAL, [{ path: 'backlog.angles.whatif_ratio', to: 0 }]);
    ok('g6 whatif_ratio=0(끔) 은 하위호환 허용', r4.applied.length === 1 && r4.next.backlog.angles.whatif_ratio === 0);
  }
  // g7 유닛: enforceWeightInvariant 자체
  {
    const w0 = { surprise: 0.34, scrollstop: 0.21, relatability: 0.30, freshness: 0.15, reddit_bonus: 0.05 };
    const pinned = enforceWeightInvariant({ ...w0, surprise: 0.6 }, w0, 1, new Set(['surprise']));
    ok('g7 지정축 유지 + 합 보존 + 자유축 하한 이상',
      pinned.valid && pinned.weights.surprise === 0.6 && Math.abs(coreSum(pinned.weights) - 1) < 1e-9
      && ['scrollstop', 'relatability', 'freshness'].every(k => pinned.weights[k] >= CAPS.WEIGHT_FLOOR),
      JSON.stringify(pinned));
    const lost = enforceWeightInvariant({ surprise: 0.34, scrollstop: 0.21, relatability: 0.30 }, w0, 1, new Set());
    ok('g7 축 소실 복원 + 합 보존', lost.valid && Number.isFinite(lost.weights.freshness) && Math.abs(coreSum(lost.weights) - 1) < 1e-9 && lost.notes.length > 0,
      JSON.stringify(lost));
    const noop = enforceWeightInvariant(w0, w0, 1, new Set());
    ok('g7 이미 합 보존 객체는 no-op(자동 경로 무회귀)', CORE.every(k => noop.weights[k] === w0[k]), JSON.stringify(noop.weights));
  }
  // g8 통합: env 수동 채널로 99 를 밀어도 디스크 config 의 합은 1.0
  {
    const fx = setup(synth());
    const r = runEvolve(fx, {
      EVOLVE_EXTRA_PROPOSALS: JSON.stringify([
        { path: 'pick.weights.surprise', to: 99, reason: 'attack' },
        { path: 'pick.weights.freshness', to: -1, reason: 'attack' },
        { path: 'pick.weights.bogus', to: 0.5, reason: 'attack' },
      ]),
    });
    const after = cfgOf(fx);
    ok('g8 exit 0 + 공격 3건 거부', r.code === 0 && r.json?.rejected?.length === 3, JSON.stringify(r.json?.rejected));
    ok('g8 디스크 config 합 1.0 유지', Math.abs(coreSum(after.pick.weights) - 1) < 1e-9, String(coreSum(after.pick.weights)));
    ok('g8 축별 범위 유지 + 유령 축 없음',
      CORE.every(k => after.pick.weights[k] >= CAPS.WEIGHT_FLOOR && after.pick.weights[k] <= CAPS.WEIGHT_CEIL) && !('bogus' in after.pick.weights),
      JSON.stringify(after.pick.weights));
  }
  // g9 통합: 범위 내 수동 리프는 반영되고 합도 1.0(수동 개입의 정당한 사용)
  {
    const fx = setup(synth());
    const r = runEvolve(fx, { EVOLVE_EXTRA_PROPOSALS: JSON.stringify([{ path: 'pick.weights.relatability', to: 0.42, reason: '수동 개입' }]) });
    const after = cfgOf(fx);
    ok('g9 수동 리프 반영 + 합 1.0',
      r.code === 0 && after.pick.weights.relatability === 0.42 && Math.abs(coreSum(after.pick.weights) - 1) < 1e-9,
      JSON.stringify(after.pick.weights));
    ok('g9 evolve-log 에 최종 기록값이 남음',
      evolveLogLines(fx)[0]?.applied?.some(a => a.path === 'pick.weights.relatability' && a.to === 0.42),
      JSON.stringify(evolveLogLines(fx)[0]?.applied));
  }
}

// ─── 정리 ────────────────────────────────────────────────────────────────────
for (const t of tmpRoots) { try { rmSync(t, { recursive: true, force: true }); } catch { /* 무시 */ } }

console.log(`\n호기심 자가발전 엔진: ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
