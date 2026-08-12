/**
 * shorts-curiosity/diversity.mjs — 다양성 가드
 *
 * 배경: 발행 영상들의 훅·CTA·구조가 반복돼 "주제가 비슷하다"는 피드백(2026-07-16).
 * 새 대본의 hook·cta 를 최근 업로드 N건의 hook·cta 와 문자 4-gram Jaccard 로 비교해,
 * 최대 유사도가 임계 이상이면 재생성을 유도한다. 순수·결정론(부수효과는 파일 읽기뿐).
 *
 * 최근 업로드 소스: shorts-curiosity-index.json 에서 status==='uploaded' 를 시간역순으로
 * recentN 건 뽑아 각 slug 의 state/shorts-queue/work/<slug>/script.json 에서 hook·cta 를 읽는다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadIndex } from './lib.mjs';
import { workDir } from '../shorts/lib.mjs';

const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_RECENT_N = 5;

/** CTA 상투어 과다 반복 감지용(가벼운 신호 보강 — hook 이 달라 CTA 만 겹쳐도 원문 4-gram
 *  Jaccard 는 희석되기 쉬움. 실측: fc0f858b6a·b377584402·1d4314f095 는 hook 이 전혀 달라
 *  raw Jaccard 는 낮게 나오지만, b377584402·1d4314f095 는 CTA 문구가 사실상 동일 템플릿). */
const CLICHE_PHRASES = ['소름 돋는', '설마', '구독 눌러', '구독하기', '더 궁금하면'];
const CLICHE_MIN_MATCH = 2;
const CLICHE_PENALTY = 0.15;

function safeLoadConfig() {
  try { return loadConfig(); } catch { return {}; }
}

/** config.pick.diversity(없으면 {}) — 호출측 cfg 우선, 없으면 자체 로드. */
function diversityConfig(cfg) {
  return (cfg || safeLoadConfig())?.pick?.diversity || {};
}

/** 문자 4-gram 집합 생성 (공백 정규화 후) — check-internal-dup.mjs 와 동일 알고리즘. */
function charFourgrams(text) {
  const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
  const grams = new Set();
  for (let i = 0; i <= chars.length - 4; i++) grams.add(chars.slice(i, i + 4).join(''));
  return grams;
}

/** 두 집합의 Jaccard 유사도. */
function jaccardSets(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** text 안에 등장하는 CLICHE_PHRASES 개수. */
function countCliches(text) {
  const t = String(text || '');
  let n = 0;
  for (const p of CLICHE_PHRASES) if (t.includes(p)) n++;
  return n;
}

/** hook+cta 합친 비교용 텍스트. */
function hookCtaText(script) {
  return `${script?.hook || ''} ${script?.cta || ''}`.trim();
}

/** 최근 업로드 recentN 건의 { id, slug, subject, text } 목록(시간역순, script.json 없으면 skip). */
function recentUploadedTexts(recentN) {
  const index = loadIndex();
  const uploaded = Object.entries(index)
    .filter(([, v]) => v.status === 'uploaded' && v.slug)
    .sort((a, b) => new Date(b[1].at || 0) - new Date(a[1].at || 0))
    .slice(0, recentN);

  const out = [];
  for (const [id, v] of uploaded) {
    const scriptPath = join(workDir(v.slug), 'script.json');
    if (!existsSync(scriptPath)) continue;
    let s;
    try { s = JSON.parse(readFileSync(scriptPath, 'utf8')); } catch { continue; }
    const text = hookCtaText(s);
    if (text) out.push({ id, slug: v.slug, subject: v.subject, text });
  }
  return out;
}

/**
 * checkDiversity(script, opts) — 새 대본(hook·cta)이 최근 업로드분과 너무 닮았는지 검사.
 *
 * script: script.mjs 산출 스키마 { hook, cta, cards, ... }
 * opts.recentN/opts.threshold: 호출측 오버라이드(없으면 config.pick.diversity, 그것도
 *   없으면 기본값 threshold=0.5·recentN=5). opts.cfg: 이미 로드한 config 재사용(선택).
 *
 * 최근 업로드가 없거나(첫 실행) script 에 hook/cta 가 없으면 항상 통과.
 * 반환: { ok:true, maxSim } | { ok:false, reason, maxSim, against }
 */
export function checkDiversity(script, { recentN, threshold, cfg } = {}) {
  const dcfg = diversityConfig(cfg);
  const N = recentN ?? dcfg.recentN ?? DEFAULT_RECENT_N;
  const TH = threshold ?? dcfg.threshold ?? DEFAULT_THRESHOLD;

  const candidateText = hookCtaText(script);
  const recents = recentUploadedTexts(N);
  if (!candidateText || recents.length === 0) return { ok: true, maxSim: 0 };

  const candidateGrams = charFourgrams(candidateText);
  const candidateCliches = countCliches(candidateText);

  let maxSim = 0, against = null;
  for (const r of recents) {
    let sim = jaccardSets(candidateGrams, charFourgrams(r.text));
    // CTA 상투어가 양쪽 다 CLICHE_MIN_MATCH개 이상 겹치면 소폭 가산 — hook 이 달라 raw
    // Jaccard 가 희석되는 경우(같은 CTA 템플릿 재탕)를 보강 감지한다(과설계 방지용 경량 신호).
    if (candidateCliches >= CLICHE_MIN_MATCH && countCliches(r.text) >= CLICHE_MIN_MATCH) {
      sim = Math.min(1, sim + CLICHE_PENALTY);
    }
    if (sim > maxSim) { maxSim = sim; against = { id: r.id, slug: r.slug, subject: r.subject }; }
  }

  const maxSimRounded = parseFloat(maxSim.toFixed(4));
  if (maxSimRounded >= TH) {
    return {
      ok: false,
      reason: `최근 업로드 "${against?.subject || '?'}" 와 hook/cta 유사도 ${maxSimRounded} >= 임계 ${TH}`,
      maxSim: maxSimRounded,
      against,
    };
  }
  return { ok: true, maxSim: maxSimRounded, against };
}
