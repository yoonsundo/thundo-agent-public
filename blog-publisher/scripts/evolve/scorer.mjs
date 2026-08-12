// scorer.mjs — 진화 채점기(3권분립의 '채점'담당). elephant 와 독립.
// 주어진 EVOLVE-BLOCK(역할·휴리스틱) 텍스트로 K편을 실제 생성 → 게이트13 → fitness 측정.
// elephant 는 점수를 산출하지 않는다(자기보고 금지) — 이 외부 채점기 결과만 수신.
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { claudeText } from '../lib/claude-cli.mjs';

const FORMAT = `
[출력 — 정확히 이 마크다운만. 설명·코드펜스 금지]
---
id: "eval"
topic_id: "<주제>"
outline_id: "<주제>-outline"
writer: "WRITER"
slug: "<영문-하이픈>"
title: "<핵심키워드+구체수치>"
char_count: 0
status: "draft"
attempt: 0
source_refs:
  - type: "official_doc"
    title: "<출처-텍스트만>"
  - type: "blog"
    title: "<출처2>"
tags: ["t1","t2","자동화","생산성"]
---

# <제목>
<본문 1500~2000 한글음절, 1인칭 경험·구체수치, 게이트 규칙 준수>`;

async function genOne({ writer, evolveBlock, niche, idx, apiKey, model }) {
  const prompt = `너는 ${writer} 작가다. 아래는 너의 역할·휴리스틱(EVOLVE-BLOCK)이다. 이대로 한국어 글을 실제로 작성하라.\n\n=== 역할/휴리스틱 ===\n${evolveBlock}\n\n=== 니치 ===\n${niche.name} / 독자: ${niche.audience}\n금칙어: 결론적으로, 시사하는 바가 크다, 혁신적/획기적, ~에 있어서, 것으로 보인다. 같은 종결어미 3연속 금지. 1인칭 경험+구체수치 필수. 문단마다 니치 키워드. 본문 URL 금지. 1500~2000 음절.\n주제는 신선하게(서로 안 겹치게, 변형 ${idx}).\n${FORMAT.replace('WRITER', writer)}`;
  // 구독(Claude Code) claude -p 로 생성 — API 종량제 대체. apiKey 는 미사용(하위호환 파라미터).
  const raw = await claudeText({ prompt, model });
  return raw.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
}

function gateScore(file) {
  let out;
  try { out = execFileSync('node', ['scripts/gates/run-all-gates.mjs', file], { encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const line = out.split('\n').reverse().find(l => l.trim().startsWith('{'));
  if (!line) return { all_pass: false, density: 0, niche: 0, hedge: 1, lenFit: 0, fails: ['parse'] };
  const j = JSON.parse(line);
  const g = name => (j.gates || []).find(x => x.gate === name)?.evidence || {};
  const syll = g('length').syllable_count || 0;
  // 길이 적합: 1500~2000 = 1.0, 벗어날수록 선형 감소
  const lenFit = syll >= 1500 && syll <= 2000 ? 1 : Math.max(0, 1 - Math.abs((syll < 1500 ? 1500 : 2000) - syll) / 600);
  return {
    all_pass: !!j.all_pass,
    density: g('density').concrete_sentence_ratio || 0,
    niche: g('niche').niche_keyword_ratio || 0,
    hedge: g('hedge').hedge_ratio || 0,
    lenFit,
    fails: (j.gates || []).filter(x => !x.pass).map(x => x.gate),
  };
}

// 글 1편 연속 품질 점수(0~100). 통과/탈락 0·1 출렁을 줄이려 세부지표 위주 + 작은 통과 보너스.
function quality(r) {
  const hedgePenalty = Math.min((r.hedge || 0) / 0.35, 1); // hedge 낮을수록 좋음
  return 40 * (r.density || 0) + 30 * (r.niche || 0) + 10 * (1 - hedgePenalty) + 10 * (r.lenFit || 0) + (r.all_pass ? 10 : 0);
}

/**
 * EVOLVE-BLOCK 변종의 fitness 측정. K편 생성→연속 품질 평균(안정).
 * @returns {Promise<{score, pass_rate, avg_density, avg_niche, avg_quality, n, fails}>}
 */
export async function scoreVariant({ writer, evolveBlock, niche, K = 4, apiKey, model = 'claude-sonnet-4-6', tag = 'base' }) {
  mkdirSync('runs/evolve-tmp', { recursive: true });
  const results = [];
  for (let i = 0; i < K; i++) {
    let md;
    try { md = await genOne({ writer, evolveBlock, niche, idx: i, apiKey, model }); }
    catch (e) { console.error(`[scorer] 생성 실패(${tag}#${i}): ${e.message}`); results.push({ all_pass: false, density: 0, niche: 0, hedge: 1, lenFit: 0, fails: ['gen'] }); continue; }
    const f = `runs/evolve-tmp/${tag}-${writer}-${i}.draft.md`;
    writeFileSync(f, md, 'utf8');
    results.push(gateScore(f));
  }
  const n = results.length || 1;
  const avg = sel => results.reduce((s, r) => s + (sel(r) || 0), 0) / n;
  const score = avg(quality);            // 연속 품질 평균(주 점수)
  return {
    score,
    pass_rate: results.filter(r => r.all_pass).length / n,
    avg_density: avg(r => r.density), avg_niche: avg(r => r.niche),
    avg_quality: score, n,
    fails: [...new Set(results.flatMap(r => r.fails || []))],   // 어느 게이트가 자주 막혔나(피드백)
  };
}
