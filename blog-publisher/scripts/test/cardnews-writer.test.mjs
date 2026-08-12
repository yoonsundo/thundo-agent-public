#!/usr/bin/env node
/**
 * cardnews-writer.test.mjs — 이중 생성(클로드·코덱스) 경계 유닛테스트
 *
 * 근거: `.omc/specs/deep-interview-cardnews-dual-generator.md` (2026-07-31 확정)
 *
 * 네트워크·크리덴셜 불필요 — `exec`/`readOut` 주입으로 코덱스 CLI 를 통째로 스텁한다.
 * 여기서 지키는 성질 넷:
 *   ① 슬롯 시각 → 작가 배정이 KST 로 정확하다(자정 '24' 로케일 함정 포함)
 *   ② **종료코드 0 인데 결과가 비어있으면 실패다** — snap 격리로 결과파일이 사라지는 실제 함정
 *   ③ 코덱스 실패 → 클로드 폴백이 일어나고 그 사실이 기록된다
 *   ④ 코덱스 호출은 클로드 예산 원장과 분리돼 있다
 *
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import {
  resolveGenerator, stageUsesCodex, makeWriter, callCodex, classifyCodexFailure,
  codexCallCount, resetCodexCalls, codexTmpPath,
} from '../cardnews/writer.mjs';
import { REPO_ROOT, claudeCallCount, resetClaudeCalls } from '../cardnews/lib.mjs';
import { relative } from 'node:path';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/** KST 기준 시각의 Date (KST = UTC+9). */
const kstAt = (h, m = 0) => new Date(Date.UTC(2026, 7, 3, h - 9, m, 0));

const CFG = {
  generators: {
    enabled: true, default: 'claude',
    by_hour: { 11: 'claude', 19: 'codex' },
    stages: ['script'],
    codex: { bin: 'codex', timeout_ms: 1000, retries: 2 },
  },
};

// ── ① 배정 ───────────────────────────────────────────────────────────────────
console.log('\n[1] 슬롯 시각 → 작가 배정');
{
  eq('11시 KST → claude', resolveGenerator(CFG, kstAt(11)), 'claude');
  eq('19시 KST → codex', resolveGenerator(CFG, kstAt(19)), 'codex');
  eq('11:59 KST 도 여전히 11시 → claude', resolveGenerator(CFG, kstAt(11, 59)), 'claude');
  eq('배정 없는 시각(14시) → default', resolveGenerator(CFG, kstAt(14)), 'claude');

  // 🔴 자정 함정: hour12:false 만 쓰면 로케일에 따라 '24' 가 나와 by_hour 키가 영영 안 맞는다.
  const midnight = resolveGenerator({ generators: { by_hour: { 0: 'codex' }, default: 'claude' } }, kstAt(0));
  eq('자정 KST 는 24 가 아니라 0 으로 읽힌다', midnight, 'codex');

  eq('enabled=false 는 비상 원복 → 항상 claude',
    resolveGenerator({ generators: { ...CFG.generators, enabled: false } }, kstAt(19)), 'claude');
  eq('알 수 없는 작가명은 claude 로 낙하',
    resolveGenerator({ generators: { by_hour: { 19: 'gpt-9' } } }, kstAt(19)), 'claude');
  eq('generators 블록 자체가 없으면 claude', resolveGenerator({}, kstAt(19)), 'claude');

  // UTC 가 전날인 시각에도 KST 로 읽어야 한다(로컬 타임존 의존이면 여기서 깨진다).
  eq('KST 08시(=UTC 전날 23시)도 KST 기준으로 읽는다',
    resolveGenerator({ generators: { by_hour: { 8: 'codex' } } }, kstAt(8)), 'codex');
}

// ── ② 단계 선택 ──────────────────────────────────────────────────────────────
console.log('\n[2] 코덱스에 넘기는 단계');
{
  ok('기본은 script 만', stageUsesCodex({}, 'script') && !stageUsesCodex({}, 'factcheck'));
  ok('stages 배열이 있으면 그대로 존중',
    stageUsesCodex({ generators: { stages: ['script', 'pick'] } }, 'pick'));
  ok('빈 배열이면 아무 단계도 코덱스로 안 간다',
    !stageUsesCodex({ generators: { stages: [] } }, 'script'));
}

