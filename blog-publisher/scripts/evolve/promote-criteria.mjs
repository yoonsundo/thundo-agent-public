// promote-criteria.mjs — AEO 기준 candidate→active 승격 게이트 + TTL 만료 강등 (설계 §2.3·§2.4).
// hummingbird(수집)가 제출한 candidate 를, 골든셋 A/B 회귀 검증을 통과했을 때만 active 로 승격한다.
// 3권분립: 제안(hummingbird)↔채점(scorer-validator)↔적용(이 스크립트) — 수집자는 승격 권한 없음.
//
// 사용:
//   node scripts/evolve/promote-criteria.mjs --dry              # candidate 목록·사전조건만 검사 (API 불필요)
//   node scripts/evolve/promote-criteria.mjs                    # candidate 전체 A/B 승격 시도 (ANTHROPIC_API_KEY 필요)
//   node scripts/evolve/promote-criteria.mjs --expire           # TTL 만료 항목 active→candidate 강등 (API 불필요)
//   환경: PROMOTE_SAMPLE(양품 표본 상한, 기본 10)
//
// 안전장치:
//   - 사전조건: benchmark/negative-aeo 앵커 ≥3 없으면 자동 승격 거부 (빈 방어선 방지 — 설계 §2.3)
//   - candidate 는 weight=advisory 만 승격 가능. verdict 승격은 이 스크립트가 하지 않는다(인간 몫, 2단 승격)
//   - 판정: adopt ← fitness(현행+cand) ≥ fitness(현행)×1.02 AND TPR 무감소 (seed 오탐 신규 0)
//   - 만료 강등은 삭제가 아님 — status 만 candidate 로 (이력 보존)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { scoreValidatorVariant } from './scorer-validator.mjs';
import { appendAudit, ACTIONS } from '../audit/append.mjs';

const CRITERIA_PATH = 'config/aeo-criteria.json';
const ANCHOR_DIR = 'benchmark/negative-aeo';
const ADOPT_MARGIN = 1.02;
const SAMPLE = parseInt(process.env.PROMOTE_SAMPLE || '10', 10);

function log(m) { console.log(`[promote-criteria] ${m}`); }
function loadCriteria() { return JSON.parse(readFileSync(CRITERIA_PATH, 'utf8')); }
function saveCriteria(c) { writeFileSync(CRITERIA_PATH, JSON.stringify(c, null, 2) + '\n', 'utf8'); }

function anchorsReady() {
  if (!existsSync(ANCHOR_DIR)) return 0;
  return readdirSync(ANCHOR_DIR).filter(f => f.endsWith('.md')).length;
}

function getBeeEvolveBlock() {
  const md = readFileSync('.claude/agents/bee.md', 'utf8');
  const m = md.match(/<!--\s*EVOLVE-BLOCK:start version=(\d+)[^>]*-->([\s\S]*?)<!--\s*EVOLVE-BLOCK:end\s*-->/);
  if (!m) throw new Error('bee.md EVOLVE-BLOCK 없음');
  return m[2].trim();
}

/** candidate 1개를 active 셋에 임시 편입한 기준셋 사본 */
function withCandidate(criteria, id) {
  const copy = JSON.parse(JSON.stringify(criteria));
  const item = copy.criteria.find(c => c.id === id);
  item.status = 'active';
  return copy;
}

// ── --expire: TTL 만료 강등 ────────────────────────────────────────────────
function expire() {
  const criteria = loadCriteria();
  const today = new Date().toISOString().slice(0, 10);
  const expired = criteria.criteria.filter(c => c.status === 'active' && c.expires_at && c.expires_at < today);
  if (!expired.length) { log(`만료 항목 없음 (active ${criteria.criteria.filter(c => c.status === 'active').length}개 전부 유효)`); return; }
  for (const c of expired) { c.status = 'candidate'; log(`강등: ${c.id} (expires_at=${c.expires_at}) active→candidate — 재검증 통과 시 복귀`); }
  criteria.version += 1;
  criteria.updated_at = new Date().toISOString();
  saveCriteria(criteria);
  try { appendAudit({ actor: 'promote-criteria', action: ACTIONS.EVOLVE || 'evolve', reason: `TTL 만료 강등 ${expired.length}건 (${expired.map(c => c.id).join(',')}) → v${criteria.version}` }); } catch {}
  log(`완료 — v${criteria.version}`);
}

