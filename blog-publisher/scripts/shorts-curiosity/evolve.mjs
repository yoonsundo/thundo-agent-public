#!/usr/bin/env node
/**
 * shorts-curiosity/evolve.mjs — 호기심 채널 자가발전 엔진 (매일 새벽 2시)
 *
 * 목표: 구독자 500. 사람이 매일 못 보니 **이미 올린 영상의 성과로 다음 제작을 스스로 조정**한다.
 *
 * 입력
 *   - state/shorts-curiosity/analytics.jsonl  — {ts, youtube_id, subject, title, published_at, views, likes, comments}
 *     같은 영상이 날짜별로 append(upsert 아님) → 영상별 시계열.
 *   - state/shorts-curiosity-index.json       — 항목별 subject/domain/angle/uploaded_at (youtube_id 매핑)
 *   - state/shorts-backlog/backlog.jsonl      — domain/angle/origin(reddit|llm) 보강
 *   - config/shorts-curiosity.json            — 조정 대상(화이트리스트 3키만)
 *
 * 출력
 *   - config/shorts-curiosity.json            — 원자적 교체(임시파일→rename), 쓰기 전 타임스탬프 백업
 *   - state/shorts-curiosity/config-backup/shorts-curiosity.<ts>.json
 *   - state/shorts-curiosity/evolve-log.jsonl — 변경내역(before/after/근거/표본수/거부목록) append
 *   - state/shorts-curiosity/insights.json    — 성과 인사이트(다음 발굴·대본 프롬프트가 읽어 쓰는 학습 전달물)
 *   - stdout JSON 1줄                          — 다른 스크립트가 파싱하는 요약
 *
 * 계약
 *   - exit 0 = 정상(무변경 포함) / 1 = 실패(쓰기·검증 실패) / 2 = 실행오류(예외)
 *   - 표본 부족(파일 부재·0라인·1일치·영상<10·세그먼트<3·성장신호 없음) → **무변경 + 사유 + exit 0**
 *   - EVOLVE_DRY_RUN=1 → 계산·evolve-log 만, config/insights 미기록
 *   - 네트워크 호출이 전혀 없어(순수 파일 계산) RUN_MODE=mock 에서도 동일 경로로 안전. 단 mock
 *     수집기가 만든 합성 스냅샷은 조회수가 시간에 따라 늘지 않으므로 "성장신호 없음" 가드가
 *     자동으로 무변경 처리한다(합성 데이터로 파라미터를 흔들지 않음).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { paths } from '../lib/config.mjs';
import { configPath, loadConfig, loadIndex, loadBacklog, isMainModule, REPO_ROOT } from './lib.mjs';

const log = makeLogger('curiosity/evolve');

const STATE_DIR = join(paths.state, 'shorts-curiosity');
const ANALYTICS_PATH = join(STATE_DIR, 'analytics.jsonl');
const BACKUP_DIR = join(STATE_DIR, 'config-backup');
const EVOLVE_LOG_PATH = join(STATE_DIR, 'evolve-log.jsonl');
const INSIGHTS_PATH = join(STATE_DIR, 'insights.json');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 급변 방지 상한·표본 하한 — **config 가 아니라 여기 코드 상수로 둔다**.
 * 이유: 자가발전 엔진이 자기 안전장치를 자기 손으로 완화하는 경로(가드 자기무력화)를 원천 차단.
 * 근거(스케일): 일 1편 발행이라 주당 7편·월 30편 → 회당 상대 15%(주 최대 ~2.8배 누적이 아니라
 * 정규화·클램프로 실제론 훨씬 완만) 정도가 "1~2주면 방향이 보이고, 하루 노이즈로는 안 뒤집히는" 폭.
 */
export const CAPS = {
  MIN_VIDEOS: 10,            // 채널 전체 최소 표본(영상 수)
  MIN_SEGMENT: 3,            // 세그먼트(도메인·앵글 등) 최소 표본
  MIN_SNAPSHOT_DAYS: 2,      // 서로 다른 수집 날짜 최소 2일(1일치는 시계열이 아님)
  MIN_GROWING_VIDEOS: 3,     // 조회수가 실제로 증가한 영상 최소 수(정지·합성 데이터 차단)
  MIN_AGE_DAYS: 1,           // 게시 1일 미만은 노이즈 → 비교 제외
  EARLY_WINDOW_DAYS: 7,      // 공정 비교 창: 게시 후 7일 내 스냅샷 우선(누적 편향 제거)
  WEIGHT_REL_STEP: 0.15,     // pick.weights 회당 상대변화 상한 ±15%
  WEIGHT_FLOOR: 0.05,        // 가중치 붕괴 방지 하한
  WEIGHT_CEIL: 0.60,         // 단일 축 독점 방지 상한
  REDDIT_BONUS_STEP: 0.01,   // reddit_bonus 는 가산항이라 절대 스텝(상대 스텝은 0 에서 못 움직임)
  REDDIT_BONUS_RANGE: [0, 0.15],
  WHATIF_STEP_MAX: 0.05,     // whatif_ratio 회당 절대 스텝 상한
  WHATIF_RANGE: [0.10, 0.55],// 완전 소멸(포맷 다양성 상실)·과점 모두 방지
  DOMAIN_MIN: 5,             // 도메인 풀 최소 크기(다양성 유지)
  DOMAIN_MAX: 12,            // 도메인 풀 최대 크기
  DOMAIN_DROP_PERF: 0.6,     // 채널 평균의 60% 미만 도메인만 제거 후보
  SEGMENT_GAP: 1.15,         // 세그먼트 우열 판정 최소 격차(15%) — 미만은 노이즈로 보고 무변경
};

/** 도메인 탐색 풀 — 제거가 생겼거나 기존 도메인이 다 검증됐을 때 1개만 추가(탐색). */
export const CANDIDATE_DOMAINS = ['지리', '경제', '언어', '스포츠', '의학', '교통', '건축', '기상', '법률', '예술'];

