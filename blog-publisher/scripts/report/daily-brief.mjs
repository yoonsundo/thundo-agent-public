// daily-brief.mjs — 16개 에이전트 전원의 육하원칙(5W1H) 일일보고 생성.
// 출력: ① agent_reports DB upsert(날짜당 1행) ② docs/work-history/<date>.md(아카이브) ③ index 연결.
// 작업 없는 에이전트는 did_work:false 로 "없음" 명시. 발행물은 라이브 blog_posts 슬러그로 필터.
//
// 사용: node scripts/report/daily-brief.mjs [YYYY-MM-DD]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isTransientClaudeError } from '../lib/claude-cli.mjs';

const DATE = process.argv[2] || new Date().toISOString().slice(0, 10);

// ── 16 에이전트 정의(순서 = 보고 순서) ──
const AGENTS = [
  { id: 'lion', role: '오케스트레이션', desc: 'CEO 오케스트레이터·통신허브' },
  { id: 'cheetah', role: '수집', desc: '트렌드 주제 수집' },
  { id: 'owl', role: '수집', desc: '심층·근거 수집' },
  { id: 'magpie', role: '수집', desc: 'Reddit·HN 수집' },
  { id: 'beaver', role: '작가', desc: 'how-to 작가' },
  { id: 'fox', role: '작가', desc: '리뷰 작가' },
  { id: 'wolf', role: '작가', desc: '오피니언 작가' },
  { id: 'eagle', role: '검증', desc: '사실검증' },
  { id: 'bee', role: '검증', desc: 'SEO 검증' },
  { id: 'swan', role: '검증', desc: '편집·가독성 검증' },
  { id: 'raven', role: '검증', desc: '독창성·표절 검증' },
  { id: 'peacock', role: '검증', desc: '렌더·형태 검증' },
  { id: 'penguin', role: '발행', desc: '발행' },
  { id: 'elephant', role: '거버넌스', desc: '거버넌스·자가진화' },
  { id: 'crane', role: '거버넌스', desc: '의사·건강검진' },
  { id: 'meerkat', role: '거버넌스', desc: '관제탑·위키 감사' },
];

