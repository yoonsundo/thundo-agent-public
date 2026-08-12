// evolve-cycle.mjs — 자동학습 1사이클(3권분립 오케스트레이션).
//   제안(elephant·LLM) → 채점(scorer·외부) → 회귀게이트(판정) → 적용(apply-evolve·외부 프로세스).
// 한 주체가 채점·판정·적용을 겸하지 않는다. 채택은 fitness 단조 증가일 때만.
// self_evolution.enabled=false 이면 즉시 종료(안전 기본값).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scoreVariant } from './scorer.mjs';
import { scoreValidatorVariant } from './scorer-validator.mjs';
import { loadNiche } from '../writers/llm-writer.mjs';
import { appendAudit, ACTIONS } from '../audit/append.mjs';

import { claudeText } from '../lib/claude-cli.mjs';
const WRITERS = ['beaver', 'fox', 'wolf'];
const VALIDATORS = ['bee']; // 검증자 진화 — 일요일(UTC) 전용 슬롯. fitness=골든셋 판정 정확도 (scorer-validator)
const ADOPT_MARGIN = 1.02; // baseline 대비 +2% 이상이어야 채택
const K = parseInt(process.env.EVOLVE_K || '4', 10); // 변종당 생성·채점 편수(안정성 위해 4)
const VSAMPLE = parseInt(process.env.EVOLVE_VSAMPLE || '10', 10); // 검증자 채점 시 양품 표본 상한(부정 표본은 전수)

function log(m) { console.log(`[evolve-cycle] ${m}`); }

function getEvolveBlock(agent) {
  const md = readFileSync(`.claude/agents/${agent}.md`, 'utf8');
  const m = md.match(/<!--\s*EVOLVE-BLOCK:start version=(\d+)[^>]*-->([\s\S]*?)<!--\s*EVOLVE-BLOCK:end\s*-->/);
  if (!m) throw new Error(`${agent}: EVOLVE-BLOCK 없음`);
  return { version: parseInt(m[1], 10), text: m[2].trim() };
}

function recentFails(writer, n = 10) {
  const p = 'state/evolve-feedback.jsonl';
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(x => x && x.writer === writer).slice(-n)
    .flatMap(x => x.weaknesses || x.fails || []);
}

// 제안: elephant 가 최근 약점을 보고 EVOLVE-BLOCK 에 **작은 단일 개선**만 가한다(보수적 — 채택 확률↑).
// kind='validator' 면 판정 휴리스틱 개선 방향(작성 휴리스틱이 아님)으로 프롬프트를 바꾼다.
async function propose({ writer, current, fails, apiKey, model, kind = 'writer' }) {
  // 약점 빈도 집계 → 가장 잦은 1개를 타깃으로
  const freq = {}; for (const w of fails) { const key = String(w).split('—')[0].trim(); freq[key] = (freq[key] || 0) + 1; }
  const ranked = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  const target = ranked.length ? ranked[0][0] : null;
  const failSummary = fails.length
    ? `최근 실측 약점(빈도순):\n- ${ranked.slice(0, 6).map(([k, n]) => `${k} (${n}회)`).join('\n- ')}`
    : '최근 약점 기록 없음 — 정보밀도(구체수치·경험)·니치 적합도를 살짝 강화하는 방향.';
  const kindDesc = kind === 'validator'
    ? `검증자(${writer})의 EVOLVE-BLOCK 을 개선한 변종 1개를 제안하라. 목표는 판정 정확도다 — 양품(seed)을 pass 시키고 불량을 fail/플래그하는 **판정 휴리스틱** 1~2개만 추가/수정하라. 결정론 게이트가 담당하는 항목(음절 수·H2 개수)을 fail 사유로 쓰는 중복을 줄이는 방향도 좋다.`
    : `작가(${writer})의 EVOLVE-BLOCK 을 개선한 변종 1개를 제안하라.`;
  const prompt = `너는 elephant — 진화 제안자다. ${kindDesc}

[★보수적 개선 원칙 — 반드시 지켜라]
- **한 번에 하나만, 작게 고쳐라.** 전체를 다시 쓰지 마라. 현재 EVOLVE-BLOCK 의 구조·문장 대부분을 그대로 두고, ${target ? `가장 잦은 약점 "${target}" 을 줄이는 ` : ''}**${kind === 'validator' ? '판정' : '작성'} 휴리스틱 1~2개만 추가/수정**하라.
- 추가하는 휴리스틱은 추상론이 아니라 **구체적·실행가능한 지시**여야 한다(예: ${kind === 'validator' ? '"H2 직후 첫 문단이 헤딩 질문에 직접 답하지 않으면 aeo_flags 에 기록하라"' : '"각 섹션에 최소 1개의 숫자·날짜·고유명사를 넣어라"'}).
- 영어·코드·파라미터 위주로 바꾸지 마라(한글 density·niche 가 오히려 내려간다 — 과거 실패 원인).

[절대 금지]
- 게이트 임계·금지어·검증자 권한·SEED·frontmatter·감시장치 언급/약화(언급만 해도 적용 거부).
- ${kind === 'validator' ? 'authority="advisory"·출력 스키마 필드명·차단권 범위 변경 금지.\n- ' : ''}마커(EVOLVE-BLOCK) 포함 금지. 본문 텍스트만.

[현재 EVOLVE-BLOCK — 대부분 보존할 것]
${current}

[개선 신호 — 실측 약점]
${failSummary}

위 현재 본문을 기반으로, 약점 1개를 줄이는 작은 개선만 가한 EVOLVE-BLOCK 본문 전체를 출력하라(설명·코드펜스 금지).`;
  // 구독(Claude Code) claude -p 로 제안 생성 — API 종량제 대체. apiKey 미사용(하위호환).
  const raw = await claudeText({ prompt, model });
  return raw.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
}