/**
 * 조정 화이트리스트 — 정확히 이 3개 키(+ pick.weights 하위 리프)만 허용.
 * upload.enabled / gates.* / tts.* / imagen.* / 크리덴셜 경로는 **시도 자체를 거부**하고
 * 거부 사유를 로그 + evolve-log 에 남긴다.
 */
export const WHITELIST = ['pick.weights', 'backlog.angles.whatif_ratio', 'channel.domains'];
const CORE_WEIGHTS = ['surprise', 'scrollstop', 'relatability', 'freshness'];

export function isAllowedPath(path) {
  const p = String(path || '');
  if (WHITELIST.includes(p)) return true;
  if (p.startsWith('pick.weights.')) {
    const leaf = p.slice('pick.weights.'.length);
    return leaf.length > 0 && !leaf.includes('.');   // pick.weights.<축> 리프만
  }
  return false;
}

// ─── 작은 유틸 ────────────────────────────────────────────────────────────────
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const mean = (arr) => (arr.length ? sum(arr) / arr.length : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r4 = (v) => Math.round(v * 10000) / 10000;

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const k of parts.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─── 1) 성과 집계 ─────────────────────────────────────────────────────────────

export function loadSnapshots(path = ANALYTICS_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(s => s && s.youtube_id && s.ts);
}

/** youtube_id → {id, domain, angle, origin, uploaded_at, subject} (index + backlog 보강). */
export function buildMeta() {
  const idx = loadIndex();
  const backlog = new Map(loadBacklog().map(b => [b.id, b]));
  const meta = new Map();
  for (const [id, v] of Object.entries(idx)) {
    if (!v || !v.youtube_id) continue;
    const b = backlog.get(id) || {};
    meta.set(v.youtube_id, {
      id,
      subject: v.subject || b.subject || '',
      domain: v.domain || b.domain || null,
      angle: v.angle || b.angle || 'reveal',      // angle 미기록 구항목은 reveal(하위호환)
      origin: b.origin || null,
      uploaded_at: v.uploaded_at || v.at || null,
    });
  }
  return meta;
}

function titleBucket(text) {
  const n = String(text || '').replace(/\s+/g, ' ').trim().length;
  if (!n) return null;
  if (n <= 15) return '≤15';
  if (n <= 25) return '16-25';
  if (n <= 40) return '26-40';
  return '41+';
}

function durationBucket(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  if (sec <= 20) return '≤20s';
  if (sec <= 35) return '21-35s';
  if (sec <= 50) return '36-50s';
  return '51s+';
}

/**
 * 영상별 시계열 → 정규화된 성과 지표.
 *
 * ⚠ 공정성: 누적 조회수는 오래된 영상이 무조건 유리해 "옛날 영상이 좋다"는 헛결론을 만든다.
 * 그래서 **게시 후 경과일로 정규화**한다:
 *   - early: 게시 후 EARLY_WINDOW_DAYS 이내 스냅샷이 있으면 그 시점 조회수/경과일(초기 속도)
 *   - lifetime: 없으면(수집 시작 전 게시분) 최신 조회수/전체 경과일(생애 일평균)
 * 둘 다 "하루당 조회수"라 같은 축에서 비교 가능하다.
 */
export function buildVideoStats(snapshots, meta = new Map()) {
  const byId = new Map();
  for (const s of snapshots) {
    if (!byId.has(s.youtube_id)) byId.set(s.youtube_id, []);
    byId.get(s.youtube_id).push(s);
  }
  const videos = [];
  const excluded = [];
  for (const [youtube_id, series] of byId) {
    series.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const latest = series[series.length - 1];
    const first = series[0];
    const m = meta.get(youtube_id) || {};
    const pubIso = latest.published_at || first.published_at || m.uploaded_at || null;
    if (!pubIso || Number.isNaN(Date.parse(pubIso))) { excluded.push({ youtube_id, why: 'no-published-at' }); continue; }
    if (latest.views == null) { excluded.push({ youtube_id, why: 'no-views' }); continue; }
    const pubMs = Date.parse(pubIso);
    const ageDays = (Date.parse(latest.ts) - pubMs) / DAY_MS;
    if (!(ageDays >= CAPS.MIN_AGE_DAYS)) { excluded.push({ youtube_id, why: 'too-young' }); continue; }

    // 초기 창 스냅샷(게시 후 1~7일)
    const early = series.filter(s => {
      const age = (Date.parse(s.ts) - pubMs) / DAY_MS;
      return age >= CAPS.MIN_AGE_DAYS && age <= CAPS.EARLY_WINDOW_DAYS && s.views != null;
    }).pop();
    const norm = early ? 'early' : 'lifetime';
    const refViews = early ? early.views : latest.views;
    const refAge = early ? (Date.parse(early.ts) - pubMs) / DAY_MS : ageDays;
    const vpd = refViews / Math.max(refAge, 1);

    const eng = (latest.likes != null || latest.comments != null)
      ? ((latest.likes || 0) + (latest.comments || 0)) / Math.max(latest.views, 1)
      : null;

    videos.push({
      youtube_id,
      subject: m.subject || latest.subject || latest.title || youtube_id,
      title: latest.title || m.subject || latest.subject || '',
      domain: m.domain || null,
      angle: m.angle || null,
      origin: m.origin || null,
      published_at: pubIso,
      ageDays: r4(ageDays),
      views: latest.views,
      likes: latest.likes ?? null,
      comments: latest.comments ?? null,
      vpd: r4(vpd),
      normalization: norm,
      engagementRate: eng == null ? null : r4(eng),
      titleBucket: titleBucket(latest.title || m.subject || latest.subject),
      durationBucket: durationBucket(latest.duration_sec ?? latest.durationSec ?? null),
      snapshots: series.length,
      grew: (first.views != null && latest.views != null) ? (latest.views - first.views) > 0 : false,
    });
  }
  videos.sort((a, b) => b.vpd - a.vpd);
  return { videos, excluded };
}

/**
 * 채널 평균 대비 상대 성과(perf) 부여.
 * perf = 0.7·(일평균조회/채널평균) + 0.3·(참여율/채널평균)
 * 구독자 목표이므로 조회(유입)만이 아니라 참여율(공감·전환 대리지표)도 섞는다.
 */
