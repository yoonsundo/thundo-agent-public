/**
 * shorts-curiosity/inventory.mjs — 재고(produced·미업로드) 버퍼 관리 [US-008]
 *
 * 왜 필요한가 (2026-07-25/26 실측):
 * claude -p 가 지속성 장애(구독 사용량 한도 등)로 죽은 이틀간 3개 슬롯(10/12/18 KST)이
 * 전멸해 **업로드 0편 × 2일 연속** 이 발생했다. slot 은 이미 `uploadProducedFallback`
 * (produced 재고 재발행) 경로를 갖고 있었지만 **재고가 0이라 폴백이 아무것도 못 했다**.
 * → 평시에 미리 만들어 둔 영상 버퍼를 유지해, claude 가 죽은 날에도 하루 3편을 채운다.
 *
 * 이 모듈은 "재고 상태 조회 + 부족 판정 + 보충 필요량 산출"과, 실제 보충 제작을
 * **주입된 기존 제작 경로(run-curiosity 의 runDaily)** 로 위임하는 얇은 레이어다.
 * run-curiosity.mjs 는 건드리지 않는다(import 재사용).
 *
 * ⚠ 보충 제작은 반드시 upload.enabled=false 로 강등한 cfg 로 돌린다 —
 *    그렇지 않으면 "버퍼 적재"가 곧바로 업로드되어 일일 상한 3편을 넘긴다.
 */
import { existsSync } from 'node:fs';
import { makeLogger } from '../lib/log.mjs';
import { loadIndex } from './lib.mjs';

const log = makeLogger('curiosity/inventory');

/**
 * 재고 집계와 run-curiosity 폴백은 아래 단일 술어(isUploadableInventory)를 공유한다.
 * 2026-07-16 품질개편 이전 제작분은 재발행하지 않는다(구파이프라인 재업로드 사고 방지).
 */
export const OVERHAUL_CUTOFF = '2026-07-16T00:00:00Z';

/** 목표 재고(편). config.inventory.target 없으면 이 기본값 — 3슬롯 하루치를 통째로 커버. */
export const DEFAULT_INVENTORY_TARGET = 3;
/** 한 슬롯에서 보충 제작할 최대 편수(토큰·비용 가드). */
export const DEFAULT_MAX_REFILL_PER_SLOT = 1;

/**
 * 업로드 가능한 재고 1건의 단일 판정. 제작·파일·품질개편 컷오프뿐 아니라 현재 앵글
 * 운영정책도 적용한다. 특히 whatif_ratio=0은 신규 선정과 재고 폴백 모두에서 하드 중지다.
 */
export function isUploadableInventory(entry, cfg) {
  if (!entry || entry.status !== 'produced' || !entry.video || !existsSync(entry.video)) return false;
  if (String(entry.at || '') < OVERHAUL_CUTOFF) return false;
  const ratio = Number(cfg?.backlog?.angles?.whatif_ratio);
  if (entry.angle === 'whatif' && Number.isFinite(ratio) && ratio <= 0) return false;
  return true;
}

/**
 * 업로드 가능한 재고 항목 목록. 판정은 isUploadableInventory 단일 출처를 쓴다.
 * @param {object} [index] 미지정 시 실제 index 로드
 * @param {object} [cfg] 현재 앵글 정책
 * @returns {Array<{id:string, subject:string, at:string, video:string}>} 오래된 순
 */
export function inventoryItems(index, cfg) {
  const idx = index || loadIndex();
  return Object.entries(idx)
    .filter(([, v]) => isUploadableInventory(v, cfg))
    .sort((a, b) => new Date(a[1].at || 0) - new Date(b[1].at || 0))
    .map(([id, v]) => ({ id, subject: v.subject || id, at: v.at || '', video: v.video, angle: v.angle, domain: v.domain }));
}

/** 업로드 가능한 재고 편수. */
export function inventoryCount(index, cfg) {
  return inventoryItems(index, cfg).length;
}

/** 목표 재고 편수. config 키가 아직 없어도 안전 기본값으로 동작(env 로 임시 조정 가능). */
export function inventoryTarget(cfg) {
  const envN = parseInt(process.env.CURIOSITY_INVENTORY_TARGET, 10);
  if (Number.isFinite(envN) && envN >= 0) return envN;
  const t = cfg?.inventory?.target;
  return Number.isFinite(t) && t >= 0 ? t : DEFAULT_INVENTORY_TARGET;
}

