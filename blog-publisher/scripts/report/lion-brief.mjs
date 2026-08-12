/**
 * lion-brief.mjs — 사장님 SEO/AEO 성과 브리핑 → Slack(CRW 웹훅) + Telegram.
 * CLI: node --env-file=.env scripts/report/lion-brief.mjs [YYYY-MM-DD]
 * DRY: LION_BRIEF_DRY=1 또는 --dry 인자 → 발송 없이 stdout 출력.
 *
 * 발행 활동 보고가 아니라 "검색·답변엔진에서 어떻게 되고 있나"가 본문이다 (2026-07-06 방향 전환):
 *   1) 🔍 검색 성과 — GSC 클릭·노출·CTR·평균순위 (전일比) + 상위 쿼리·페이지
 *   2) 🤖 AEO 준비도 — 오늘 발행분 bee 심사 점수(기준 7종)와 공통 약점
 *   3) 📈 내부 조회수 — Supabase traffic_summary
 *   4) 📰 오늘 발행 — 한 줄 요약 (상세는 /reports 몫)
 *   5) ⏭ 다음 액션 — 쿼리 순위·AEO 약점에서 파생한 구체 제안
 *
 * 데이터:
 *   - state/seo-metrics.jsonl        : GSC page/query 차원 (수집은 gsc-collect, ~3일 지연)
 *   - runs/<date>/reviews/*.bee.json : bee AEO advisory 심사 (aeo_scores)
 *   - runs/<date>/run.json + published/<date>-*.md : 발행물
 *   - Supabase RPC traffic_summary   : 내부 조회수
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { env } from '../lib/config.mjs';
import { sendReport } from '../notify/send-report.mjs';
import { sendSlackWebhook } from '../notify/slack-webhook.mjs';

// ── CLI 파싱 ─────────────────────────────────────────────────────────────────
const DRY = process.env.LION_BRIEF_DRY === '1' || process.argv.includes('--dry');
const DATE = process.argv.slice(2).filter(a => a !== '--dry')[0]
  || new Date().toISOString().slice(0, 10);

// ── 파일 유틸 ────────────────────────────────────────────────────────────────
function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function fmField(mdPath, key) {
  if (!existsSync(mdPath)) return '';
  try {
    const m = readFileSync(mdPath, 'utf8')
      .match(new RegExp('^' + key + ':\\s*"?(.+?)"?\\s*$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// ── 발행물 발견 (구 버전과 동일 로직의 축약형) ────────────────────────────────
function discoverPublished(run, date) {
  let entries;
  if (Array.isArray(run.published) && run.published.length) {
    entries = run.published
      .map(p => (typeof p === 'string' ? { slug: p.replace(/^published\//, '').replace(new RegExp('^' + date + '-'), '').replace(/\.md$/, '') } : p))
      .filter(e => e.slug);
  } else {
    let files = [];
    try { files = readdirSync('published').filter(f => f.startsWith(`${date}-`) && f.endsWith('.md')); } catch {}
    entries = files.map(f => ({ slug: f.replace(new RegExp('^' + date + '-'), '').replace(/\.md$/, '') }));
  }
  return entries.map(e => {
    const file = `published/${date}-${e.slug}.md`;
    return {
      slug: e.slug,
      title: fmField(file, 'title') || e.slug,
      writer: e.writer || fmField(file, 'writer') || '',
    };
  });
}

// ── GSC seo-metrics: 최신일 page/query 집계 + 전일 델타 ──────────────────────
function loadSeo() {
  const path = 'state/seo-metrics.jsonl';
  if (!existsSync(path)) return null;
  const map = new Map();
  try {
    for (const line of readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        if (r.date && r.dimension) map.set(`${r.date}|${r.dimension}`, r);
      } catch {}
    }
  } catch { return null; }
  const dates = [...map.keys()].filter(k => k.endsWith('|page')).map(k => k.slice(0, 10)).sort().reverse();
  if (!dates.length) return null;

  function agg(rows) {
    let clicks = 0, impressions = 0, posW = 0;
    for (const r of rows) {
      clicks += r.clicks || 0;
      impressions += r.impressions || 0;
      posW += (r.position || 0) * (r.impressions || 0);
    }
    return {
      clicks, impressions,
      ctr: impressions ? clicks / impressions : 0,
      position: impressions ? posW / impressions : null,
    };
  }
  const latestDate = dates[0];
  const pageRows = map.get(`${latestDate}|page`)?.rows || [];
  const queryRows = map.get(`${latestDate}|query`)?.rows || [];
  const prevRows = dates[1] ? (map.get(`${dates[1]}|page`)?.rows || []) : null;

  const bySignal = (a, b) => (b.clicks - a.clicks) || (b.impressions - a.impressions);
  return {
    gscDate: latestDate,
    total: agg(pageRows),
    prev: prevRows ? agg(prevRows) : null,
    topQueries: [...queryRows].sort(bySignal).slice(0, 3),
    topPages: [...pageRows].sort(bySignal).slice(0, 2),
  };
}

// ── bee AEO advisory 심사 로드 ───────────────────────────────────────────────
const AEO_KO = {
  'question-headings': '질문형 H2',
  'passage-self-containment': '문단 자기완결',
  'direct-answer-upfront': '도입부 직답',
  'citation-worthiness': '인용 가치',
  'faq-self-containment': 'FAQ 자기완결',
  'meta-description-quality': '메타 설명',
  'scannable-structure': '스캔 용이성',
};

// bee 산출 id 표기 편차 흡수: snake_case·"-coverage" 접미 등을 정식 kebab id 로 정규화
function normAeoId(id) {
  const k = String(id).toLowerCase().replace(/_/g, '-').replace(/-coverage$/, '');
  if (k.startsWith('question-heading')) return 'question-headings';
  return AEO_KO[k] ? k : k;
}

function loadAeo(date, published) {
  const dir = `runs/${date}/reviews`;
  if (!existsSync(dir)) return null;
  const titleBySlug = new Map(published.map(p => [p.slug, p.title]));
  const posts = [];
  const critSum = new Map(); // criterion → {sum, n}
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.bee.json')); } catch { return null; }
  for (const f of files) {
    const r = readJson(`${dir}/${f}`);
    const scores = r?.aeo_scores;
    if (!scores || typeof scores !== 'object') continue;
    const entries = Object.entries(scores)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => [normAeoId(k), v]);
    if (!entries.length) continue;
    const avg = entries.reduce((s, [, v]) => s + v, 0) / entries.length;
    const weakest = entries.reduce((w, e) => (e[1] < w[1] ? e : w));
    for (const [k, v] of entries) {
      const c = critSum.get(k) || { sum: 0, n: 0 };
      c.sum += v; c.n += 1; critSum.set(k, c);
    }
    posts.push({
      slug: r.slug,
      title: titleBySlug.get(r.slug) || r.slug,
      verdict: r.verdict,
      avg: Math.round(avg),
      weakest: { id: weakest[0], score: weakest[1] },
    });
  }
  if (!posts.length) return null;
  let commonWeak = null;
  for (const [id, { sum, n }] of critSum) {
    const avg = sum / n;
    if (!commonWeak || avg < commonWeak.avg) commonWeak = { id, avg: Math.round(avg) };
  }
  const overall = Math.round(posts.reduce((s, p) => s + p.avg, 0) / posts.length);
  return { posts, overall, commonWeak };
}

// ── Supabase traffic_summary RPC ─────────────────────────────────────────────
function prevDateOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchTrafficPv(date) {
  const supaUrl = env('SUPABASE_URL');
  const supaKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!supaUrl || !supaKey) return null;
  try {
    const r = await fetch(
      `${supaUrl.replace(/\/$/, '')}/rest/v1/rpc/traffic_summary`,
      {
        method: 'POST',
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_from: date, p_to: date }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!r.ok) return null;
    const data = await r.json();
    return typeof data === 'object' && data !== null ? data.total_pv ?? null : null;
  } catch { return null; }
}

// ── 브리핑 조립 ──────────────────────────────────────────────────────────────
const pct = x => (x * 100).toFixed(1) + '%';
const delta = (cur, prev) => (prev === null || prev === undefined) ? '' : ` (전일比 ${cur - prev >= 0 ? '+' : ''}${cur - prev})`;

async function buildBriefing() {
  const run = readJson(`runs/${DATE}/run.json`, {});
  const published = discoverPublished(run, DATE);
  const seo = loadSeo();
  const aeo = loadAeo(DATE, published);
  const yesterday = prevDateOf(DATE);
  const [todayPv, yestPv] = await Promise.all([fetchTrafficPv(DATE), fetchTrafficPv(yesterday)]);

  // 헤드라인: 검색 성과가 주어, 발행은 종속절
  let headline;
  if (seo) {
    headline = `검색 클릭 ${seo.total.clicks} · 노출 ${seo.total.impressions}`
      + (seo.prev ? ` (클릭 전일比 ${seo.total.clicks - seo.prev.clicks >= 0 ? '+' : ''}${seo.total.clicks - seo.prev.clicks})` : '')
      + ` — 오늘 ${published.length}편 발행`;
  } else {
    headline = `오늘 ${published.length}편 발행 — GSC 데이터 수집 전`;
  }

  // 다음 액션: 데이터에서 파생
  const actions = [];
  if (seo) {
    const q = seo.topQueries.find(q => (q.impressions || 0) >= 10 && (q.position || 0) > 5);
    if (q) actions.push(`쿼리 "${q.key}" 노출 ${q.impressions}·평균순위 ${q.position.toFixed(1)}위 — 해당 글 제목·도입부 직답 보강하면 상위 노출 여지`);
    if (seo.total.impressions > 0 && seo.total.ctr < 0.03) {
      actions.push(`전체 CTR ${pct(seo.total.ctr)} — 노출 대비 클릭 저조, 제목·메타 설명 소구력 점검 대상`);
    }
  }
  if (aeo?.commonWeak && aeo.commonWeak.avg < 75) {
    actions.push(`오늘 발행분 공통 AEO 약점: ${AEO_KO[aeo.commonWeak.id] || aeo.commonWeak.id} (평균 ${aeo.commonWeak.avg}점) — 다음 발행부터 작가 프롬프트 개선 포인트`);
  }
  if (!actions.length) actions.push('특이 액션 없음 — 내일 파이프라인 정상 가동 예정');

  return { date: DATE, published, seo, aeo, todayPv, yestPv, headline, actions };
}

// ── 렌더러 (SEO/AEO 전용 — parrot의 작업보고 프레임 미사용) ───────────────────
function seoLines(b) {
  const L = [];
  if (b.seo) {
    const s = b.seo, d = b.seo.prev;
    L.push(
      `클릭 ${s.total.clicks}${delta(s.total.clicks, d?.clicks)} · 노출 ${s.total.impressions}${delta(s.total.impressions, d?.impressions)}`
      + ` · CTR ${pct(s.total.ctr)}${s.total.position ? ` · 평균순위 ${s.total.position.toFixed(1)}위` : ''}`,
    );
    for (const q of s.topQueries) {
      L.push(`• "${q.key}" — 클릭 ${q.clicks} · 노출 ${q.impressions} · ${q.position.toFixed(1)}위`);
    }
    for (const p of s.topPages) {
      const path = String(p.key || '').replace(/^https?:\/\/[^/]+/, '');
      L.push(`• ${path} — 클릭 ${p.clicks} · 노출 ${p.impressions}`);
    }
  }
  return L;
}

function aeoLines(b) {
  if (!b.aeo) return [];
  const L = [`오늘 발행 ${b.aeo.posts.length}편 평균 ${b.aeo.overall}점 · 공통 약점: ${AEO_KO[b.aeo.commonWeak.id] || b.aeo.commonWeak.id} (평균 ${b.aeo.commonWeak.avg}점)`];
  for (const p of b.aeo.posts) {
    L.push(`• ${p.title.slice(0, 40)} — ${p.avg}점 (최저: ${AEO_KO[p.weakest.id] || p.weakest.id} ${p.weakest.score})`);
  }
  return L;
}

function pvLine(b) {
  if (b.todayPv === null) return 'Supabase 조회수 집계 실패 또는 미구성';
  return `${b.todayPv}건${b.yestPv !== null ? delta(b.todayPv, b.yestPv) : ''}`;
}

function renderSlackBrief(b) {
  const S = t => ({ type: 'section', text: { type: 'mrkdwn', text: t.slice(0, 2900) } });
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 SEO/AEO 성과 브리핑 — ${b.date}`, emoji: true } },
    S(b.headline),
  ];
  if (b.seo) blocks.push(S(`*🔍 검색 성과* _(GSC ${b.seo.gscDate} 기준 — 집계 ~3일 지연)_\n` + seoLines(b).join('\n')));
  else blocks.push(S('*🔍 검색 성과*\nGSC 데이터 없음 (gsc-collect 수집 전)'));
  if (b.aeo) blocks.push(S('*🤖 AEO 준비도* _(bee 심사, 기준 7종)_\n' + aeoLines(b).join('\n')));
  blocks.push(S(`*📈 내부 조회수*\n${pvLine(b)}`));
  if (b.published.length) {
    blocks.push(S('*📰 오늘 발행*\n' + b.published.map(p => `• ${p.title}${p.writer ? ` (${p.writer})` : ''}`).join('\n')));
  }
  blocks.push(S('*⏭ 다음 액션*\n' + b.actions.map(a => `• ${a}`).join('\n')));
  return { text: `📊 SEO/AEO 성과 브리핑 — ${b.date}: ${b.headline}`, blocks };
}

function renderTelegramBrief(b) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const L = [`<b>📊 SEO/AEO 성과 브리핑 — ${b.date}</b>`, esc(b.headline), ''];
  L.push(b.seo
    ? `<b>🔍 검색 성과</b> (GSC ${b.seo.gscDate} 기준 — 집계 ~3일 지연)`
    : '<b>🔍 검색 성과</b> — GSC 데이터 없음');
  for (const l of seoLines(b)) L.push(esc(l));
  if (b.aeo) {
    L.push('', '<b>🤖 AEO 준비도</b> (bee 심사, 기준 7종)');
    for (const l of aeoLines(b)) L.push(esc(l));
  }
  L.push('', `<b>📈 내부 조회수</b>: ${esc(pvLine(b))}`);
  if (b.published.length) {
    L.push('', '<b>📰 오늘 발행</b>');
    for (const p of b.published) L.push(esc(`• ${p.title}${p.writer ? ` (${p.writer})` : ''}`));
  }
  L.push('', '<b>⏭ 다음 액션</b>');
  for (const a of b.actions) L.push(esc(`• ${a}`));
  return [L.join('\n')]; // 단일 청크 (4096자 내)
}

// ── 엔트리포인트 ─────────────────────────────────────────────────────────────
async function main() {
  const b = await buildBriefing();

  const slack = renderSlackBrief(b);
  const telegram = renderTelegramBrief(b);

  if (DRY) {
    console.log(telegram.join('\n'));
    process.exit(0);
  }

  // Slack 은 SALES 봇채널이 아니라 CRW 웹훅(CRW_SLACK_WEBHOOK_URL)으로 발송 (2026-07-06 지시).
  // sendReport 의 slack 레그는 parrot/spider 용 SALES 채널이므로 여기선 비활성(null → skip).
  // discord 는 전송 대상 아님 — null 이면 skip(no_payload). ({embeds: []} 는 400 유발)
  const [slackRes, rest] = await Promise.all([
    sendSlackWebhook(slack),
    sendReport({ slack: null, discord: null, telegram }),
  ]);
  const res = [slackRes, ...rest.filter(r => r.channel !== 'slack')];
  console.log(JSON.stringify(res));
}

main().catch(e => { console.error('[lion-brief] 오류:', e.message); process.exit(1); });