export function scoreVideos(videos) {
  const meanVpd = mean(videos.map(v => v.vpd)) || 0;
  const ers = videos.map(v => v.engagementRate).filter(v => v != null);
  const meanEr = mean(ers);
  for (const v of videos) {
    const vr = meanVpd > 0 ? v.vpd / meanVpd : 1;
    const er = (v.engagementRate != null && meanEr > 0) ? v.engagementRate / meanEr : null;
    v.perf = r4(er == null ? vr : 0.7 * vr + 0.3 * er);
  }
  return { meanVpd: r4(meanVpd), meanEr: meanEr == null ? null : r4(meanEr) };
}

/** keyFn 별 세그먼트 집계 → [{key, n, perf, meanVpd, meanEr}] (표본 많은 순). */
export function segmentStats(videos, keyFn) {
  const groups = new Map();
  for (const v of videos) {
    const k = keyFn(v);
    if (k == null || k === '') continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(v);
  }
  const out = [];
  for (const [key, arr] of groups) {
    const ers = arr.map(v => v.engagementRate).filter(x => x != null);
    out.push({
      key, n: arr.length,
      perf: r4(mean(arr.map(v => v.perf))),
      meanVpd: r4(mean(arr.map(v => v.vpd))),
      meanEr: ers.length ? r4(mean(ers)) : null,
      examples: arr.slice(0, 3).map(v => v.subject),
    });
  }
  out.sort((a, b) => b.perf - a.perf);
  return out;
}

/** 표본 하한을 넘긴 세그먼트만. */
const solid = (segs) => segs.filter(s => s.n >= CAPS.MIN_SEGMENT);

// ─── 2) 파라미터 조정 결정 ────────────────────────────────────────────────────

/**
 * pick.weights 조정: units(축별 -1/0/+1) → 상대 스텝 적용 → 클램프 → **원래 합 보존 정규화**.
 * 불변식: 핵심 4축(surprise·scrollstop·relatability·freshness) 합 = 기존 합(현재 1.0).
 * reddit_bonus 는 scoreAll 에서 가중합이 아니라 가산항으로 쓰이므로 정규화 대상이 아니다(pick.mjs 참고).
 */
export function adjustWeights(w0, units) {
  const coreSum = sum(CORE_WEIGHTS.map(k => Number(w0[k]) || 0));
  const lo = {}, hi = {};
  for (const k of CORE_WEIGHTS) {
    const base = Number(w0[k]) || 0;
    let l = Math.max(CAPS.WEIGHT_FLOOR, base * (1 - CAPS.WEIGHT_REL_STEP));
    let h = Math.min(CAPS.WEIGHT_CEIL, base * (1 + CAPS.WEIGHT_REL_STEP));
    if (l > h) { l = h = base; }
    lo[k] = l; hi[k] = h;
  }
  const cur = {};
  for (const k of CORE_WEIGHTS) {
    const base = Number(w0[k]) || 0;
    cur[k] = clamp(base * (1 + (units[k] || 0) * CAPS.WEIGHT_REL_STEP), lo[k], hi[k]);
  }
  // 합 보존: 잔차를 여유(room) 비례로 재배분. 클램프 구간이 coreSum 을 포함하므로 수렴한다.
  for (let i = 0; i < 8; i++) {
    const resid = coreSum - sum(CORE_WEIGHTS.map(k => cur[k]));
    if (Math.abs(resid) < 1e-12) break;
    const room = {};
    let roomTotal = 0;
    for (const k of CORE_WEIGHTS) {
      room[k] = Math.max(0, resid > 0 ? hi[k] - cur[k] : cur[k] - lo[k]);
      roomTotal += room[k];
    }
    if (roomTotal <= 1e-12) break;
    for (const k of CORE_WEIGHTS) cur[k] += resid * (room[k] / roomTotal);
  }
  // 4자리 반올림 후 잔차(≤2e-4)는 최대 가중치에 흡수 → 합 정확히 보존.
  const out = {};
  for (const k of CORE_WEIGHTS) out[k] = r4(cur[k]);
  const resid = r4(coreSum - sum(CORE_WEIGHTS.map(k => out[k])));
  if (resid !== 0) {
    const big = CORE_WEIGHTS.reduce((a, b) => (out[b] > out[a] ? b : a));
    out[big] = r4(out[big] + resid);
  }
  return out;
}

/**
 * 세그먼트 성과 → 제안(proposals) + 인사이트.
 * 각 제안은 {path, from, to, reason, samples} — 적용은 applyProposals(화이트리스트 가드)가 한다.
 */