const env = (p, k) => { try { const m = readFileSync(p, 'utf8').match(new RegExp('^' + k + '=(.+)', 'm')); return m ? m[1].trim().replace(/["']/g, '') : ''; } catch { return ''; } };
const SUPA_URL = process.env.SUPABASE_URL || env('.env', 'SUPABASE_URL') || env('repo/thundorun/web/.env.local', 'NEXT_PUBLIC_SUPABASE_URL');
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || env('.env', 'SUPABASE_SERVICE_ROLE_KEY') || env('repo/thundorun/web/.env.local', 'SUPABASE_SERVICE_ROLE_KEY');

function readJsonl(path) { if (!existsSync(path)) return []; return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function fm(text, key) { const m = text.match(new RegExp('^' + key + ':\\s*"?(.+?)"?\\s*$', 'm')); return m ? m[1] : ''; }

async function liveSlugs() {
  if (!SUPA_URL || !SUPA_KEY) return null;
  try {
    const r = await fetch(SUPA_URL.replace(/\/$/, '') + `/rest/v1/blog_posts?date=eq.${DATE}&status=eq.published&select=slug`, { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } });
    const rows = await r.json();
    return Array.isArray(rows) ? new Set(rows.map(x => x.slug)) : null;
  } catch { return null; }
}

function published(live) {
  const bySlug = new Map();
  try {
    for (const f of readdirSync('published')) {
      if (!f.startsWith(DATE) || !f.endsWith('.md')) continue;
      const t = readFileSync(`published/${f}`, 'utf8');
      const slug = fm(t, 'slug') || f.replace(/\.md$/, '');
      if (live && !live.has(slug)) continue;
      bySlug.set(slug, { file: `published/${f}`, slug, title: fm(t, 'title'), writer: (fm(t, 'writer') || '').toLowerCase(), imageBy: fm(t, 'image_by'), imgs: (t.match(/!\[/g) || []).length + (fm(t, 'cover_image') ? 1 : 0), syll: (t.replace(/^---[\s\S]*?---/, '').match(/[가-힣]/g) || []).length });
    }
  } catch {}
  return [...bySlug.values()];
}

function collectCount() {
  try { const rd = `runs/${DATE}/reddit`; if (!existsSync(rd)) return 0; let c = 0; for (const f of readdirSync(rd)) { if (f.endsWith('.json')) { try { const j = JSON.parse(readFileSync(`${rd}/${f}`, 'utf8')); c += Array.isArray(j) ? j.length : (j.items?.length || j.posts?.length || 0); } catch {} } } return c; } catch { return 0; }
}
// 수집 원소재 상위 제목 샘플(score 순) — 워킹트리 수집 노드 클릭 시 "무엇을 수집했나" 표시용
function collectSamples(limit = 5) {
  try {
    const rd = `runs/${DATE}/reddit`; if (!existsSync(rd)) return [];
    const items = [];
    for (const f of readdirSync(rd)) if (f.endsWith('.json')) { try { const j = JSON.parse(readFileSync(`${rd}/${f}`, 'utf8')); const arr = Array.isArray(j) ? j : (j.items || j.posts || []); for (const it of arr) if (it?.title) items.push({ title: String(it.title), score: +it.score || 0 }); } catch {} }
    return items.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.title);
  } catch { return []; }
}
function meerkatToday() { try { return readFileSync('docs/llm-wiki/log.md', 'utf8').split('\n').filter(l => l.includes('`' + DATE + '`')).map(l => l.replace(/^- /, '').slice(0, 90)); } catch { return []; } }

// 거버넌스 감사 결과 로더: crane/meerkat 결정론 스크립트가 state/ 에 남긴 산출물을 DATE 기준으로 읽는다.
// 우선순위: <name>.jsonl 에서 date 일치 최신 레코드 → 없으면 <name>.json(최신 1건)이 DATE 면 사용.
function stateForDate(base, date) {
  const jl = readJsonl(`state/${base}.jsonl`).filter(r => r && r.date === date);
  if (jl.length) return jl[jl.length - 1];
  try { const j = JSON.parse(readFileSync(`state/${base}.json`, 'utf8')); if (j && j.date === date) return j; } catch {}
  return null;
}

// SEO 요약: state/seo-metrics.jsonl 최신일 클릭·노출·평균순위 + 전일 대비 + KPI 진척률
function computeSeoSummary() {
  const metricsPath = 'state/seo-metrics.jsonl';
  if (!existsSync(metricsPath)) return null;
  // (date, dimension) → 마지막 레코드 유효 (gsc-collect upsert 규칙)
  const map = new Map();
  try {
    const lines = readFileSync(metricsPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { const rec = JSON.parse(line); if (rec.date && rec.dimension) map.set(`${rec.date}|${rec.dimension}`, rec); } catch {}
    }
  } catch { return null; }
  // page 차원 날짜 목록 (내림차순)
  const pageDates = [...map.keys()].filter(k => k.endsWith('|page')).map(k => k.replace('|page', '')).sort().reverse();
  if (pageDates.length === 0) return null;
  const latestDate = pageDates[0];
  const prevDate   = pageDates[1] || null;
  function dayTotals(date) {
    const rec = map.get(`${date}|page`);
    if (!rec || !Array.isArray(rec.rows)) return null;
    let clicks = 0, impressions = 0, posSum = 0, posN = 0;
    for (const row of rec.rows) {
      clicks += (row.clicks || 0); impressions += (row.impressions || 0);
      if (row.position != null) { posSum += row.position; posN++; }
    }
    return { clicks, impressions, avg_position: posN > 0 ? posSum / posN : null };
  }
  const latest = dayTotals(latestDate);
  const prev   = prevDate ? dayTotals(prevDate) : null;
  let kpi = null;
  try {
    const kpiCfg = JSON.parse(readFileSync('config/seo-kpi.json', 'utf8'));
    const target = kpiCfg.target_daily_clicks;
    if (target > 0 && latest) kpi = { target, progress: (latest.clicks / target * 100).toFixed(1), deadline: kpiCfg.deadline };
  } catch {}
  return { latestDate, latest, prev, kpi };
}

// 파이프라인 구조화 수치(웹 워킹트리 오버레이용). collect/select/publish/govern은 daily-brief 자체 집계에서,
// write/validate/run_status만 run.json에서 파생. 가드: drafts[] 있으면 현행 스키마, 없으면 legacy(개별 키 파싱 금지).
// write[].published는 run.json outcome이 아니라 발행 권위 소스(pub의 live-slug 집합)와 대조 — publish.count와 단일 진실.
// 검증자 tri-state: eagle/bee/swan/raven은 reviews[](게이트 통과 시에만 생성), peacock은 render-fit 게이트에서 파생.
function buildPipeline({ pub, collected, topics, poolTopics, samples, evolve, audit }) {
  const pubSlugs = new Set(pub.map(p => p.slug));
  const pipeline = {
    collect: { raw: collected, pool: topics, samples: samples || [], pool_topics: poolTopics || [] },
    select: { topics: null, titles: [] },
    write: [],
    validate: [],
    publish: { count: pub.length, slugs: [...pubSlugs] },
    govern: { evolve: evolve.map(e => e.verdict), audit: audit.length },
    run_status: 'no_run',
  };
  let run = null;
  try { run = JSON.parse(readFileSync(`runs/${DATE}/run.json`, 'utf8')); } catch { return pipeline; }
  if (!Array.isArray(run.drafts)) { pipeline.run_status = 'legacy'; return pipeline; }

  pipeline.run_status = run.status || 'ok';
  pipeline.select.topics = Array.isArray(run.topics_selected) ? run.topics_selected.length : null;
  pipeline.select.titles = [...new Set((run.topics_selected || []).map(t => t?.title).filter(Boolean))];

  const lastReviews = new Map(); // validator → verdict (마지막 유효 attempt 기준)
  let renderFit = null;          // peacock 상태: render-fit 게이트 최종 판정
  for (const d of run.drafts) {
    const last = Array.isArray(d.attempts) && d.attempts.length ? d.attempts[d.attempts.length - 1] : null;
    const gates = Array.isArray(last?.gate_gates) ? last.gate_gates : [];
    pipeline.write.push({
      writer: d.writer, title: d.title, attempts: d.attempts?.length || 0,
      gates_passed: gates.filter(g => g.pass).length, gates_total: gates.length,
      gates_failed: gates.filter(g => !g.pass).map(g => g.gate),
      published: pubSlugs.has(d.slug),
    });
    const rf = gates.find(g => g.gate === 'render-fit');
    if (rf) renderFit = renderFit === false ? false : rf.pass;
    if (Array.isArray(last?.reviews)) for (const r of last.reviews) {
      const cur = lastReviews.get(r.validator);
      lastReviews.set(r.validator, cur === 'fail' ? 'fail' : r.verdict);
    }
  }
  const toState = v => v == null ? 'unreached' : (v === 'pass' || v === true ? 'pass' : 'blocked');
  for (const v of ['eagle', 'bee', 'swan', 'raven']) pipeline.validate.push({ validator: v, state: toState(lastReviews.get(v)) });
  pipeline.validate.push({ validator: 'peacock', state: toState(renderFit) });
  return pipeline;
}

// 회고 생성: 작업한 에이전트별로 구독 LLM(claude -p)이 그날 기록 보고 회고 작성. 실패시 스킵(비차단).
async function addReflections(agents, summary, ctx = {}) {
  if (process.env.REFLECT === '0') return;
  const worked = agents.filter(a => a.did_work);
  if (!worked.length) return;
  const facts = worked.map(a => ({ id: a.id, desc: a.desc, records: a.records.map(r => ({ 무엇을: r.what, 왜: r.why, 어떻게: r.how })) }));
  const prompt = `다음은 오늘(${DATE}) blog-publisher 에이전트 회사의 활동 기록이다. 작업한 각 에이전트에 대해 짧은 회고를 작성하라. 각 항목 1문장, 기록에 근거해 구체적으로, 한국어. 막힌 부분/어려움이 없으면 "특이사항 없음". 출력은 JSON만(코드펜스·설명 금지):
{"<id>":{"결과요약":"...","느낀점":"...","어려웠던점":"...","막힌부분":"...","보완한점":"...","발전할부분":"..."}}

[오늘 요약] 발행 ${summary.published}편, 가동 ${summary.active_agents}/16, 진화 ${(ctx.evolve || []).map(e => e.verdict).join(',') || '없음'}.
[활동 기록]
${JSON.stringify(facts)}`;
  // 일시적 API 끊김(Connection closed·timeout 등)에 회고가 통째로 빠지지 않도록 최대 3회 재시도.
  const maxRetries = parseInt(process.env.CLAUDE_RETRIES || '2', 10);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // execFileSync(배열 인자) — 셸을 거치지 않는다. 예전엔 execSync 로 셸 문자열을 조립했는데
      // JSON.stringify 는 `"`·`\` 만 이스케이프할 뿐 `$(...)`·백틱은 그대로 남긴다. prompt 에는
      // 그날의 초안 제목·에이전트 기록(= Reddit/HN 수집물과 LLM 출력에서 온 값)이 들어가므로
      // 제목 하나로 이 박스에서 임의 명령이 실행됐다(.env 전체 크리덴셜 보유 프로세스). 실증 완료.
      const out = execFileSync('claude', ['-p', prompt, '--dangerously-skip-permissions'], { encoding: 'utf8', timeout: 200000, maxBuffer: 10 * 1024 * 1024 });
      const j = JSON.parse(out.replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '').match(/\{[\s\S]*\}/)[0]);
      for (const a of agents) if (j[a.id]) a.reflection = j[a.id];
      console.log('[daily-brief] 회고 생성:', Object.keys(j).length, '에이전트');
      return;
    } catch (e) {
      const transient = isTransientClaudeError(`${e.message || ''} ${e.stderr || ''}`);
      if (attempt < maxRetries && transient) {
        const wait = 2000 * Math.pow(2, attempt);
        console.error(`[daily-brief] 회고 생성 일시오류 재시도 ${attempt + 1}/${maxRetries} (${wait}ms 후)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error('[daily-brief] 회고 생성 스킵:', String(e.message).slice(0, 80));
      return;
    }
  }
}

async function build() {
  const live = await liveSlugs();
  const pub = published(live);
  // 자가진화 = 실제 A/B 판정(verdict 존재)만 집계. validator-baseline 등 verdict 없는 항목은 진화가 아니라 거버넌스 기록으로 흡수.
  const evolveAll = readJsonl('state/evolve-history.jsonl').filter(e => (e.ts || '').startsWith(DATE));
  const evolve = evolveAll.filter(e => e.verdict);
  const valBaselines = evolveAll.filter(e => !e.verdict && e.kind === 'validator-baseline');
  const audit = readJsonl('.omc/audit/audit-log.jsonl').filter(e => (e.ts || '').startsWith(DATE));
  const cronLog = existsSync(`runs/cron-${DATE}.log`);
  const collected = collectCount();
  const mk = meerkatToday();
  const seoSummary = computeSeoSummary();

  // 에이전트별 5W1H 레코드 수집
  const rec = {}; AGENTS.forEach(a => rec[a.id] = []);
  const push = (id, r) => rec[id] && rec[id].push({ when: r.when || DATE, where: r.where, what: r.what, why: r.why, how: r.how, ...(r.evo ? { evo: r.evo } : {}) });

  // lion
  push('lion', { where: `전체 런 / runs/${DATE}`, what: '일일 런 오케스트레이션·자가치유', why: `${pub.length}편 발행 조율`, how: cronLog ? '자율 cron 가동(구독 헤드리스)' : (pub.length ? '수동 실행' : '미실행' ) });
  // 수집
  // 수집: 협업 풀(pool.json) 있으면 3 collectors 전원 크레딧, 없으면 reddit raw → magpie
  let topics = 0, poolTopics = [];
  try { const pp = `runs/${DATE}/topics/pool.json`; if (existsSync(pp)) { const j = JSON.parse(readFileSync(pp, 'utf8')); if (Array.isArray(j)) { topics = j.length; poolTopics = j.map(t => t?.topic || t?.title).filter(Boolean); } } } catch {}
  if (topics > 0) {
    push('magpie', { where: `STEP1 → runs/${DATE}/reddit`, what: 'Reddit·HN 실수집', why: '니치 원소재 확보', how: `${collected}건 수집` });
    push('cheetah', { where: `STEP1 → runs/${DATE}/topics/pool.json`, what: '트렌드 주제 도출', why: '지금 주목 각도 선별', how: `주제 후보 ${topics}개 풀 기여` });
    push('owl', { where: `STEP1 → runs/${DATE}/topics/pool.json`, what: '심층 근거·출처 보강', why: '작가 근거 제공', how: `${topics}개 주제 source 보강` });
  } else if (collected > 0) {
    push('magpie', { where: `STEP1 → runs/${DATE}/reddit`, what: 'Reddit·HN 실수집', why: '니치 소재', how: `${collected}건 메타 수집` });
  }
  // 작가 + 발행 + 디자이너(검증은 게이트로 환산)
  for (const p of pub) {
    const w = p.writer || 'beaver';
    push(w, { where: `STEP3 → ${p.file}`, what: '초안 작성', why: `주제: ${p.title.slice(0, 26)}`, how: `${p.syll}음절·결정론 게이트 전종 통과` });
    push('penguin', { where: 'STEP6 → blog_posts DB·홈페이지', what: '발행', why: p.slug, how: `DB upsert·이미지 ${p.imgs}장` });
  }
  // 검증팀: 파이프라인 validate tri-state로 기록 정합화(블랭킷 '전수 통과' 금지).
  // peacock=render-fit 결정론 게이트 파생, 나머지 4명=게이트 통과 후 STEP5 LLM 리뷰. 미도달(unreached)은 기록 없음(did_work=false로 일관).
  const pipeline = buildPipeline({ pub, collected, topics, poolTopics, samples: collectSamples(), evolve, audit });
  const VAL_CHECK = { eagle: '사실·수치·출처 정합성', bee: '키워드·구조·메타 SEO', swan: '가독성·흐름·문장 완성도', raven: '독창성·표절·진부표현', peacock: '홈 렌더·형태 적합성' };
  const candidates = pipeline.write.length;
  for (const vs of pipeline.validate) {
    if (vs.state === 'unreached') continue;
    const verdict = vs.state === 'pass' ? '통과' : '차단';
    const basis = vs.validator === 'peacock' ? 'render-fit 결정론 게이트 파생' : '게이트 통과 초안 STEP5 LLM 리뷰';
    push(vs.validator, { where: 'STEP5 검증', what: `${VAL_CHECK[vs.validator] || '품질'} 판정=${verdict}`, why: `심사 초안 ${candidates}편`, how: basis });
  }
  // 베이스라인 갱신은 오늘 초안 심사가 아니라 scorer-validator의 거버넌스 활동 → 검증자(bee) 노드가 아닌 거버넌스(elephant)에 귀속.
  // (검증자 노드에 붙이면 tri-state 미도달과 모순돼 "미도달인데 일함"처럼 보임.)
  for (const b of valBaselines) push('elephant', { when: (b.ts || DATE).slice(0, 16), where: 'state/evolve-history.jsonl', what: `검증 베이스라인 공식 갱신${b.writer ? ` (${b.writer} 기준)` : ''}`, why: `기준 v${b.criteria_version ?? '?'}·score ${b.score ?? '?'}`, how: b.note || 'scorer-validator 베이스라인' });
  // 진화(elephant) — 5W1H 보존 + evo(상세 서사) 첨부: 왜/뭐가부족(target_weakness)·어떻게 발전(proposal)·판정 지표·근거(note).
  // evo 필드는 이미 evolve-history.jsonl 에 있으나 5W1H 축약으로 유실돼 온 정보. 사이트가 '자가진화 클릭 → 상세'로 노출하도록 구조화 전달.
  for (const e of evolve) push('elephant', {
    when: (e.ts || DATE).slice(0, 16),
    where: `STEP7 → .claude/agents/${e.writer}.md`,
    what: `자가진화 판정=${e.verdict}`,
    why: `fitness ${(+e.baseline?.score || 0).toFixed(1)}→${(+e.variant?.score || 0).toFixed(1)}`,
    how: e.verdict === 'adopt' ? '채택·버전↑' : '기각·현버전 유지(단조성)',
    evo: {
      writer: e.writer ?? null,
      verdict: e.verdict ?? null,
      version: e.version ?? null,
      target_weakness: e.target_weakness ?? null,
      proposal: e.proposal_summary ?? e.proposal ?? null,
      scoring: e.scoring ?? null,
      baseline: e.baseline ?? null,
      variant: e.variant ?? null,
      improved: typeof e.improved === 'boolean' ? e.improved : null,
      noRegress: typeof e.noRegress === 'boolean' ? e.noRegress : null,
      note: e.note ?? null,
    },
  });
  // meerkat (위키 로그)
  for (const l of mk) push('meerkat', { where: 'docs/llm-wiki', what: '위키 방법론 감사·기록', why: '준수 유지', how: l });

  // meerkat (준수 감사 — compliance-audit.mjs --persist 산출물)
  const mkAudit = stateForDate('meerkat-audit', DATE);
  if (mkAudit) {
    const offenders = [...new Set((mkAudit.violations || []).map(v => v.agent))];
    push('meerkat', {
      where: '.claude/agents/*.md · docs/llm-wiki',
      what: '방법론 준수 주기 감사',
      why: `에이전트 ${mkAudit.agents_checked}개 계약·위키 정합 점검`,
      how: mkAudit.all_compliant
        ? '전원 준수(위반 0)'
        : `위반 ${mkAudit.violations_total}건(critical ${mkAudit.critical_total}) — ${offenders.join(',')} → lion 시정 제안`,
    });
  }

  // crane (건강검진 — health-check.mjs 산출물). run.json 있던 날만 표출(no_run=검진 보류).
  const craneRec = stateForDate('crane-health', DATE);
  if (craneRec && craneRec.run_status !== 'no_run') {
    const f = craneRec.findings || [];
    push('crane', {
      where: `runs/${DATE}/run.json`,
      what: '에이전트 건강검진',
      why: `런 ${craneRec.run_status} · 발행 ${craneRec.signals?.published_count ?? '?'}편`,
      how: f.length
        ? `이상소견 ${f.length}건${craneRec.escalate ? ' · lion 에스컬레이션' : ''}`
        : '전원 정상(이상 없음)',
    });
    // agent-health 소견은 개별 표출 — 누가 아팠고 수리안이 뭔지
    for (const x of f.filter(x => (x.kind || '').includes('health'))) {
      push('crane', {
        where: `runs/${DATE}/run.json · incidents`,
        what: `이상 감지: ${x.agent || '?'}`,
        why: `[${x.severity}] ${String(x.symptom).slice(0, 60)}`,
        how: `수리안: ${x.proposal}`,
      });
    }
  }

  // ── 16 에이전트 구조화 ──
  const agents = AGENTS.map(a => ({ ...a, did_work: rec[a.id].length > 0, records: rec[a.id] }));
  const summary = {
    published: pub.length, cron: cronLog,
    writers: { beaver: pub.filter(p => p.writer === 'beaver').length, fox: pub.filter(p => p.writer === 'fox').length, wolf: pub.filter(p => p.writer === 'wolf').length },
    evolve: evolve.map(e => e.verdict), images: pub.filter(p => p.imageBy).length, audit: audit.length,
    active_agents: agents.filter(a => a.did_work).length, idle_agents: agents.filter(a => !a.did_work).map(a => a.id),
    pipeline,
  };

  // 회고 생성(구독 LLM): 작업한 에이전트별 결과요약·느낀점·어려웠던점·막힌부분·보완한점·발전할부분
  await addReflections(agents, summary, { evolve });

  // 진단 덤프(env DUMP_AGENTS 지정 시에만) — 크리덴셜 없이 백필/검증용. cron 미지정 → 무영향.
  if (process.env.DUMP_AGENTS) { try { writeFileSync(process.env.DUMP_AGENTS, JSON.stringify({ date: DATE, summary, agents }, null, 2)); console.log('[daily-brief] DUMP_AGENTS →', process.env.DUMP_AGENTS); } catch (e) { console.error('[daily-brief] DUMP 오류:', e.message); } }

  // ── ① DB upsert ──
  if (SUPA_URL && SUPA_KEY) {
    try {
      // ⚠ merge-duplicates 는 **행 단위 교체**다. 경영회의(run-board)가 같은 날 `summary.board` 를
      // 써 두는데, 여기서 그걸 모르는 summary 로 덮으면 회의 결과가 조용히 사라진다(프론트는
      // board 를 optional 로 다뤄서 티도 안 난다). 그래서 쓰기 전에 기존 board 를 읽어 실어 보낸다.
      let mergedSummary = summary;
      try {
        const prev = await fetch(SUPA_URL.replace(/\/$/, '') + `/rest/v1/agent_reports?date=eq.${DATE}&select=summary`, { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY } });
        if (prev.ok) {
          const rows = await prev.json();
          const existingBoard = Array.isArray(rows) && rows[0]?.summary?.board;
          if (existingBoard) { mergedSummary = { ...summary, board: existingBoard }; console.log('[daily-brief] 기존 경영회의 결과 보존'); }
        }
      } catch (e) { console.error('[daily-brief] 기존 board 조회 경고(계속):', e.message); }
      const r = await fetch(SUPA_URL.replace(/\/$/, '') + '/rest/v1/agent_reports?on_conflict=date', { method: 'POST', headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ date: DATE, summary: mergedSummary, agents }) });
      console.log('[daily-brief] DB upsert HTTP', r.status, r.status < 300 ? '✅' : await r.text().then(t => t.slice(0, 150)));
    } catch (e) { console.error('[daily-brief] DB upsert 오류:', e.message); }
  }

  // ── ② 마크다운(아카이브, 16 전원) ──
  const L = [`# 🦁 에이전트 일일 업무보고 — ${DATE}`, '', `> 16 에이전트 전원 육하원칙. 자동생성 \`scripts/report/daily-brief.mjs\` · DB \`agent_reports\` · 방법론 [[agent-reporting]].`, ''];
  L.push(`## 오늘 한눈에`, `- 발행 **${summary.published}편** · 자율 cron ${cronLog ? '가동✅' : '미가동'} · 가동 에이전트 ${summary.active_agents}/16`, `- 작가 beaver ${summary.writers.beaver}·fox ${summary.writers.fox}·wolf ${summary.writers.wolf} · 진화 ${summary.evolve.join(',') || '없음'} · 이미지 ${summary.images}편`, '');
  // ── SEO 섹션 ──
  if (!seoSummary || !seoSummary.latest) {
    L.push(`## SEO`, `- GSC 미연동 (state/seo-metrics.jsonl 없음 — gsc-collect.mjs 먼저 실행 필요)`, '');
  } else {
    const { latestDate, latest, prev, kpi } = seoSummary;
    const delta = (key, toFixed = 0) => {
      if (!prev || prev[key] == null || latest[key] == null) return '';
      const d = latest[key] - prev[key];
      const s = d >= 0 ? `+${d.toFixed(toFixed)}` : d.toFixed(toFixed);
      return ` (${s})`;
    };
    const posStr = latest.avg_position != null ? latest.avg_position.toFixed(1) : 'N/A';
    const posD   = (prev && prev.avg_position != null && latest.avg_position != null)
      ? (() => { const d = latest.avg_position - prev.avg_position; return d <= 0 ? ` (${d.toFixed(1)} 순위↑)` : ` (+${d.toFixed(1)} 순위↓)`; })()
      : '';
    const kpiStr = kpi
      ? ` · KPI 진척 **${kpi.progress}%** (목표 ${kpi.target}클릭/일, 기한 ${kpi.deadline})`
      : '';
    L.push(
      `## SEO`,
      `- 기준일 **${latestDate}** · 클릭 **${latest.clicks}**${delta('clicks')} · 노출 **${latest.impressions}**${delta('impressions')} · 평균순위 **${posStr}위**${posD}${kpiStr}`,
      ''
    );
  }
  let lastRole = '';
  for (const a of agents) {
    if (a.role !== lastRole) { L.push(`## ${a.role}`); lastRole = a.role; }
    L.push(`### ${a.id} — ${a.desc}`);
    if (!a.did_work) { L.push(`> **오늘 한 작업 없음.**`, ''); continue; }
    L.push('| 언제 | 어디서 | 무엇을 | 왜 | 어떻게 |', '|---|---|---|---|---|');
    for (const r of a.records) L.push(`| ${r.when} | ${r.where} | ${r.what} | ${r.why} | ${r.how} |`);
    const rf = a.reflection;
    if (rf) {
      L.push('', `**회고** — ${rf['결과요약'] || ''}`);
      for (const [label, key] of [['느낀점', '느낀점'], ['어려웠던 점', '어려웠던점'], ['막힌 부분', '막힌부분'], ['보완한 점', '보완한점'], ['발전할 부분', '발전할부분']]) {
        if (rf[key]) L.push(`- ${label}: ${rf[key]}`);
      }
    }
    L.push('');
  }
  L.push('---', `*기록 ${new Date().toISOString()} · 매일 cron 종료 시 자동 생성·DB 저장.*`);
  mkdirSync('docs/work-history', { recursive: true });
  writeFileSync(`docs/work-history/${DATE}.md`, L.join('\n'), 'utf8');

  // ── ③ index ──
  const idxFile = 'docs/work-history/index.md';
  let idx = existsSync(idxFile) ? readFileSync(idxFile, 'utf8') : '# 업무 히스토리 (일일 에이전트 보고)\n\n> 매일 자동 생성되는 육하원칙 기반 에이전트 업무보고. DB(agent_reports)+문서. 방법론 [[agent-reporting]].\n\n';
  const line = `- [${DATE}](${DATE}.md) — 발행 ${pub.length}편, 가동 ${summary.active_agents}/16, 진화 ${summary.evolve.join(',') || '없음'}`;
  if (!idx.includes(`(${DATE}.md)`)) { const p = idx.split('\n\n'); idx = [p[0], p[1], line, p.slice(2).join('\n\n')].filter(Boolean).join('\n\n'); writeFileSync(idxFile, idx, 'utf8'); }

  console.log(`[daily-brief] ✅ ${DATE}: 발행 ${pub.length}, 가동 ${summary.active_agents}/16 → DB+문서`);
}

build().catch(e => { console.error('[daily-brief] 오류:', e.message); process.exit(1); });