// ── ③ 임시파일 경로 — snap 함정 방어 ─────────────────────────────────────────
console.log('\n[3] 결과 임시파일은 반드시 레포 아래');
{
  const p = codexTmpPath(0);
  ok('레포 아래 경로', !relative(REPO_ROOT, p).startsWith('..'), p);
  // stateRoot 가 레포 밖으로 설정된 상황을 흉내낸다 → 레포 안으로 되돌려야 한다.
  const escaped = codexTmpPath(0, { root: '/tmp/somewhere-else' });
  ok('레포 밖 root 를 주면 레포 안으로 되돌린다',
    !relative(REPO_ROOT, escaped).startsWith('..'), escaped);
}

// ── ④ callCodex — 성공/빈결과/한도 ───────────────────────────────────────────
console.log('\n[4] callCodex 경계');
{
  resetCodexCalls();
  const r = callCodex('p', {
    cfg: CFG, exec: () => '', readOut: () => '```json\n{"a":1}\n```',
  });
  eq('성공: 코드펜스 제거된 본문', r, '{"a":1}');
  // 계상은 CLI 래퍼가 아니라 라우팅 지점(makeWriter)의 몫이다 — [7] 참조.
  eq('callCodex 자체는 계상하지 않는다', codexCallCount(), 0);

  // 🔴 실제로 겪은 함정: codex 는 snap 이라 /tmp 에 결과를 못 쓰는데 **종료코드는 0** 이다.
  //    비어있는 결과를 성공으로 받으면 그 뒤 JSON 파싱이 엉뚱한 곳에서 깨진다.
  let threw = null;
  try {
    callCodex('p', { cfg: CFG, retries: 0, exec: () => '', readOut: () => '   ' });
  } catch (e) { threw = e; }
  ok('종료코드 0 + 빈 결과 = 실패로 던진다', Boolean(threw), String(threw));
  ok('진단에 빈 결과 사유가 남는다', /비어있음/.test(threw?.message || '') || /비어있음/.test(threw?.diag?.message || ''),
    threw?.diag?.message);

  // 한도 소진은 재시도를 태우지 않는다 — 지연만 늘고 결과는 같다.
  let calls = 0;
  let limitErr = null;
  try {
    callCodex('p', {
      cfg: CFG, retries: 3,
      exec: () => { calls++; const e = new Error('You have hit your usage limit'); throw e; },
      readOut: () => '',
    });
  } catch (e) { limitErr = e; }
  eq('한도 소진이면 exec 는 1회만', calls, 1);
  eq('진단 kind=usage-limit', limitErr?.diag?.kind, 'usage-limit');

  // 일시 장애는 재시도한다(백오프는 0 으로).
  let tries = 0;
  const rr = callCodex('p', {
    cfg: CFG, retries: 2, retryBaseMs: 0,
    exec: () => { tries++; if (tries < 2) throw new Error('socket timeout'); },
    readOut: () => 'ok-after-retry',
  });
  eq('일시 장애는 재시도해 성공', rr, 'ok-after-retry');
  eq('exec 2회', tries, 2);
}

// ── ⑤ 실패 분류 ──────────────────────────────────────────────────────────────
console.log('\n[5] 실패 분류');
{
  eq('429', classifyCodexFailure({ stderr: 'HTTP 429 too many requests' }).kind, 'usage-limit');
  eq('미로그인', classifyCodexFailure({ stderr: 'not logged in, run codex login' }).kind, 'auth');
  eq('타임아웃', classifyCodexFailure({ message: 'timeout' }).kind, 'transient');
  eq('정체불명', classifyCodexFailure({ message: 'something weird' }).kind, 'unknown');
}