export function decide({ cfg, videos, baseline }) {
  const proposals = [];
  const notes = [];

  const byDomain = segmentStats(videos, v => v.domain);
  const byAngle = segmentStats(videos, v => v.angle);
  const byTitleLen = segmentStats(videos, v => v.titleBucket);
  const byDuration = segmentStats(videos, v => v.durationBucket);
  const byOrigin = segmentStats(videos, v => v.origin);

  const domainsSolid = solid(byDomain);
  const angleSolid = solid(byAngle);

  // ── (A) backlog.angles.whatif_ratio — reveal vs whatif 우열 ──────────────
  const reveal = angleSolid.find(s => s.key === 'reveal');
  const whatif = angleSolid.find(s => s.key === 'whatif');
  const curRatio = Number(getPath(cfg, 'backlog.angles.whatif_ratio'));
  if (reveal && whatif && Number.isFinite(curRatio)) {
    if (curRatio === 0) {
      notes.push('whatif_ratio=0(사용자가 끔) — 자동으로 켜지 않음');
    } else {
      const hi = Math.max(reveal.perf, whatif.perf);
      const lo = Math.min(reveal.perf, whatif.perf);
      const ratio = lo > 0 ? hi / lo : Infinity;
      if (ratio >= CAPS.SEGMENT_GAP) {
        // 격차가 클수록 스텝을 키우되 상한은 절대 스텝(WHATIF_STEP_MAX). 2배 격차에서 상한 도달.
        const mag = CAPS.WHATIF_STEP_MAX * clamp((ratio - 1) / 1.0, 0.2, 1);
        const dir = whatif.perf > reveal.perf ? +1 : -1;
        const next = r4(clamp(curRatio + dir * mag, CAPS.WHATIF_RANGE[0], CAPS.WHATIF_RANGE[1]));
        if (next !== r4(curRatio)) {
          proposals.push({
            path: 'backlog.angles.whatif_ratio', from: r4(curRatio), to: next,
            reason: `angle 성과 ${dir > 0 ? 'whatif' : 'reveal'} 우세 (reveal perf=${reveal.perf}/n=${reveal.n}, whatif perf=${whatif.perf}/n=${whatif.n}, 격차 ${r4(ratio)}배)`,
            samples: { reveal: reveal.n, whatif: whatif.n },
          });
        }
      } else {
        notes.push(`angle 격차 ${r4(ratio)}배 < ${CAPS.SEGMENT_GAP} — 노이즈로 보고 whatif_ratio 유지`);
      }
    }
  } else {
    notes.push('angle 세그먼트 표본 부족 — whatif_ratio 유지');
  }

  // ── (B) pick.weights ─────────────────────────────────────────────────────
  const w0 = { ...(cfg.pick?.weights || {}) };
  const units = {};
  const weightReasons = [];

  // B-1 참여 정렬(engagement alignment): 조회 상위군의 참여율이 하위군보다 뚜렷히 낮으면
  //     "훅으로 클릭은 받는데 공감은 못 얻는" 상태 → 구독 전환이 안 된다 → relatability↑ / scrollstop↓.
  //     정렬돼 있으면(상위군 참여율도 높음) 안정성을 위해 가중치를 건드리지 않는다.
  const third = Math.floor(videos.length / 3);
  if (third >= CAPS.MIN_SEGMENT) {
    const top = videos.slice(0, third).map(v => v.engagementRate).filter(x => x != null);
    const bottom = videos.slice(-third).map(v => v.engagementRate).filter(x => x != null);
    const erTop = mean(top), erBottom = mean(bottom);
    if (erTop != null && erBottom != null && erBottom > 0) {
      if (erTop < erBottom * 0.85) {
        units.relatability = (units.relatability || 0) + 1;
        units.scrollstop = (units.scrollstop || 0) - 1;
        weightReasons.push(`조회 상위군 참여율(${r4(erTop)}) < 하위군(${r4(erBottom)}) — 훅만 먹히고 공감 실패 → relatability↑/scrollstop↓`);
      } else {
        notes.push(`참여율 정렬 양호(상위 ${r4(erTop)} vs 하위 ${r4(erBottom)}) — 가중치 축 유지`);
      }
    }
  }

  // B-2 freshness(도메인 회전 가점): 도메인별 성과 편차가 크면 회전보다 강한 도메인 집중이 유리 →
  //     freshness↓. 편차가 작으면(도메인이 성과를 못 가름) 다양성 이득이 커 freshness↑.
  if (domainsSolid.length >= 3) {
    const perfs = domainsSolid.map(s => s.perf);
    const m = mean(perfs);
    const sd = Math.sqrt(mean(perfs.map(p => (p - m) ** 2)));
    const cv = m > 0 ? sd / m : 0;
    if (cv > 0.35) {
      units.freshness = (units.freshness || 0) - 1;
      weightReasons.push(`도메인 성과 편차 큼(CV=${r4(cv)}) — 강한 도메인 집중 → freshness↓`);
    } else if (cv < 0.15) {
      units.freshness = (units.freshness || 0) + 1;
      weightReasons.push(`도메인 성과 편차 작음(CV=${r4(cv)}) — 도메인이 성과를 가르지 않음 → 다양성 확보로 freshness↑`);
    }
  }

  if (weightReasons.length > 0) {
    const next = adjustWeights(w0, units);
    const changed = CORE_WEIGHTS.some(k => r4(Number(w0[k]) || 0) !== next[k]);
    if (changed) {
      proposals.push({
        path: 'pick.weights',
        from: { ...w0 },
        to: { ...w0, ...next },   // reddit_bonus 등 비핵심 키 보존
        reason: weightReasons.join(' / '),
        samples: { videos: videos.length, domains: domainsSolid.length },
      });
    }
  }

  // B-3 reddit_bonus(가산항): reddit 씨앗 vs LLM 오리지널 실성과 비교로 가감.
  const originSolid = solid(byOrigin);
  const rd = originSolid.find(s => s.key === 'reddit');
  const llm = originSolid.find(s => s.key && s.key !== 'reddit');
  if (rd && llm && llm.perf > 0) {
    const ratio = rd.perf / llm.perf;
    const cur = Number(w0.reddit_bonus ?? 0.05);
    let next = cur;
    if (ratio >= CAPS.SEGMENT_GAP) next = cur + CAPS.REDDIT_BONUS_STEP;
    else if (ratio <= 1 / CAPS.SEGMENT_GAP) next = cur - CAPS.REDDIT_BONUS_STEP;
    next = r4(clamp(next, CAPS.REDDIT_BONUS_RANGE[0], CAPS.REDDIT_BONUS_RANGE[1]));
    if (next !== r4(cur)) {
      proposals.push({
        path: 'pick.weights.reddit_bonus', from: r4(cur), to: next,
        reason: `origin 성과 reddit=${rd.perf}(n=${rd.n}) vs ${llm.key}=${llm.perf}(n=${llm.n}) → 가산점 ${next > cur ? '↑' : '↓'}`,
        samples: { reddit: rd.n, [llm.key]: llm.n },
      });
    }
  }

  // ── (C) channel.domains — 제거 1개 / 추가 1개 상한 ────────────────────────
  const curDomains = Array.isArray(cfg.channel?.domains) ? [...cfg.channel.domains] : [];
  if (curDomains.length > 0) {
    let nextDomains = [...curDomains];
    const domainReasons = [];

    const worst = [...domainsSolid].reverse().find(s => curDomains.includes(s.key) && s.perf < CAPS.DOMAIN_DROP_PERF);
    if (worst && nextDomains.length > CAPS.DOMAIN_MIN) {
      nextDomains = nextDomains.filter(d => d !== worst.key);
      domainReasons.push(`'${worst.key}' 제거 — 상대성과 ${worst.perf}(<${CAPS.DOMAIN_DROP_PERF}), 표본 ${worst.n}편`);
    }

    // 추가(탐색)는 ① 제거가 발생했거나 ② 현재 도메인이 모두 표본 하한을 넘겨 검증 완료일 때만.
    const saturated = curDomains.length > 0 && curDomains.every(d => {
      const s = byDomain.find(x => x.key === d);
      return s && s.n >= CAPS.MIN_SEGMENT;
    });
    if ((domainReasons.length > 0 || saturated) && nextDomains.length < CAPS.DOMAIN_MAX) {
      const cand = CANDIDATE_DOMAINS.find(d => !nextDomains.includes(d));
      if (cand) {
        nextDomains.push(cand);
        domainReasons.push(`'${cand}' 추가 — ${domainReasons.length > 0 ? '제거분 보전' : '기존 도메인 전부 검증 완료'} 탐색 슬롯`);
      }
    }

    if (domainReasons.length > 0 && nextDomains.length >= CAPS.DOMAIN_MIN) {
      proposals.push({
        path: 'channel.domains', from: curDomains, to: nextDomains,
        reason: domainReasons.join(' / '),
        samples: Object.fromEntries(domainsSolid.map(s => [s.key, s.n])),
      });
    }
  }

  const insights = buildInsights({ videos, baseline, byDomain, byAngle, byTitleLen, byDuration, byOrigin });
  return { proposals, notes, insights, segments: { byDomain, byAngle, byTitleLen, byDuration, byOrigin } };
}

