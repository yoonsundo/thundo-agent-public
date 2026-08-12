// log-gate-feedback.mjs — 글의 게이트 결과에서 약점을 뽑아 state/evolve-feedback.jsonl 에 기록.
// 실패 게이트뿐 아니라 "통과했지만 아슬아슬/약한" 지표도 약점으로 남겨, 진화 제안자(elephant)가
// 깜깜이가 아니라 실제 약점 기반으로 개선안을 짜게 한다.
//
// 사용: node scripts/evolve/log-gate-feedback.mjs <draft-or-published.md> <writer>
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
const writerArg = process.argv[3];
if (!file) { console.error('사용: log-gate-feedback.mjs <file.md> [writer]'); process.exit(1); }

function gateJson(f) {
  let out;
  try { out = execFileSync('node', ['scripts/gates/run-all-gates.mjs', f], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const line = out.split('\n').reverse().find(l => l.trim().startsWith('{'));
  return line ? JSON.parse(line) : null;
}

const md = readFileSync(file, 'utf8');
const writer = writerArg || (md.match(/^writer:\s*"?([a-z]+)/m) || [, 'beaver'])[1];
const j = gateJson(file);
if (!j) { console.error('게이트 출력 파싱 실패'); process.exit(2); }
const g = name => (j.gates || []).find(x => x.gate === name)?.evidence || {};
const weaknesses = [];

// 1) 실패 게이트
for (const x of (j.gates || [])) if (!x.pass) weaknesses.push(`FAIL:${x.gate} — ${String(x.reason || '').slice(0, 50)}`);

// 2) 통과했지만 약한 지표(아슬아슬) — 진화가 끌어올릴 여지
const dens = g('density').concrete_sentence_ratio;
if (typeof dens === 'number' && dens < 0.25) weaknesses.push(`WEAK:density 구체문장 ${(dens * 100).toFixed(0)}% (낮음)`);
const nic = g('niche').niche_keyword_ratio;
if (typeof nic === 'number' && nic < 0.55) weaknesses.push(`WEAK:niche 키워드비율 ${(nic * 100).toFixed(0)}% (낮음)`);
const hed = g('hedge').hedge_ratio;
if (typeof hed === 'number' && hed > 0.20) weaknesses.push(`WEAK:hedge 헤징 ${(hed * 100).toFixed(0)}% (높음)`);
const syll = g('length').syllable_count;
if (typeof syll === 'number' && (syll < 1550 || syll > 1950)) weaknesses.push(`WEAK:length ${syll}음절 (경계 근접)`);
const idup = g('internal-dup').max_pair_jaccard;
if (typeof idup === 'number' && idup > 0.085) weaknesses.push(`WEAK:internal-dup 섹션유사 ${idup.toFixed(3)} (높음)`);

if (!weaknesses.length) { console.log('[log-feedback] 약점 없음(견고) — 기록 스킵'); process.exit(0); }
const rec = { ts: new Date().toISOString(), writer, all_pass: !!j.all_pass, weaknesses };
appendFileSync('state/evolve-feedback.jsonl', JSON.stringify(rec) + '\n');
console.log(`[log-feedback] ${writer}: 약점 ${weaknesses.length}건 기록`);
