#!/usr/bin/env node
/**
 * shorts-curiosity/run-curiosity.mjs — 일일 오케 (백로그→선정→검증→JIT제작→큐)
 *
 * 사용: node scripts/shorts-curiosity/run-curiosity.mjs
 *
 * ① 백로그가 부족하면 보충(경량) ② 반전·호기심 강도 best-pick ③ 가벼운 사실확인
 * (ok 아니면 보류하고 다음 후보) ④ 선정 1건만 풀 제작(shorts 엔진) ⑤ 게이트→pending 큐.
 * 토큰 효율: 풀 제작은 선정 1건에만. 계약: stdout JSON. exit 0/1(게이트fail)/2(오류)
 *
 * AC-8(best_n): config.pick.best_n 으로 하루 병행 제작 편수를 정한다(A/B용).
 * best_n=1(기본)은 위 단일 경로와 완전히 동일(회귀 금지). best_n>=2 면 pickTopN 상위
 * 후보를 순차로 factcheck→제작→큐→업로드해 최대 N편을 병행 산출한다(서로 다른 subject로
 * 다양성 확보).
 *
 * NOTE: 성과 피드백은 별도 analytics-collect/self-evolve 경로가 맡는다. 이 오케스트레이터는
 * 수집을 인라인 실행하지 않으며, 수집 불가 시 현재 config 운영정책을 그대로 적용한다.
 */
import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { loadConfig, loadIndex, loadBacklog, pendingBacklog, markStatus, slugify, isMainModule } from './lib.mjs';
import { refillBacklog } from './backlog.mjs';
import { pick, pickTopN, stripJosa, isNearDuplicate, doneSubjects } from './pick.mjs';
import { factCheck, applyCorrection } from './factcheck.mjs';
import { generateScript } from './script.mjs';
import { checkDiversity } from './diversity.mjs';
import { produceFromScript } from '../shorts/produce.mjs';
import { uploadVideo } from '../shorts/upload.mjs';
import { pendingDir, ensureDirs, workDir } from '../shorts/lib.mjs';
import { recordUploadedVideo } from './video-record.mjs';
import { isUploadableInventory } from './inventory.mjs';

import {
  collapse, shortenTitleBody, nounStem, extractKeywords,
} from '../kernel/korean.mjs';
// 기존 소비자를 위해 그대로 재export 한다(이동은 위치만 바꾸는 일이어야 한다).
export { shortenTitleBody, nounStem, extractKeywords };
const log = makeLogger('curiosity/run');

/** angle 별 태그·해시태그. whatif 는 사실 폭로가 아닌 '만약 ~였다면?' 사고실험이라 reveal 앵글의
 *  "#설마진짜" 라벨로 나가면 안 된다(공개 채널 오라벨 방지). buildUploadMeta·재고 폴백 공용. */