// ─── 6) 학습 전달물: insights.json ────────────────────────────────────────────

/**
 * 다음 제작(발굴·대본 프롬프트)이 읽어 쓸 구조화 인사이트.
 * guidance 는 프롬프트에 그대로 끼워 넣을 수 있는 한국어 문장 배열이다.
 */
export function buildInsights({ videos, baseline, byDomain, byAngle, byTitleLen, byDuration, byOrigin }) {
  const dom = solid(byDomain);
  const ttl = solid(byTitleLen);
  const ang = solid(byAngle);
  const top = dom.slice(0, 3);
  const weak = [...dom].reverse().filter(s => s.perf < CAPS.DOMAIN_DROP_PERF).slice(0, 3);
  const bestTitle = ttl[0] || null;
  const guidance = [];
  if (top.length) guidance.push(`성과 상위 도메인: ${top.map(s => `${s.key}(${s.perf})`).join(', ')} — 이 계열 소재를 우선 발굴.`);
  if (weak.length) guidance.push(`성과 하위 도메인: ${weak.map(s => `${s.key}(${s.perf})`).join(', ')} — 반복 발굴 자제.`);
  if (bestTitle) guidance.push(`제목 길이 ${bestTitle.key}자 구간이 성과 최고(상대성과 ${bestTitle.perf}) — 제목을 이 길이에 맞춰라.`);
  if (ang.length >= 2) guidance.push(`앵글 성과: ${ang.map(s => `${s.key}=${s.perf}`).join(', ')} — 우세 앵글 비중을 늘려라.`);
  const bestVideos = videos.slice(0, 5).map(v => ({
    subject: v.subject, youtube_id: v.youtube_id, views: v.views,
    views_per_day: v.vpd, engagement_rate: v.engagementRate, domain: v.domain, angle: v.angle,
  }));
  if (bestVideos.length) guidance.push(`최고 성과 사례: ${bestVideos.slice(0, 3).map(v => `"${v.subject}"`).join(', ')} — 훅 구조·소재 결을 참고.`);

  return {
    schema: 'shorts-curiosity/insights/v1',
    generated_at: new Date().toISOString(),
    goal: '구독자 500 — 유입(조회)과 공감(참여율) 동시 최적화',
    sample: {
      videos: videos.length,
      normalization: '게시 후 경과일 정규화(초기 7일 창 우선, 없으면 생애 일평균)',
      note: '상대성과(perf)=채널 평균 1.0 기준. 0.7·일평균조회비 + 0.3·참여율비.',
    },
    baseline,
    top_domains: top,
    weak_domains: weak,
    angles: ang,
    title_length: ttl,
    video_length: solid(byDuration),
    origin: solid(byOrigin),
    top_videos: bestVideos,
    guidance,
  };
}

// ─── 4·5) 적용·백업·원자적 쓰기 ───────────────────────────────────────────────

/**
 * keys 의 값들을 [WEIGHT_FLOOR, WEIGHT_CEIL] 안에서 합=target 이 되도록 맞춘다.
 * 비례 축소 → 클램프 → 잔차를 여유(room) 비례로 재배분(최대 8회). adjustWeights 의 정규화와 동일 규약.
 */
function fitToSum(keys, values, target) {
  const out = { ...values };
  const s = sum(keys.map(k => Number(out[k]) || 0));
  if (s > 0) for (const k of keys) out[k] = (Number(out[k]) || 0) * (target / s);
  else for (const k of keys) out[k] = target / keys.length;
  for (const k of keys) out[k] = clamp(out[k], CAPS.WEIGHT_FLOOR, CAPS.WEIGHT_CEIL);
  for (let i = 0; i < 8; i++) {
    const resid = target - sum(keys.map(k => out[k]));
    if (Math.abs(resid) < 1e-12) break;
    const room = {};
    let roomTotal = 0;
    for (const k of keys) {
      room[k] = Math.max(0, resid > 0 ? CAPS.WEIGHT_CEIL - out[k] : out[k] - CAPS.WEIGHT_FLOOR);
      roomTotal += room[k];
    }
    if (roomTotal <= 1e-12) break;
    for (const k of keys) out[k] += resid * (room[k] / roomTotal);
  }
  return out;
}

