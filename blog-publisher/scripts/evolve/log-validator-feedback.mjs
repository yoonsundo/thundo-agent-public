// log-validator-feedback.mjs — 발행 후 실측 성과 ↔ bee 판정 대조 (설계 §2.5, 주 1회).
// 발행 N일 경과 글을 조회수(traffic_pv) 사분위로 라벨하고, 발행 당시 bee Review JSON
// (runs/<날짜>/reviews/<slug>.bee.json — 런북 STEP5 저장 계약)과 대조해
// miss(고평가했는데 성과 하위)·false-alarm(플래그 세웠는데 성과 상위)을
// state/evolve-feedback.jsonl 에 writer:"bee" 로 기록한다. 소비자: evolve-cycle(일요일 검증자 슬롯).
//
// 주의: 실측 신호는 fitness 에 직접 넣지 않는다 — 약점 힌트로만 쓴다(설계 §2.5, reward hacking 표면 최소화).
// GSC(state/seo-metrics.jsonl)가 생기면 클릭 데이터로 라벨을 보강한다(현재는 traffic_pv 조회수만).
//
// 사용: node scripts/evolve/log-validator-feedback.mjs [--dry]
//   FEEDBACK_MIN_AGE_DAYS  성과 안정화 대기일 (기본 14 — 설계 원안 30이나 신생 사이트라 단축, 성숙 후 상향)
//   FEEDBACK_MIN_POSTS     사분위 계산 최소 표본 (기본 4)
import { readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs';

const MIN_AGE_DAYS = parseInt(process.env.FEEDBACK_MIN_AGE_DAYS || '14', 10);
const MIN_POSTS = parseInt(process.env.FEEDBACK_MIN_POSTS || '4', 10);
const FEEDBACK_PATH = 'state/evolve-feedback.jsonl';
const DRY = process.argv.includes('--dry');

function log(m) { console.log(`[validator-feedback] ${m}`); }

function envOf(key) {
  const m = readFileSync('.env', 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

async function sb(path) {
  const url = envOf('SUPABASE_URL'), key = envOf('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('.env SUPABASE_URL/SERVICE_ROLE_KEY 없음');
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return res.json();
}

// runs/<날짜>/reviews/<slug>.bee.json 전체 수집 → slug → review (최신 우선)
function loadReviews() {
  const map = new Map();
  if (!existsSync('runs')) return map;
  for (const day of readdirSync('runs').sort()) {
    const dir = `runs/${day}/reviews`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.bee.json'))) {
      try { map.set(f.replace(/\.bee\.json$/, ''), JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))); } catch {}
    }
  }
  return map;
}

/** 이미 기록한 slug(중복 로그 방지) */
function alreadyLogged() {
  const seen = new Set();
  if (!existsSync(FEEDBACK_PATH)) return seen;
  for (const line of readFileSync(FEEDBACK_PATH, 'utf8').trim().split('\n')) {
    try { const j = JSON.parse(line); if (j.writer === 'bee' && j.kind === 'validator-feedback') (j.slugs || []).forEach(s => seen.add(s)); } catch {}
  }
  return seen;
}

async function main() {
  // 1) 발행글 + 조회수
  const posts = await sb('blog_posts?select=slug,date,status&status=eq.published&order=date.asc');
  const cutoff = new Date(Date.now() - MIN_AGE_DAYS * 86400e3).toISOString().slice(0, 10);
  const aged = posts.filter(p => p.date && p.date <= cutoff);
  log(`발행글 ${posts.length}편, ${MIN_AGE_DAYS}일 경과 ${aged.length}편 (기준일 ≤ ${cutoff})`);
  if (aged.length < MIN_POSTS) { log(`표본 부족(<${MIN_POSTS}) — 사분위 라벨 불가. 종료(정상).`); return; }

  const pv = await sb('traffic_pv?select=path,views&path=like./blog/*&limit=20000');
  const views = {};
  for (const r of pv) {
    const slug = String(r.path || '').replace(/^\/blog\//, '').replace(/\/$/, '');
    if (slug && !slug.includes('/')) views[slug] = (views[slug] || 0) + (Number(r.views) || 0);
  }

  // 2) 사분위 라벨
  const ranked = aged.map(p => ({ slug: p.slug, v: views[p.slug] || 0 })).sort((a, b) => a.v - b.v);
  const q = n => ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * n))].v;
  const [q1, q3] = [q(0.25), q(0.75)];
  const bottom = new Set(ranked.filter(r => r.v <= q1).map(r => r.slug));
  const top = new Set(ranked.filter(r => r.v >= q3).map(r => r.slug));
  log(`조회수 사분위: q1=${q1} q3=${q3} (하위 ${bottom.size} / 상위 ${top.size})`);

  // 3) bee 리뷰 대조
  const reviews = loadReviews();
  const seen = alreadyLogged();
  log(`영속화된 bee 리뷰 ${reviews.size}건, 기존 기록 slug ${seen.size}건`);
  const misses = [], falseAlarms = [];
  for (const { slug } of ranked) {
    if (seen.has(slug)) continue;
    const r = reviews.get(slug);
    if (!r) continue; // 리뷰 없는 글(영속화 계약 이전 발행)은 대조 불가 — 스킵
    const flags = (r.aeo_flags?.length || 0) + (r.flags?.length || 0);
    if (bottom.has(slug) && r.verdict === 'pass' && flags === 0) misses.push(slug);
    if (top.has(slug) && flags >= 2) falseAlarms.push(slug);
  }

  if (!misses.length && !falseAlarms.length) { log('신규 miss/false-alarm 없음. 종료(정상).'); return; }
  const weaknesses = [
    ...misses.map(s => `miss — pass·무플래그인데 조회수 하위 사분위 (${s})`),
    ...falseAlarms.map(s => `false-alarm — 플래그 2+인데 조회수 상위 사분위 (${s})`),
  ];
  const rec = {
    ts: new Date().toISOString(), writer: 'bee', kind: 'validator-feedback',
    window_days: MIN_AGE_DAYS, slugs: [...misses, ...falseAlarms], weaknesses,
  };
  if (DRY) { log(`--dry: 기록 생략\n${JSON.stringify(rec, null, 2)}`); return; }
  appendFileSync(FEEDBACK_PATH, JSON.stringify(rec) + '\n');
  log(`기록: miss ${misses.length} / false-alarm ${falseAlarms.length} → ${FEEDBACK_PATH}`);
}

main().catch(e => { log(`치명 오류: ${e.message}`); process.exit(2); });