function angleLabels(angle, domain) {
  const isWhatIf = angle === 'whatif';
  return {
    tags: (isWhatIf
      ? ['만약에', '가정해보기', '사고실험', '호기심', 'shorts', domain]
      : ['설마진짜', '지식', '호기심', 'shorts', domain]).filter(Boolean),
    hashtags: isWhatIf ? '#만약에 #가정 #호기심 #shorts' : '#설마진짜 #지식 #호기심 #shorts',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-010 팩트체크 정정 게이트 — "사실이지만 숫자가 틀렸다"를 새어나가지 않게 한다.
//
// 2026-07-30 실사고: badger 가 note 에 "제목의 '13억 원'은 자릿수 오류…반드시 수정할 것"을
// 적었는데 verdict=ok 라 그대로 유튜브에 올라갔다. 이제 판정을 세 갈래로 해석한다:
//   ① verdict≠ok            → 보류(기존과 동일)
//   ② ok + 정정 필요 + 정정본 → **정정본으로 subject/reveal 을 대체**해 발행(대본·제목까지 반영)
//   ③ ok + 정정 필요 + 정정 불가 → **보류**(알려진 오류를 내보내지 않는다. 슬롯은 다음 후보·재고·
//      상한완화 경로가 채운다 — 일일 편수(pick.daily_target)는 그대로 유지된다)
// 보류 사유를 `factcheck:` 접두로 유지하는 이유: lib.mjs pendingBacklog 이 factcheck 계열 보류를
// factcheck_fails>=2 에서 재선정 제외한다 → 정정 불가 아이템이 매 슬롯 pick 을 독점하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 팩트체크 결과 1건을 발행/보류 결정으로 변환. 두 경로(단일·best_n>=2)가 공유하는 단일 판정부.
 * @returns { action:'publish'|'hold', item, corrected, reason, note, log }
 */
export function resolveFactcheck(item, fc = {}) {
  if (fc.verdict !== 'ok') {
    return { action: 'hold', reason: `factcheck:${fc.verdict}`, note: fc.note || '', log: `사실확인 ${fc.verdict}` };
  }
  const corr = applyCorrection(item, fc);
  if (!corr.applied) {
    return {
      action: 'hold',
      reason: 'factcheck:correction-unapplicable',
      note: `정정 적용 불가(${corr.reason}) :: ${fc.note || ''}`,
      log: `사실확인 ok 이나 정정 적용 불가(${corr.reason}) — 알려진 오류 발행 방지`,
    };
  }
  return { action: 'publish', item: corr.item, corrected: corr.changed, reason: 'ok', note: fc.note || '', log: 'ok' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 백로그 보충 임계 — 앵글 편중의 실제 원인이었던 "고갈 직전 보충"을 없앤다.
//
// 실측(2026-07-30, 선정점수 42건): reveal 평균 0.816(n=31) vs whatif 0.817(n=11) — 두 앵글
// 점수는 사실상 동일하다. 즉 편중은 앵글 선호가 아니라 **보충 타이밍의 함수**였다. 기존
// 임계가 `Math.min(target_size, 5)` = 잔여 5건 미만이라, 배치(10건) 중 고득점 reveal 이
// 먼저 소진되고 바닥에 whatif 가 농축된 상태로 2~3일을 버텼다(07-27 전부 reveal → 07-28
// 전부 whatif → 07-29 보충 직후 reveal 복귀).
//
// 따라서 임계를 "며칠치 소비분(daily_target × refill_buffer_days)"으로 올려 바닥을 긁지
// 않게 한다. ⚠ 보충은 claude -p 비용이 있으나 소비량이 일정(daily_target 편/일)하므로 보충 **빈도**는
// 임계와 무관하다(배치 10건 ÷ 일일편수 — 2편/일이면 5일에 1회) — 임계는 풀의 수위만 올린다. 매 슬롯 무조건
// 보충 같은 건 하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 보충 임계(잔여 건수). config.backlog.refill_threshold 우선, 없으면 daily_target×버퍼일수. */
export function refillThreshold(cfg = {}) {
  const target = cfg.backlog?.target_size ?? 50;
  const explicit = cfg.backlog?.refill_threshold;
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(target, Math.floor(explicit)));
  const daily = Number.isFinite(cfg.pick?.daily_target) ? cfg.pick.daily_target : 2;
  const days = Number.isFinite(cfg.backlog?.refill_buffer_days) ? cfg.backlog.refill_buffer_days : 4;
  return Math.max(1, Math.min(target, Math.ceil(daily * days)));
}

/** 잔여 후보가 버퍼 미달이면 보충 트리거. */
export function needsRefill(pendingCount, cfg = {}) {
  return Number(pendingCount) < refillThreshold(cfg);
}

/**
 * 보충 판정에 쓸 **실제 소비 가능한** 잔여 후보만 센다.
 *
 * 2026-08-21 실측 결함: whatif_ratio=0(성과 대응 하드 중지) 상태에서 pick 은 whatif 후보를
 * 매 슬롯 채점 전에 버리는데(`후보 제외(whatif 성과 대응 일시중지)` 로그 8월 누계 390건),
 * 보충 트리거는 `pendingBacklog().length` 로 **그 버려질 후보까지 세고 있었다.**
 * 실측 당시 pending 17건 중 6건이 whatif → 소비가능 11건인데 임계(8)는 17과 비교돼
 * 보충이 안 걸렸다. whatif 잔여는 영구히 빠지지 않으므로 pending 은 6 밑으로 못 내려가고,
 * 결과적으로 **소비가능 풀이 2건까지 마르고 나서야** 보충이 돈다.
 *
 * 이것이 7월 감사가 지목한 "고갈 직전 보충 → 바닥 긁기"의 재발이고, 바닥을 긁으면 남은
 * 소수 후보를 도메인 불문 집어가 쏠림이 생긴다(실측: 역사 29%·같은 날 같은 도메인 54%).
 */
export function consumableBacklog(pending = [], cfg = {}) {
  const whatifOff = Number(cfg.backlog?.angles?.whatif_ratio ?? 0) === 0;
  return whatifOff ? pending.filter(item => item?.angle !== 'whatif') : pending;
}


/**
 * 팩트체크 정정 뒤 **다시** 중복 검사한다.
 *
 * 왜 필요한가: 유사도 게이트는 pick 단계에서 **정정 전** 문구로 판정하는데, 팩트체크가 그 뒤에
 * subject 를 고쳐 쓴다. 정정은 사실을 바로잡는 일이라 서로 다르게 적혀 있던 두 후보를 **같은
 * 사실로 수렴시킬 수 있다.** 실제로 그렇게 나갔다(2026-08-21 실측):
 *   백로그: "대포알에 오른팔…쇠손…30년"  /  "총알에 팔…스프링 손…30년"   → 게이트 통과(0.212)
 *   발행:   "대포알에 오른손…철제 의수…40년" / "포탄에 오른팔…철제 의수…40년" → 사실상 동일(0.609)
 * 즉 게이트를 아무리 정교하게 만들어도 **정정 이후를 보지 않으면** 이 경로는 계속 열려 있다.
 *
 * 정정이 없었으면(corrected=false) 이미 pick 단계에서 같은 문구로 검사됐으므로 건너뛴다.
 * @returns {{dup:boolean, against?:string, by?:string}}
 */
export function recheckCorrectedSubject(chosen, { cfg, corrected, index, backlog } = {}) {
  const sim = cfg?.pick?.similarity;
  if (!corrected || !chosen?.subject || !sim || sim.enabled === false) return { dup: false };
  try {
    const done = doneSubjects(index ?? loadIndex(), backlog ?? loadBacklog())
      .filter(s => s && s !== chosen.subject);   // 자기 자신은 제외(이미 기록됐을 수 있다)
    const d = isNearDuplicate(chosen.subject, done, sim);
    return d.dup ? { dup: true, against: d.against, by: d.by } : { dup: false };
  } catch (e) {
    // 재검사 실패가 발행을 막으면 안 된다 — 원래 계약(정정본 발행)으로 떨어진다.
    log.warn(`정정 후 중복 재검사 실패(계속): ${e.message}`);
    return { dup: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-004 업로드 메타 — 제목 40자 컷·역링크·구독 CTA·주제 태그(유입 극대화)
// 테스트: scripts/test/curiosity-upload-meta.test.mjs
// ─────────────────────────────────────────────────────────────────────────────

/** 태그가 8개에 못 미칠 때만 쓰는 보충(채널 공통 검색어 — 조각이 아니라 실제로 쓰이는 말). */
const TAG_PADDING = ['쇼츠', '흥미로운사실', '알쓸신잡', '생활상식', '트리비아', '몰랐던사실'];

/**
 * 유입용 사이트 베이스 URL.
 * 우선순위: CURIOSITY_SITE_BASE_URL > SITE_BASE_URL > 운영 도메인(www.thundo.kr).
 * ⚠ .env 의 SITE_BASE_URL 은 배포 폴링(wait-deploy)용으로 vercel 프리뷰 도메인이 들어있을 수
 *   있다 — 설명란 역링크를 캐노니컬 도메인으로 고정하려면 CURIOSITY_SITE_BASE_URL 을 쓴다.
 */
export function siteBaseUrl() {
  const raw = process.env.CURIOSITY_SITE_BASE_URL || process.env.SITE_BASE_URL || 'https://www.thundo.kr';
  return String(raw).trim().replace(/\/+$/, '');
}



/**
 * 주제 해시태그 1~2개 — 브랜드 해시태그만 붙으면 전 영상이 동일해 신규 노출 진입점이 없다.
 * 해시태그는 공백을 못 쓰므로 고유명사구는 붙여쓴다('마거릿 킨'→'#마거릿킨').
 */
export function topicHashtags(chosen, n = 2) {
  const seen = new Set();
  const out = [];
  for (const k of extractKeywords(`${chosen?.subject || ''} ${chosen?.reveal || ''}`, 8)) {
    if (out.length >= n) break;
    const t = k.replace(/\s+/g, '');
    if (t.length < 2 || t.length > 20 || seen.has(t)) continue;
    seen.add(t); out.push(`#${t}`);
  }
  return out;
}

/**
 * 고정 태그 + 주제 키워드 병합 → 8개 이상 15개 이하(중복·30자 초과 제외).
 * ⚠ 8개 보장을 **조각으로 채우지 않는다** — 진짜 키워드가 부족하면 도메인·채널 공통 태그로
 * 채운다(품질 > 개수). 15개 상한은 upload.mjs 절삭과 같은 값.
 */
export function buildTags(baseTags, chosen, minCount = 8, maxCount = 15) {
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const v = collapse(t);
    if (!v || v.length > 30 || out.length >= maxCount) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key); out.push(v);
  };
  for (const t of baseTags || []) push(t);
  for (const k of extractKeywords(`${chosen.subject || ''} ${chosen.reveal || ''}`, 10)) push(k);
  if (chosen.domain) push(chosen.domain);
  for (const p of TAG_PADDING) { if (out.length >= minCount) break; push(p); }
  return out;
}

/**
 * 업로드 메타(제목·설명·태그).
 * - title: 본문 40자 이내 + ' #shorts'
 * - description: 훅(상단 2줄 노출) → 반전 → thundo.kr 역링크 → 구독 CTA → 해시태그
 * - tags: 고정 라벨 + 주제 고유 키워드 8개 이상
 * ⚠ '설마진짜' 라벨은 reveal 앵글 전용(angleLabels) — whatif 에 붙으면 오라벨(기존 계약).
 *   CTA·역링크 문구도 앵글 중립으로 유지해 whatif 에 '설마 진짜'가 새지 않게 한다.
 */
export function buildUploadMeta(chosen, script, cfg = null) {
  const { tags, hashtags } = angleLabels(chosen.angle, chosen.domain);
  const site = siteBaseUrl();
  // 발행 편수는 config 가 단일 출처다 — 여기 하드코딩하면 편수를 바꿀 때
  // 설명문에 옛 숫자가 남아 시청자에게 지키지 않는 약속이 나간다(2026-08-21 3→2 실측).
  const perDay = Number((cfg ?? loadConfig())?.pick?.daily_target) || 2;
  const description = [
    script?.hook,
    '',
    chosen.reveal,
    '',
    `▶ 더 많은 이야기와 정리글: ${site}`,
    `🔔 매일 ${perDay}편, 몰랐던 이야기가 올라옵니다 — 구독하고 놓치지 마세요!`,
    '',
    // 브랜드 해시태그(고정) + 주제 해시태그(영상별) — 고정만 쓰면 신규 노출 진입점이 없다.
    [hashtags, ...topicHashtags(chosen, 2)].join(' ').trim(),
  ].filter(v => v !== undefined && v !== null).join('\n');
  return {
    title: `${shortenTitleBody(chosen.subject)} #shorts`.slice(0, 100),
    description,
    tags: buildTags(tags, chosen),
  };
}

/**
 * produced 재고의 업로드 메타를 정상 JIT 발행과 같은 계약으로 복원한다.
 * 신규 재고는 제작 시 고정한 upload_meta 를 그대로 쓰고, 구재고는 백로그+script.json 으로
 * 재구성한다. 어느 쪽도 없으면 subject 를 reveal 폴백으로 써서 링크·CTA·풍부한 태그 계약은
 * 지킨다. 재고 경로가 정상 경로보다 빈약해지는 split-brain 방지용 단일 진입점이다.
 */
export function buildProducedUploadMeta(id, entry = {}, backlog = [], script = null, cfg = null) {
  const stored = entry.upload_meta;
  if (stored && typeof stored.title === 'string' && typeof stored.description === 'string' && Array.isArray(stored.tags)) {
    return { title: stored.title, description: stored.description, tags: [...stored.tags] };
  }
  const source = backlog.find(item => item?.id === id) || {};
  const subject = entry.subject || source.subject || id;
  const chosen = {
    ...source,
    ...entry,
    id,
    subject,
    angle: entry.angle || source.angle || 'reveal',
    domain: entry.domain || source.domain || '',
    reveal: entry.reveal || source.reveal || subject,
  };
  const recoveredScript = script || (entry.hook ? { hook: entry.hook } : null);
  // cfg 를 넘겨야 설명문 CTA 편수가 **호출자가 쓰는 설정**을 따른다(안 넘기면 파일 config 로 갈린다).
  return buildUploadMeta(chosen, recoveredScript, cfg);
}

/** 구형 produced 재고 메타 복원에 빠진 원본 필드. 업로드 전 경고와 테스트가 공유한다. */
export function producedMetaRecoveryGaps(id, entry = {}, backlog = [], script = null) {
  const stored = entry.upload_meta;
  if (stored && typeof stored.title === 'string' && typeof stored.description === 'string' && Array.isArray(stored.tags)) return [];
  const source = backlog.find(item => item?.id === id) || {};
  const gaps = [];
  if (!entry.reveal && !source.reveal) gaps.push('reveal');
  if (!script?.hook && !entry.hook) gaps.push('hook');
  return gaps;
}

function readProducedScript(slug) {
  if (!slug) return null;
  const file = join(workDir(slug), 'script.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    log.warn(`재고 script.json 복원 실패(${slug}) — 저장 메타/백로그로 계속: ${e.message}`);
    return null;
  }
}

/** 제작 완료 1건을 pending 큐에 적재하고 업로드(staged)까지 처리. produce()/N-루프 공유. */
async function queueAndUpload(chosen, script, prod, cfg) {
  mkdirSync(pendingDir(), { recursive: true });
  const slug = slugify(chosen.id);
  const queued = join(pendingDir(), `${slug}.mp4`);
  copyFileSync(prod.videoFile, queued);
  const meta = buildUploadMeta(chosen, script);
  markStatus(chosen.id, 'produced', {
    video: queued, subject: chosen.subject, slug, angle: chosen.angle, domain: chosen.domain,
    reveal: chosen.reveal, hook: script?.hook, upload_meta: meta,
  });
  const up = await uploadVideo(queued, meta, cfg);
  if (up.ok) {
    markStatus(chosen.id, 'uploaded', { video: queued, subject: chosen.subject, slug, youtube_id: up.youtubeId, youtube_url: up.youtubeUrl, uploaded_at: new Date().toISOString() });
    log.info(`업로드 완료: ${up.youtubeUrl}`);
    // 홈페이지 /videos 탭 자동반영 — 발행분을 사이트 DB(youtube_videos)에 기록(실패해도 발행은 유지).
    const rec = await recordUploadedVideo({ youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, subject: chosen.subject, title: chosen.subject, domain: chosen.domain });
    if (!rec.ok) log.warn(`영상 DB 기록 실패(발행은 성공): ${rec.error}`);
    return { subject: chosen.subject, slug, youtube: up.youtubeUrl };
  }
  log.info(`업로드 skip: ${up.reason} → pending 보존`);
  return { subject: chosen.subject, slug, video: queued, upload_skipped: up.reason };
}

/**
 * produced(제작·게이트 통과했으나 미업로드) 재고를 오래된 순으로 count편 업로드하는 폴백.
 * 신규 JIT pick 이 팩트체크 가뭄 등으로 빈손(pick:null)일 때 슬롯이 비지 않도록, 이미 만들어
 * 둔 영상을 내보낸다. upload.enabled=false 면 uploadVideo 가 skip → no-op(회귀 없음).
 * 라벨은 항목에 저장된 angle(reveal|whatif)을 존중해 angleLabels 로 안전 발행한다.
 * 현재 whatif_ratio=0이면 과거 whatif 재고도 제외해 성과 대응 하드 중지를 우회하지 않는다.
 */
export async function uploadProducedFallback(cfg, count = 1) {
  if (count <= 0) return [];
  const index = loadIndex();
  const candidates = Object.entries(index)
    .filter(([, v]) => isUploadableInventory(v, cfg))
    .sort((a, b) => new Date(a[1].at || 0) - new Date(b[1].at || 0)); // 오래된 순
  const backlog = loadBacklog();
  const out = [];
  for (const [id, v] of candidates) {
    if (out.length >= count) break;
    const subject = v.subject || id;
    const recoveredScript = readProducedScript(v.slug);
    const recoveryGaps = producedMetaRecoveryGaps(id, v, backlog, recoveredScript);
    if (recoveryGaps.length) {
      // 슬롯 연속성을 위해 안전 메타는 생성하되, 손상된 구형 재고를 정상 복원처럼 숨기지 않는다.
      log.warn(`구형 재고 메타 원본 누락(${id}: ${recoveryGaps.join(',')}) — 안전 폴백으로 계속`);
    }
    const meta = buildProducedUploadMeta(id, v, backlog, recoveredScript, cfg);
    let up;
    try {
      up = await uploadVideo(v.video, meta, cfg);
    } catch (e) {
      // 개별 영상의 일시 오류(네트워크·토큰 등)는 슬롯을 죽이지 말고 다음 재고로.
      log.warn(`재고 폴백 업로드 예외 → 다음 후보: ${subject} (${e.message})`);
      continue;
    }
    if (!up.ok) {
      log.info(`재고 폴백 업로드 skip: ${up.reason}`);
      // skipped=자격·설정 미비(모든 후보 공통) → 중단. 그 외(개별 영상 업로드 실패) → 다음 후보.
      if (up.skipped) break;
      continue;
    }
    markStatus(id, 'uploaded', { video: v.video, subject, slug: v.slug, youtube_id: up.youtubeId, youtube_url: up.youtubeUrl, uploaded_at: new Date().toISOString(), from_inventory: true });
    log.info(`재고 폴백 업로드: ${subject} → ${up.youtubeUrl}`);
    const rec = await recordUploadedVideo({ youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, subject, title: subject, domain: v.domain });
    if (!rec.ok) log.warn(`영상 DB 기록 실패(발행은 성공): ${rec.error}`);
    out.push({ subject, slug: v.slug, youtube: up.youtubeUrl, from_inventory: true });
  }
  return out;
}

export async function runDaily({ cfg } = {}) {
  cfg = cfg || loadConfig();
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
  ensureDirs();

  // ① 백로그 보충(버퍼 미달 시) — 임계는 refillThreshold(며칠치 소비분) 기준.
  //    ⚠ 세는 대상은 "잔여 후보"가 아니라 "이 설정에서 실제로 뽑힐 수 있는 후보"다.
  //    영구 제외되는 앵글을 세면 풀이 마른 걸 못 보고 바닥을 긁는다(consumableBacklog 주석).
  const pendingAll = pendingBacklog();
  const pendingCount = consumableBacklog(pendingAll, cfg).length;
  if (needsRefill(pendingCount, cfg)) {
    const skipped = pendingAll.length - pendingCount;
    log.info(`백로그 버퍼 미달(소비가능 ${pendingCount}${skipped ? `/전체 ${pendingAll.length}` : ''} < 임계 ${refillThreshold(cfg)}) → 보충`);
    try { await refillBacklog({}); } catch (e) { log.warn(`보충 실패(계속): ${e.message}`); }
  }

  const bestN = cfg.pick?.best_n ?? 1;

  // ---- best_n<=1: 기존 단일 경로 (회귀 금지 — 원본과 완전 동일한 로직) ----
  if (bestN <= 1) {
    // ②③ 선정 + 사실확인 (ok 아니면 보류하고 다음, 최대 3회)
    let chosen = null, fc = null, pickReason = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await pick();
      if (!p.pick) { pickReason = p.reason; break; }
      fc = await factCheck(p.pick, { cfg });
      const dec = resolveFactcheck(p.pick, fc);
      if (dec.action === 'publish') {
        if (dec.corrected) {
          log.warn(`팩트체크 정정 반영 → 제목·대본 소스 교체: "${p.pick.subject}" → "${dec.item.subject}"`);
          const re = recheckCorrectedSubject(dec.item, { cfg, corrected: true });
          if (re.dup) {
            log.warn(`정정본이 기존 주제와 같은 소재(${re.by}) → 보류: "${dec.item.subject}" ↔ "${re.against}"`);
            markStatus(p.pick.id, 'held', { reason: 'similar_subject_after_correction', note: `↔ ${re.against}` });
            continue;
          }
        }
        chosen = dec.item; chosen._score = p.score;
        break;
      }
      log.warn(`${dec.log} → 보류: ${p.pick.subject} (${fc.note})`);
      markStatus(p.pick.id, 'held', { reason: dec.reason, note: dec.note, factcheck_fails: (loadIndex()[p.pick.id]?.factcheck_fails || 0) + 1 });
    }
    if (!chosen) {
      // 신규 pick 빈손 → produced 재고 폴백(슬롯이 비지 않게). 재고도 없으면 원래대로 pick:null.
      const fb = await uploadProducedFallback(cfg, 1);
      if (fb.length) return { ok: true, ...fb[0], fallback: 'produced_inventory' };
      return { ok: true, pick: null, reason: pickReason || '사실확인 통과 후보 없음(3회)' };
    }
    log.info(`선정+검증 OK: ${chosen.subject} (점수 ${chosen._score?.toFixed?.(3)})`);

    // ④ JIT 풀 제작
    let { script } = await generateScript(chosen, { cfg });

    // ④-1 다양성 가드 — 최근 업로드분과 hook/cta 가 너무 닮으면 대본만 재생성(최대 2회).
    // 그래도 실패하면 경고만 남기고 그대로 진행(발행 슬롯 공백 방지가 우선 — 차단권 없음).
    const maxRegenerate = 2;
    let diversity = checkDiversity(script, { cfg });
    for (let i = 0; i < maxRegenerate && !diversity.ok; i++) {
      log.warn(`다양성 가드 fail(유사도 ${diversity.maxSim} vs "${diversity.against?.subject}") → 대본 재생성 ${i + 1}/${maxRegenerate}`);
      ({ script } = await generateScript(chosen, { cfg }));
      diversity = checkDiversity(script, { cfg });
    }
    if (!diversity.ok) {
      log.warn(`다양성 가드 재생성 후에도 유사(유사도 ${diversity.maxSim}) → 그대로 진행`);
    }

    const prod = await produceFromScript(script, { cfg });
    if (!prod.ok) {
      markStatus(chosen.id, 'held', { reason: `produce:${prod.stage}`, note: prod.reason });
      return { ok: false, stage: prod.stage, reason: prod.reason, subject: chosen.subject, steps: prod.steps };
    }

    // ⑤ pending 큐 + 상태기록
    mkdirSync(pendingDir(), { recursive: true });
    const slug = slugify(chosen.id);
    const queued = join(pendingDir(), `${slug}.mp4`);
    copyFileSync(prod.videoFile, queued);
    // ⑥ 업로드 (staged — config.upload.enabled 일 때만). angle 별 메타(whatif≠설마진짜).
    const meta = buildUploadMeta(chosen, script);
    markStatus(chosen.id, 'produced', {
      video: queued, subject: chosen.subject, slug, angle: chosen.angle, domain: chosen.domain,
      reveal: chosen.reveal, hook: script?.hook, upload_meta: meta,
    });
    const up = await uploadVideo(queued, meta, cfg);
    if (up.ok) {
      markStatus(chosen.id, 'uploaded', { video: queued, subject: chosen.subject, slug, youtube_id: up.youtubeId, youtube_url: up.youtubeUrl, uploaded_at: new Date().toISOString() });
      log.info(`업로드 완료: ${up.youtubeUrl}`);
      // 홈페이지 /videos 탭 자동반영 — 발행분을 사이트 DB(youtube_videos)에 기록(실패해도 발행은 유지).
      const rec = await recordUploadedVideo({ youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, subject: chosen.subject, title: chosen.subject, domain: chosen.domain });
      if (!rec.ok) log.warn(`영상 DB 기록 실패(발행은 성공): ${rec.error}`);
      return { ok: true, subject: chosen.subject, slug, youtube: up.youtubeUrl, factcheck: fc, steps: prod.steps };
    }
    log.info(`업로드 skip: ${up.reason} → pending 보존`);
    return { ok: true, subject: chosen.subject, slug, video: queued, upload_skipped: up.reason, factcheck: fc, steps: prod.steps };
  }

  // ---- best_n>=2: 병행 제작(AC-8, A/B용) ----
  // pickTopN 은 채점(claude 배치 1콜)을 한 번만 수행 — 넉넉히 N+2건을 받아 순서대로 시도.
  const pool = await pickTopN(bestN + 2);
  if (!pool.picks || pool.picks.length === 0) return { ok: true, pick: null, reason: pool.reason };

  const produced = [];
  const seenIds = new Set();
  for (const cand of pool.picks) {
    if (produced.length >= bestN) break;
    const item = cand.item;
    if (seenIds.has(item.id)) continue;   // 동일 런 내 같은 id 중복 제작 방지
    seenIds.add(item.id);

    // 후보 1건의 예외(대본 LLM JSON 파싱 실패·팩트체크 오류 등)는 배치를 죽이지 않고
    // 이 후보만 보류(held)하고 다음 후보로 넘어간다 — best-N 은 성공 N편까지 계속 시도.
    try {
      const fc = await factCheck(item, { cfg });
      const dec = resolveFactcheck(item, fc);
      if (dec.action !== 'publish') {
        log.warn(`${dec.log} → 보류: ${item.subject} (${fc.note})`);
        markStatus(item.id, 'held', { reason: dec.reason, note: dec.note, factcheck_fails: (loadIndex()[item.id]?.factcheck_fails || 0) + 1 });
        continue;
      }
      const chosen = dec.item;
      if (dec.corrected) {
        log.warn(`팩트체크 정정 반영 → 제목·대본 소스 교체: "${item.subject}" → "${chosen.subject}"`);
        const re = recheckCorrectedSubject(chosen, { cfg, corrected: true });
        if (re.dup) {
          log.warn(`정정본이 기존 주제와 같은 소재(${re.by}) → 보류: "${chosen.subject}" ↔ "${re.against}"`);
          markStatus(item.id, 'held', { reason: 'similar_subject_after_correction', note: `↔ ${re.against}` });
          continue;
        }
      }
      chosen._score = cand.score;
      log.info(`선정+검증 OK: ${chosen.subject} (점수 ${chosen._score?.toFixed?.(3)})`);

      const { script } = await generateScript(chosen, { cfg });
      const prod = await produceFromScript(script, { cfg });
      if (!prod.ok) {
        markStatus(chosen.id, 'held', { reason: `produce:${prod.stage}`, note: prod.reason });
        log.warn(`제작 실패 → 다음 후보: ${chosen.subject} (${prod.stage}: ${prod.reason})`);
        continue;
      }

      const queuedResult = await queueAndUpload(chosen, script, prod, cfg);
      produced.push({ ...queuedResult, factcheck: fc, steps: prod.steps });
    } catch (e) {
      markStatus(item.id, 'held', { reason: 'exception', note: e.message });
      log.warn(`후보 처리 예외 → 다음 후보: ${item.subject} (${e.message})`);
      continue;
    }
  }

  // 신규 제작이 목표(bestN)에 못 미치면 produced 재고로 부족분 폴백(슬롯 공백 방지).
  if (produced.length < bestN) {
    const fb = await uploadProducedFallback(cfg, bestN - produced.length);
    for (const f of fb) produced.push({ ...f, fallback: 'produced_inventory' });
  }
  if (produced.length === 0) {
    return { ok: false, pick: null, reason: '병행 제작 후보 전원 탈락(factcheck/제작 실패)', count: 0 };
  }
  return { ok: true, produced, count: produced.length };
}

async function main() {
  try {
    const r = await runDaily();
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    log.error(`파이프라인 오류: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