/**
 * pick.weights 불변식 강제 — **핵심 4축 합 = 기존 합(1.0)**, 축 소실 없음, 각 축 유한수.
 *
 * 왜 (a) 재정규화인가: 리프 경로(`pick.weights.<축>`)로 한 축만 올리는 건 정당한 수동 개입이고,
 * 그때 나머지 축이 자동으로 비례 축소되는 게 자연스럽다(거부하면 수동 채널이 사실상 무용).
 * 다만 **불변식은 타협하지 않는다** — 명시 지정축(pinned)을 살리면서 자유축으로 합을 맞추고,
 * 지정축 합이 과대해 그게 불가능하면 4축 전체를 비례 정규화해 합 보존을 우선한다.
 * 최종적으로 합 검증에 실패하면 호출부가 가중치 변경 전체를 롤백한다(applyProposals 참고).
 */
export function enforceWeightInvariant(weights, original = {}, coreSum = 1, pinned = new Set()) {
  const w = { ...(weights || {}) };
  const notes = [];
  // 축 소실·비유한 방지: 원본값으로 복원(원본도 없으면 균등 분배값).
  for (const k of CORE_WEIGHTS) {
    if (!Number.isFinite(Number(w[k]))) {
      const fallback = Number.isFinite(Number(original[k])) ? Number(original[k]) : coreSum / CORE_WEIGHTS.length;
      w[k] = fallback;
      notes.push(`${k} 축 소실·비유한 → 복원(${r4(fallback)})`);
    } else {
      w[k] = Number(w[k]);
    }
  }
  const target = (Number.isFinite(coreSum) && coreSum > 0) ? coreSum : 1;
  const pinnedKeys = CORE_WEIGHTS.filter(k => pinned.has(k));
  const freeKeys = CORE_WEIGHTS.filter(k => !pinned.has(k));
  const pinnedSum = sum(pinnedKeys.map(k => w[k]));
  const canPin = freeKeys.length > 0 && (target - pinnedSum) >= freeKeys.length * CAPS.WEIGHT_FLOOR;

  let fitted;
  if (canPin) {
    fitted = { ...w, ...fitToSum(freeKeys, w, target - pinnedSum) };
  } else {
    fitted = fitToSum(CORE_WEIGHTS, w, target);
    if (pinnedKeys.length) notes.push('지정축 합이 과대 — 4축 전체 비례 정규화로 합 보존 우선');
  }

  for (const k of CORE_WEIGHTS) fitted[k] = r4(fitted[k]);
  const resid = r4(target - sum(CORE_WEIGHTS.map(k => fitted[k])));
  if (resid !== 0) {
    // 반올림 잔차(≤2e-4)는 **자유축 중 최대**가 흡수한다 — 지정축에 얹으면 수동 지정값이
    // 0.42→0.4201 처럼 어긋나 "지정한 값이 그대로 안 들어간다"는 배신이 된다.
    const absorbers = (canPin && freeKeys.length) ? freeKeys : CORE_WEIGHTS;
    const big = absorbers.reduce((a, b) => (fitted[b] > fitted[a] ? b : a));
    fitted[big] = r4(fitted[big] + resid);
  }
  const finalSum = sum(CORE_WEIGHTS.map(k => fitted[k]));
  const valid = CORE_WEIGHTS.every(k => Number.isFinite(fitted[k]) && fitted[k] > 0) && Math.abs(finalSum - target) <= 1e-6;
  return { weights: fitted, notes, valid, finalSum: r4(finalSum), target: r4(target) };
}

/** 가중치 축별 허용 범위 — 핵심 4축은 붕괴·독점 방지 밴드, reddit_bonus 는 가산항 밴드. */
function weightAxisRange(axis) {
  if (CORE_WEIGHTS.includes(axis)) return [CAPS.WEIGHT_FLOOR, CAPS.WEIGHT_CEIL];
  if (axis === 'reddit_bonus') return CAPS.REDDIT_BONUS_RANGE;
  return null;   // 알 수 없는 축 = 신설 금지
}

/**
 * 제안을 화이트리스트 가드에 통과시켜 적용. 거부는 이유와 함께 반환(로그·evolve-log 기록용).
 * config 객체는 복제해 다루므로 입력을 변형하지 않는다.
 *
 * 가중치는 값 위생(범위·유한수·축 신설 금지) 통과 후에도 **합 1.0 불변식을 재강제**한다.
 * 자동 경로(decide→adjustWeights)는 이미 합 보존 객체를 주므로 재강제가 no-op 이고,
 * 리프 경로(수동 EVOLVE_EXTRA_PROPOSALS)만 실제로 재정규화된다. 스스로를 고치는 시스템이라
 * 한 번 깨진 weights 는 이후 매일의 선정을 영구 오염시키므로 여기서 반드시 막는다.
 */