async function main() {
  const cfg = JSON.parse(readFileSync('config/pipeline.json', 'utf8'));
  if (!cfg.self_evolution?.enabled) { log('self_evolution.enabled=false — 진화 비활성(안전 기본값). 종료.'); return; }
  // 구독(Claude Code) 사용 — API 키 불필요. apiKey 는 하위호환으로만 전달(미사용).
  const apiKey = process.env.ANTHROPIC_API_KEY || null;
  const model = process.env.EVOLVE_MODEL || 'claude-sonnet-4-6';
  const niche = loadNiche();
  // 대상 선택: EVOLVE_TARGET 명시 > 일요일(UTC)=검증자 슬롯 > 작가 요일 로테이션(발행 작가와 어긋나게 +1)
  const day = new Date().getUTCDay();
  const forced = process.env.EVOLVE_TARGET;
  const isValidator = forced ? VALIDATORS.includes(forced) : day === 0;
  const writer = forced || (isValidator ? VALIDATORS[0] : WRITERS[(day + 1) % WRITERS.length]);
  const kind = isValidator ? 'validator' : 'writer';
  const base = getEvolveBlock(writer);
  log(`대상=${writer}(${kind}) v${base.version}, ${kind === 'validator' ? `양품 표본 상한 VSAMPLE=${VSAMPLE}` : `채점 편수 K=${K}`}`);

  // 1) 제안 (elephant)
  const fails = recentFails(writer);
  let variant;
  try { variant = await propose({ writer, current: base.text, fails, apiKey, model, kind }); }
  catch (e) { log(`제안 실패: ${e.message}`); process.exit(1); }
  if (!variant || variant.length < 200) { log('제안 변종이 비어/짧음 — 스킵'); return; }

  // 2) 채점 (외부 스코어러) — A/B 독립. 작가=생성 fitness / 검증자=골든셋 판정 정확도
  let bs, vs, improved, noRegress;
  if (kind === 'validator') {
    log('채점: baseline (골든셋)...');
    bs = await scoreValidatorVariant({ evolveBlock: base.text, apiKey, sample: VSAMPLE, tag: 'base' });
    log('채점: variant (골든셋)...');
    vs = await scoreValidatorVariant({ evolveBlock: variant, apiKey, sample: VSAMPLE, tag: 'variant' });
    log(`baseline score=${bs.score.toFixed(2)} (TPR=${bs.tpr.toFixed(2)} TNR=${bs.tnr.toFixed(2)}) | variant score=${vs.score.toFixed(2)} (TPR=${vs.tpr.toFixed(2)} TNR=${vs.tnr.toFixed(2)})`);
    // 회귀게이트: 종합 +2% AND seed 오탐 신규 발생 0(TPR 무감소) AND 중복fail 무증가
    improved = vs.score >= bs.score * ADOPT_MARGIN;
    noRegress = vs.tpr >= bs.tpr && vs.dup_rate <= bs.dup_rate;
  } else {
    log('채점: baseline...');
    bs = await scoreVariant({ writer, evolveBlock: base.text, niche, K, apiKey, model, tag: 'base' });
    log('채점: variant...');
    vs = await scoreVariant({ writer, evolveBlock: variant, niche, K, apiKey, model, tag: 'variant' });
    log(`baseline score=${bs.score.toFixed(2)} (pass=${bs.pass_rate}) | variant score=${vs.score.toFixed(2)} (pass=${vs.pass_rate})`);
    // 3) 회귀게이트(판정): 채택 = 종합 +2% AND 어느 차원도 회귀 안 함
    improved = vs.score >= bs.score * ADOPT_MARGIN;
    noRegress = vs.pass_rate >= bs.pass_rate && vs.avg_density >= bs.avg_density * 0.98 && vs.avg_niche >= bs.avg_niche * 0.98;
  }
  const verdict = improved && noRegress ? 'adopt' : 'reject';
  log(`판정: ${verdict} (improved=${improved}, noRegress=${noRegress})`);

  mkdirSync('runs/evolve-tmp', { recursive: true });
  const record = { ts: new Date().toISOString(), writer, version: base.version, verdict, baseline: bs, variant: vs };
  appendFileSync('state/evolve-history.jsonl', JSON.stringify(record) + '\n');
  try { appendAudit({ actor: 'elephant', action: ACTIONS.EVOLVE || 'evolve', reason: `${writer} v${base.version} 진화판정=${verdict} (base ${bs.score.toFixed(1)}→var ${vs.score.toFixed(1)})` }); } catch {}

  // 4) 적용 (외부 프로세스 — elephant 가 직접 못 함)
  if (verdict === 'adopt') {
    const vf = `runs/evolve-tmp/adopt-${writer}.txt`;
    writeFileSync(vf, variant, 'utf8');
    try {
      execFileSync('node', ['scripts/evolve/apply-evolve.mjs', writer, vf, '--reason', `fitness ${bs.score.toFixed(1)}→${vs.score.toFixed(1)}`], { stdio: 'inherit' });
      log(`✅ ${writer} 진화 채택·적용 완료`);
    } catch (e) { log(`적용 프로세스 거부/실패(가드 작동 가능): exit ${e.status}`); }
  } else {
    log(`변종 기각 — 현 버전 유지(단조성: 개선 없으면 채택 안 함)`);
  }
}

main().catch(e => { log(`치명 오류: ${e.message}`); process.exit(1); });