// ── 승격 게이트 ─────────────────────────────────────────────────────────────
async function promote() {
  const criteria = loadCriteria();
  const candidates = criteria.criteria.filter(c => c.status === 'candidate');
  const anchors = anchorsReady();
  log(`candidate ${candidates.length}개, AEO 부정앵커 ${anchors}개`);
  if (!candidates.length) { log('승격 대상 없음. 종료.'); return; }
  if (anchors < 3) { log('사전조건 미충족: AEO 부정앵커 <3 — 자동 승격 거부 (빈 방어선 방지). 인간 확인으로만 승격 가능.'); process.exit(3); }
  const bad = candidates.filter(c => c.weight !== 'advisory');
  if (bad.length) { log(`거부: candidate 에 weight=advisory 아닌 항목 (${bad.map(c => c.id).join(',')}) — verdict 승격은 인간 몫(2단 승격)`); process.exit(3); }

  // 구독(Claude Code) 사용 — API 키 불필요. apiKey 는 하위호환으로만 전달(미사용).
  const apiKey = process.env.ANTHROPIC_API_KEY || null;
  const evolveBlock = getBeeEvolveBlock();

  log(`채점: baseline (현행 active 셋, 표본 상한 ${SAMPLE})...`);
  const bs = await scoreValidatorVariant({ evolveBlock, apiKey, sample: SAMPLE, tag: 'promote-base', criteria });

  const adopted = [], rejected = [];
  for (const cand of candidates) {
    log(`채점: +${cand.id} ...`);
    const vs = await scoreValidatorVariant({ evolveBlock, apiKey, sample: SAMPLE, tag: `promote-${cand.id}`, criteria: withCandidate(criteria, cand.id) });
    const improved = vs.score >= bs.score * ADOPT_MARGIN;
    const noRegress = vs.tpr >= bs.tpr;
    // 만점 특례: baseline 이 만점(90)이면 +2% 가 수학적으로 불가 — 무회귀(동점 이상)면 채택.
    // 근거: 기준 추가는 탐지력 확장이 목적이고, 골든셋이 그 확장을 아직 못 재는 상태에서 무회귀가 확인되면
    // 채택해도 방어선이 내려가지 않는다(단조성 유지). 회귀(감점·오탐)는 여전히 무조건 기각.
    const perfectBase = bs.score >= 90 - 1e-9;
    const verdict = (improved || (perfectBase && vs.score >= bs.score)) && noRegress ? 'adopt' : 'reject';
    log(`  base=${bs.score.toFixed(1)} → +cand=${vs.score.toFixed(1)} (TPR ${bs.tpr.toFixed(2)}→${vs.tpr.toFixed(2)}) → ${verdict}`);
    if (verdict === 'adopt') adopted.push(cand.id); else rejected.push(cand.id);
  }

  if (adopted.length) {
    const fresh = loadCriteria(); // 채점 중 외부 변경 대비 재로드
    const today = new Date().toISOString().slice(0, 10);
    for (const id of adopted) {
      const item = fresh.criteria.find(c => c.id === id && c.status === 'candidate');
      if (!item) { log(`경고: ${id} 재로드 후 candidate 아님 — 스킵`); continue; }
      item.status = 'active';
      item.adopted_at = today;
    }
    fresh.version += 1;
    fresh.updated_at = new Date().toISOString();
    saveCriteria(fresh);
    log(`✅ 승격 ${adopted.length}건 (${adopted.join(',')}) → v${fresh.version}`);
  }
  if (rejected.length) log(`기각 ${rejected.length}건 (${rejected.join(',')}) — candidate 유지`);
  try { appendAudit({ actor: 'promote-criteria', action: ACTIONS.EVOLVE || 'evolve', reason: `기준 승격게이트: adopt=[${adopted.join(',')}] reject=[${rejected.join(',')}] (base ${bs.score.toFixed(1)})` }); } catch {}
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--expire')) { expire(); }
else if (argv.includes('--dry')) {
  const criteria = loadCriteria();
  const byStatus = criteria.criteria.reduce((a, c) => ((a[c.status] = (a[c.status] || 0) + 1), a), {});
  log(`dry OK — v${criteria.version}, 상태별 ${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(', ')}, 앵커 ${anchorsReady()}개 (사전조건 ${anchorsReady() >= 3 ? '충족' : '미충족'})`);
} else {
  promote().catch(e => { log(`치명 오류: ${e.message}`); process.exit(2); });
}