export function applyProposals(cfg, proposals) {
  const next = JSON.parse(JSON.stringify(cfg));
  const applied = [];
  const rejected = [];
  const originalWeights = { ...(cfg.pick?.weights || {}) };
  const originalCoreSum = sum(CORE_WEIGHTS.map(k => Number(originalWeights[k]) || 0)) || 1;
  const pinnedAxes = new Set();
  let weightsTouched = false;

  for (const p of proposals) {
    const path = String(p?.path || '');
    if (!isAllowedPath(path)) {
      rejected.push({ path, to: p?.to, why: `화이트리스트 밖 키(허용: ${WHITELIST.join(', ')})` });
      continue;
    }
    const to = p.to;
    // 값 위생 검사 — 타입·범위가 어긋난 제안은 거부(config 파손 방지).
    if (path === 'channel.domains') {
      if (!Array.isArray(to) || to.length < CAPS.DOMAIN_MIN || to.some(d => typeof d !== 'string' || !d.trim())) {
        rejected.push({ path, to, why: `domains 는 비어있지 않은 문자열 ${CAPS.DOMAIN_MIN}개 이상 배열이어야 함` });
        continue;
      }
    } else if (path === 'pick.weights') {
      if (!to || typeof to !== 'object' || Array.isArray(to) || CORE_WEIGHTS.some(k => !Number.isFinite(Number(to[k])))) {
        rejected.push({ path, to, why: 'weights 는 4개 핵심 축이 유한수인 객체여야 함' });
        continue;
      }
      const badAxis = Object.keys(to).find(k => {
        const range = weightAxisRange(k);
        if (!range) return true;                                   // 유령 축 신설 금지
        const v = Number(to[k]);
        return !Number.isFinite(v) || v < range[0] || v > range[1];
      });
      if (badAxis) {
        const range = weightAxisRange(badAxis);
        rejected.push({ path, to, why: range ? `가중치 ${badAxis}=${to[badAxis]} 가 허용 범위 [${range[0]}, ${range[1]}] 밖` : `알 수 없는 가중치 축 '${badAxis}'` });
        continue;
      }
      weightsTouched = true;      // 지정축 없음 → 4축 비례 정규화로 합 보존
    } else if (path.startsWith('pick.weights.')) {
      const axis = path.slice('pick.weights.'.length);
      const range = weightAxisRange(axis);
      const v = Number(to);
      if (!range) {
        rejected.push({ path, to, why: `알 수 없는 가중치 축 '${axis}' — 축 신설 금지(허용: ${[...CORE_WEIGHTS, 'reddit_bonus'].join(', ')})` });
        continue;
      }
      if (!Number.isFinite(v) || v < range[0] || v > range[1]) {
        rejected.push({ path, to, why: `가중치 ${axis} 는 [${range[0]}, ${range[1]}] 범위의 유한수여야 함` });
        continue;
      }
      if (CORE_WEIGHTS.includes(axis)) { pinnedAxes.add(axis); weightsTouched = true; }
      setPath(next, path, v);
      applied.push({ path, from: p.from ?? getPath(cfg, path), to: v, reason: p.reason || '', samples: p.samples || null });
      continue;
    } else if (path === 'backlog.angles.whatif_ratio') {
      const v = Number(to);
      const okRange = v === 0 || (v >= CAPS.WHATIF_RANGE[0] && v <= CAPS.WHATIF_RANGE[1]);   // 0=끔(하위호환)
      if (!Number.isFinite(v) || !okRange) {
        rejected.push({ path, to, why: `whatif_ratio 는 0 또는 [${CAPS.WHATIF_RANGE[0]}, ${CAPS.WHATIF_RANGE[1]}] 범위의 유한수여야 함` });
        continue;
      }
    } else if (!Number.isFinite(Number(to))) {
      rejected.push({ path, to, why: '수치 파라미터가 유한수 아님' });
      continue;
    }
    setPath(next, path, to);
    applied.push({ path, from: p.from ?? getPath(cfg, path), to, reason: p.reason || '', samples: p.samples || null });
  }

  if (weightsTouched) {
    const inv = enforceWeightInvariant(next.pick?.weights, originalWeights, originalCoreSum, pinnedAxes);
    if (!inv.valid) {
      // 불변식을 만족시킬 수 없으면 가중치 변경 전체를 롤백한다(깨진 weights 를 쓰는 것보다 무변경이 낫다).
      if (next.pick) next.pick.weights = { ...originalWeights };
      for (let i = applied.length - 1; i >= 0; i--) {
        if (applied[i].path === 'pick.weights' || applied[i].path.startsWith('pick.weights.')) {
          const a = applied.splice(i, 1)[0];
          rejected.push({ path: a.path, to: a.to, why: `가중치 합 불변식 검증 실패(합=${inv.finalSum}, 목표=${inv.target}) — 가중치 변경 전체 롤백` });
        }
      }
    } else {
      next.pick.weights = { ...next.pick.weights, ...inv.weights };
      // 재정규화로 실제 기록값이 달라졌으면 applied 의 to 를 최종값으로 정정(로그가 거짓이 되지 않게).
      for (const a of applied) {
        if (a.path === 'pick.weights') {
          a.to = { ...next.pick.weights };
        } else if (a.path.startsWith('pick.weights.')) {
          const axis = a.path.slice('pick.weights.'.length);
          if (CORE_WEIGHTS.includes(axis)) a.to = next.pick.weights[axis];
        }
      }
      if (inv.notes.length) {
        for (const a of applied) {
          if (a.path === 'pick.weights' || a.path.startsWith('pick.weights.')) a.reason = `${a.reason} [불변식: ${inv.notes.join('; ')}]`.trim();
        }
      }
    }
  }

  return { next, applied, rejected };
}

/** JSON 원자적 쓰기 — 임시파일 → JSON.parse 왕복검증 → rename. 중간에 죽어도 원본 보존. */
export function writeJsonAtomic(path, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  JSON.parse(text);                       // 직렬화 왕복 검증(순환·NaN 등 차단)
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    JSON.parse(readFileSync(tmp, 'utf8')); // 디스크에 쓰인 내용 재파싱 검증
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 무시 */ }
    throw e;
  }
}

/**
 * 백업은 **자기가 지키는 config 옆**에 둔다.
 * CURIOSITY_CONFIG_OVERRIDE 로 임시 config 를 대상으로 돌릴 때 STATE_DIR_OVERRIDE 를 깜빡하면
 * 백업만 실 state 에 쌓여 운영 이력을 오염시킨다(2026-07-30 실제 발생). 대상이 실 config 일 때만
 * state 아래에 모으고, 오버라이드면 그 config 의 디렉터리에 둔다 — 롤백 시 찾기도 쉽다.
 */
function backupDirFor(cfgPath) {
  const realConfig = join(REPO_ROOT, 'config', 'shorts-curiosity.json');
  return cfgPath === realConfig ? BACKUP_DIR : join(dirname(cfgPath), 'config-backup');
}

function backupConfig(cfgPath) {
  const dir = backupDirFor(cfgPath);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dir, `shorts-curiosity.${ts}.json`);
  copyFileSync(cfgPath, dest);            // 원본 바이트 그대로 보존(포맷 손실 없음)
  return dest;
}