// ── ⑥ makeWriter — 배정과 폴백 ───────────────────────────────────────────────
console.log('\n[6] makeWriter 배정·폴백');
{
  const claudeStub = () => 'CLAUDE-OUT';
  const codexStub = () => 'CODEX-OUT';

  const w1 = makeWriter('script', { cfg: CFG, generator: 'claude', callClaude: claudeStub, callCodexImpl: codexStub });
  eq('클로드 배정 → generator=claude', w1.generator, 'claude');
  eq('클로드 배정 → 클로드가 쓴다', w1.call('p'), 'CLAUDE-OUT');

  const w2 = makeWriter('script', { cfg: CFG, generator: 'codex', callClaude: claudeStub, callCodexImpl: codexStub });
  eq('코덱스 배정 → generator=codex', w2.generator, 'codex');
  eq('코덱스 배정 → 코덱스가 쓴다', w2.call('p'), 'CODEX-OUT');

  // 코덱스 배정이어도 그 단계가 대상이 아니면 클로드가 쓴다.
  const w3 = makeWriter('factcheck', { cfg: CFG, generator: 'codex', callClaude: claudeStub, callCodexImpl: codexStub });
  eq('factcheck 는 코덱스 대상이 아니다', w3.generator, 'claude');
  eq('factcheck 는 클로드가 쓴다', w3.call('p'), 'CLAUDE-OUT');

  // 🔴 사용자 결정: 코덱스가 실패한 날은 클로드가 대신 쓴다("매일 2편"이 문체 다양성보다 우선).
  const fell = [];
  const w4 = makeWriter('script', {
    cfg: CFG, generator: 'codex', callClaude: claudeStub,
    callCodexImpl: () => { const e = new Error('boom'); e.diag = { kind: 'transient' }; throw e; },
    onFallback: (f) => fell.push(f),
  });
  eq('코덱스 실패 → 클로드 결과가 나온다', w4.call('p'), 'CLAUDE-OUT');
  eq('폴백이 정확히 1건 기록', fell.length, 1);
  eq('폴백 기록에 단계', fell[0]?.stage, 'script');
  eq('폴백 기록에 사유', fell[0]?.reason, 'transient');
  eq('폴백해도 generator 는 codex 로 남는다(배정 사실)', w4.generator, 'codex');

  // onFallback 이 던져도 본 경로를 죽이지 않는다.
  const w5 = makeWriter('script', {
    cfg: CFG, generator: 'codex', callClaude: claudeStub,
    callCodexImpl: () => { throw new Error('boom'); },
    onFallback: () => { throw new Error('기록 실패'); },
  });
  eq('폴백 기록이 깨져도 대본은 나온다', w5.call('p'), 'CLAUDE-OUT');
}

// ── ⑦ 예산 분리 ──────────────────────────────────────────────────────────────
console.log('\n[7] 예산 원장 분리');
{
  resetCodexCalls();
  resetClaudeCalls();
  const before = claudeCallCount();
  const w = makeWriter('script', {
    cfg: CFG, generator: 'codex',
    callClaude: () => 'CLAUDE', callCodexImpl: () => 'CODEX',
  });
  w.call('p'); w.call('p');
  eq('코덱스로 라우팅된 호출 2건', codexCallCount(), 2);
  eq('클로드 원장은 건드리지 않는다', claudeCallCount(), before);

  // 🔴 폴백해도 코덱스 시도는 시도로 남는다 — 안 그러면 "코덱스가 몇 번 죽었나"를 못 센다.
  resetCodexCalls();
  const wf = makeWriter('script', {
    cfg: CFG, generator: 'codex',
    callClaude: () => 'CLAUDE', callCodexImpl: () => { throw new Error('죽음'); },
  });
  eq('폴백 결과는 클로드', wf.call('p'), 'CLAUDE');
  eq('그래도 코덱스 시도 1건으로 계상', codexCallCount(), 1);

  // 클로드 배정이면 코덱스 카운터는 움직이지 않는다.
  resetCodexCalls();
  const wc = makeWriter('script', { cfg: CFG, generator: 'claude', callClaude: () => 'CLAUDE' });
  wc.call('p');
  eq('클로드 배정 → 코덱스 계상 0', codexCallCount(), 0);
}

console.log(`\ncardnews writer(이중 생성): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
