// apply-evolve.mjs — 진화 적용 프로세스(3권분립의 '적용'담당, elephant 와 분리된 외부 프로세스).
// 채택된 EVOLVE-BLOCK 변종을 대상 작가 .md 에만 기록하고 version 을 올린다.
// 단조성·경계 가드: SEED:locked·frontmatter·감시장치(gates/watchdog/audit/seeds)·
// 게이트 임계 완화·검증자 약화 시도는 무조건 거부(reject). elephant 는 이 파일을 호출만 하고
// 스스로 적용할 수 없다(보상해킹 구조 차단).
//
// 사용: node scripts/evolve/apply-evolve.mjs <agent> <variant-file> [--reason "..."]
//   <variant-file>: EVOLVE-BLOCK 본문(마커 제외) 텍스트 파일
// exit 0=적용, 3=가드거부, 1=오류
import { readFileSync, writeFileSync } from 'node:fs';
import { appendAudit, ACTIONS } from '../audit/append.mjs';

// 이사회(board)도 이 목록을 그대로 쓴다 — 두 곳에 따로 적으면 한쪽만 늘어나 "큐에는 넣었는데
// 적용기가 거부하는" 죽은 편지가 생긴다(2026-08-21 실측: raccoon 을 큐에 넣었으나 처리 불가였다).
export const EVOLVABLE_AGENTS = ['beaver', 'fox', 'wolf', 'cheetah', 'owl', 'magpie', 'eagle', 'bee', 'swan', 'raven'];

// 단조성 트립와이어: 변종 텍스트에 이런 게 보이면 방어선 약화 시도 → 거부
const FORBIDDEN_PATTERNS = [
  /SEED:locked/i,
  /<!--\s*\/?SEED/i,
  /frontmatter|name:\s|tools:\s|model:\s/i,
  /scripts\/(gates|watchdog|audit|seeds)/i,
  /max_jaccard|음절\s*하한|임계.*(완화|내림|낮)/,
  /금지어.*(삭제|제거|줄)/,
  /검증자.*(약화|무력|우회|차단권.*제거)/,
  /게이트.*(우회|비활성|건너|skip)/i,
  /self_evolution.*true/i,
  /service_role|wsl\.exe|sudo/i,
];

function fail(code, msg) { console.error(`[apply-evolve] ${msg}`); process.exit(code); }

function main() {
  const [agent, variantFile] = process.argv.slice(2);
  const reasonIdx = process.argv.indexOf('--reason');
  const reason = reasonIdx > -1 ? process.argv[reasonIdx + 1] : '';
  if (!agent || !variantFile) fail(1, '사용: apply-evolve.mjs <agent> <variant-file>');
  if (!EVOLVABLE_AGENTS.includes(agent)) fail(3, `진화 불가 에이전트: ${agent} (오케스트레이터/거버넌스/감시는 영구 불변)`);

  const variant = readFileSync(variantFile, 'utf8').trim();

  // 가드1: 금지 패턴(방어선 약화/감시장치 침범) 탐지
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(variant)) fail(3, `가드 거부 — 방어선 약화/경계 침범 패턴: ${re}`);
  }
  // 가드2: 변종 안에 다른 EVOLVE/SEED 마커를 새로 심으려는 시도 차단
  if (/EVOLVE-BLOCK:(start|end)/i.test(variant)) fail(3, '가드 거부 — 변종이 마커를 포함');
  // 가드3: 길이 폭주 방지(프롬프트 인젝션성 비대화)
  if (variant.length > 8000) fail(3, '가드 거부 — 변종 과대(>8000자)');

  const mdPath = `.claude/agents/${agent}.md`;
  const md = readFileSync(mdPath, 'utf8');
  const m = md.match(/(<!--\s*EVOLVE-BLOCK:start version=)(\d+)([^>]*-->)([\s\S]*?)(<!--\s*EVOLVE-BLOCK:end\s*-->)/);
  if (!m) fail(1, `${mdPath} 에 EVOLVE-BLOCK 마커 없음`);

  const oldVer = parseInt(m[2], 10);
  const newVer = oldVer + 1;
  const newBlock = `${m[1]}${newVer}${m[3]}\n\n${variant}\n\n${m[5]}`;
  const updated = md.replace(m[0], newBlock);

  // SEED:locked 영역이 그대로 보존됐는지 최종 확인(변경되면 거부)
  const seedBefore = (md.match(/<!--\s*SEED:locked\s*-->([\s\S]*?)<!--\s*\/SEED:locked\s*-->/) || [])[1] || '';
  const seedAfter = (updated.match(/<!--\s*SEED:locked\s*-->([\s\S]*?)<!--\s*\/SEED:locked\s*-->/) || [])[1] || '';
  if (seedBefore !== seedAfter) fail(3, '가드 거부 — SEED:locked 영역 변경 감지');

  writeFileSync(mdPath, updated, 'utf8');
  try {
    appendAudit({ actor: 'evolve-applier', action: ACTIONS.EVOLVE || 'evolve', reason: `${agent} EVOLVE-BLOCK v${oldVer}→v${newVer}: ${reason}` });
  } catch (e) { console.error('[apply-evolve] audit 기록 경고:', e.message); }
  console.log(`[apply-evolve] ✅ ${agent} v${oldVer}→v${newVer} 적용 + 감사기록`);
}

// CLI 로 실행할 때만 동작한다. 가드가 없으면 EVOLVABLE_AGENTS 를 import 하는 쪽에서
// 적용기가 통째로 실행돼 인자 없음으로 종료한다(실측). 목록은 board 도 공유해야 하므로 필요하다.
if (import.meta.url === `file://${process.argv[1]}`) main();