function appendEvolveLog(record) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(EVOLVE_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  return EVOLVE_LOG_PATH;
}

/** 가드 자기검증·수동 오버라이드 채널 — 들어와도 화이트리스트를 반드시 통과해야 한다. */
function extraProposals() {
  const raw = process.env.EVOLVE_EXTRA_PROPOSALS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    log.warn('EVOLVE_EXTRA_PROPOSALS 파싱 실패 — 무시');
    return [];
  }
}

// ─── 3) 표본 부족 가드 ────────────────────────────────────────────────────────

/** 표본이 파라미터를 흔들 자격이 있는지. → {ok} 또는 {ok:false, reason, detail} */
export function sampleGuard({ snapshots, videos }) {
  if (snapshots.length === 0) {
    return { ok: false, reason: 'no-analytics', detail: `${ANALYTICS_PATH} 부재이거나 유효 라인 0 — 수집기(analytics-collect) 대기 중` };
  }
  const days = new Set(snapshots.map(s => String(s.ts).slice(0, 10)));
  if (days.size < CAPS.MIN_SNAPSHOT_DAYS) {
    return { ok: false, reason: 'single-day-snapshots', detail: `수집 날짜 ${days.size}일 < ${CAPS.MIN_SNAPSHOT_DAYS}일 — 시계열 아님` };
  }
  if (videos.length < CAPS.MIN_VIDEOS) {
    return { ok: false, reason: 'too-few-videos', detail: `비교 가능 영상 ${videos.length}편 < ${CAPS.MIN_VIDEOS}편` };
  }
  const growing = videos.filter(v => v.grew).length;
  if (growing < CAPS.MIN_GROWING_VIDEOS) {
    return { ok: false, reason: 'no-growth-signal', detail: `조회 증가 영상 ${growing}편 < ${CAPS.MIN_GROWING_VIDEOS}편 — 정지·합성 스냅샷 의심` };
  }
  return { ok: true, days: days.size, growing };
}

// ─── 메인 ────────────────────────────────────────────────────────────────────

export async function run() {
  const dryRun = process.env.EVOLVE_DRY_RUN === '1';
  const cfgPath = configPath();
  const cfg = loadConfig();
  const extras = extraProposals();

  const snapshots = loadSnapshots();
  const { videos, excluded } = buildVideoStats(snapshots, buildMeta());
  const guard = sampleGuard({ snapshots, videos });

  if (!guard.ok) {
    // 표본 없이 파라미터를 흔드는 건 최악 — 무변경으로 끝낸다(exit 0).
    const rejected = extras.map(p => ({ path: p?.path, to: p?.to, why: `표본 부족(${guard.reason})으로 전부 거부` }));
    log.warn(`무변경: ${guard.detail}`);
    for (const r of rejected) log.warn(`제안 거부: ${r.path} — ${r.why}`);
    const logPath = appendEvolveLog({
      ts: new Date().toISOString(), dry_run: dryRun, changed: false,
      reason: guard.reason, detail: guard.detail,
      samples: { snapshots: snapshots.length, videos: videos.length, excluded: excluded.length },
      applied: [], rejected,
    });
    const out = {
      ok: true, changed: false, dry_run: dryRun, reason: guard.reason, detail: guard.detail,
      videos: videos.length, snapshots: snapshots.length, applied: [], rejected, log: logPath,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return { code: 0, out };
  }

  const baseline = scoreVideos(videos);
  const { proposals, notes, insights, segments } = decide({ cfg, videos, baseline });
  const all = [...proposals, ...extras];
  const { next, applied, rejected } = applyProposals(cfg, all);

  for (const n of notes) log.info(n);
  for (const r of rejected) log.warn(`제안 거부: ${r.path} — ${r.why}`);
  for (const a of applied) log.info(`조정: ${a.path} ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)} (${a.reason})`);

  let backup = null;
  let wrote = false;
  let insightsPath = null;
  if (applied.length > 0 && !dryRun) {
    backup = backupConfig(cfgPath);        // 백업 없이 config 를 쓰지 않는다
    writeJsonAtomic(cfgPath, next);
    wrote = true;
  } else if (applied.length === 0) {
    log.info('조정할 파라미터 없음 — 무변경');
  } else {
    log.info('EVOLVE_DRY_RUN=1 — config 미기록(계산·로그만)');
  }

  if (!dryRun) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeJsonAtomic(INSIGHTS_PATH, insights);
    insightsPath = INSIGHTS_PATH;
  }

  const logPath = appendEvolveLog({
    ts: new Date().toISOString(), dry_run: dryRun, changed: wrote,
    reason: applied.length ? 'adjusted' : 'no-change',
    samples: {
      snapshots: snapshots.length, videos: videos.length, snapshot_days: guard.days,
      growing: guard.growing, excluded: excluded.length,
      segments: {
        domain: segments.byDomain.map(s => [s.key, s.n]),
        angle: segments.byAngle.map(s => [s.key, s.n]),
        title_length: segments.byTitleLen.map(s => [s.key, s.n]),
      },
    },
    baseline, applied, rejected, notes, backup,
  });

  const out = {
    ok: true, changed: wrote, dry_run: dryRun, reason: applied.length ? 'adjusted' : 'no-change',
    videos: videos.length, snapshots: snapshots.length, snapshot_days: guard.days,
    applied: applied.map(a => ({ path: a.path, from: a.from, to: a.to })),
    rejected, backup, insights: insightsPath, log: logPath,
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  return { code: 0, out };
}

if (isMainModule(import.meta.url)) {
  run()
    .then(r => process.exit(r.code))
    .catch(e => {
      // 쓰기·검증 실패는 실패(1), 그 외 예기치 못한 예외는 실행오류(2).
      const isWriteFailure = /ENOSPC|EACCES|EPERM|EROFS|JSON/i.test(String(e && (e.code || e.message)));
      log.error(`자가발전 실패: ${e.message}`);
      process.stdout.write(JSON.stringify({ ok: false, changed: false, reason: e.message }) + '\n');
      process.exit(isWriteFailure ? 1 : 2);
    });
}