/** 슬롯당 최대 보충 편수. */
export function maxRefillPerSlot(cfg) {
  const envN = parseInt(process.env.CURIOSITY_INVENTORY_MAX_REFILL, 10);
  if (Number.isFinite(envN) && envN >= 0) return envN;
  const m = cfg?.inventory?.max_refill_per_slot;
  return Number.isFinite(m) && m >= 0 ? m : DEFAULT_MAX_REFILL_PER_SLOT;
}

/** 보충 제작 허용 여부. config 미설정이면 허용(기본 ON), env 로 즉시 끌 수 있다. */
export function refillEnabled(cfg) {
  if (process.env.CURIOSITY_INVENTORY_REFILL === '0') return false;
  if (process.env.CURIOSITY_INVENTORY_REFILL === '1') return true;
  const e = cfg?.inventory?.refill_enabled;
  return e === undefined ? true : !!e;
}

/**
 * 재고 부족 판정 — 목표 대비 보충 필요량 산출(제작은 하지 않음, 순수 판정).
 * @param {object} p
 * @param {object} p.cfg   호기심 채널 config
 * @param {object} [p.index] 상태 인덱스(미지정 시 로드)
 * @param {number} [p.reserve] 이번 슬롯이 폴백으로 소비할 예정인 편수(재고에서 미리 차감)
 * @returns {{count:number,target:number,available:number,deficit:number,refillN:number,needsRefill:boolean,enabled:boolean}}
 */
export function assessInventory({ cfg, index, reserve = 0 } = {}) {
  const count = inventoryCount(index, cfg);
  const target = inventoryTarget(cfg);
  const available = Math.max(0, count - Math.max(0, reserve));
  const deficit = Math.max(0, target - available);
  const enabled = refillEnabled(cfg);
  const refillN = enabled ? Math.min(deficit, maxRefillPerSlot(cfg)) : 0;
  return { count, target, available, deficit, refillN, needsRefill: deficit > 0, enabled };
}

/**
 * 재고 보충 제작 — 기존 제작 경로를 재사용해 need 편을 만들고 업로드 없이 재고로 남긴다.
 *
 * @param {object} p
 * @param {object} p.cfg        호기심 채널 config
 * @param {number} p.need       보충할 편수(<=0 이면 no-op)
 * @param {Function} p.produce  제작 함수(기본 주입: run-curiosity 의 runDaily) — `{cfg}` 를 받는다
 * @returns {Promise<{ok:boolean, requested:number, produced:number, skipped?:string, error?:string, result?:object}>}
 */
export async function refillInventory({ cfg, need = 0, produce } = {}) {
  if (!produce) return { ok: false, requested: need, produced: 0, skipped: 'no_producer' };
  if (need <= 0) return { ok: true, requested: 0, produced: 0, skipped: 'not_needed' };
  if (!refillEnabled(cfg)) return { ok: true, requested: need, produced: 0, skipped: 'refill_disabled' };

  // ⚠ 업로드 강제 차단 — 버퍼 적재가 곧 발행이 되어 일일 상한을 넘기는 걸 막는다.
  const bufferCfg = { ...cfg, upload: { ...(cfg?.upload || {}), enabled: false }, pick: { ...(cfg?.pick || {}), best_n: need } };
  log.info(`재고 보충 제작 시작: ${need}편 (업로드 차단 — 버퍼 적재만)`);
  let result;
  try {
    result = await produce({ cfg: bufferCfg });
  } catch (e) {
    // 보충 실패는 발행 슬롯을 죽이지 않는다(재고는 어디까지나 여유분 확보).
    log.warn(`재고 보충 실패(비차단): ${e.message}`);
    return { ok: false, requested: need, produced: 0, error: e.message };
  }
  const produced = countProduced(result);
  log.info(`재고 보충 결과: ${produced}/${need}편`);
  return { ok: produced > 0, requested: need, produced, result };
}

/** runDaily 반환에서 "제작 성공 편수" 세기 — 단일경로/병행(best_n>=2) 두 형태 모두 지원. */
export function countProduced(result) {
  if (!result || typeof result !== 'object') return 0;
  if (Array.isArray(result.produced)) return result.produced.filter(p => p && (p.slug || p.video || p.youtube)).length;
  if (result.ok && (result.slug || result.video || result.youtube)) return 1;
  return 0;
}
