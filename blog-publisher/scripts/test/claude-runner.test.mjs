#!/usr/bin/env node
/**
 * scripts/test/claude-runner.test.mjs — claude 호출 러너 계약테스트
 *
 * 이 러너는 claude CLI 호출의 유일한 초크포인트다(F-05). 여기서 지켜야 할 계약은
 * 성능이나 편의가 아니라 **돈과 발행**이다:
 *   ① 자식 env 에 ANTHROPIC_API_KEY 가 절대 남지 않는다 → 종량제 과금 방지
 *   ② 한도 소진이 확실하면 재시도하지 않는다 → 슬롯을 헛되이 지연시키지 않는다
 *   ③ 일시적 실패는 재시도한다 → 한 번 끊겼다고 그날 발행이 죽지 않는다
 *   ④ 실패는 갈래로 분류돼 진단에 남는다 → "Command failed" 한 줄로 끝나지 않는다
 *
 * 실행: node --test scripts/test/claude-runner.test.mjs   (npm run test:claude-runner)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeClaudeRunner, excerpt, probeClaudeVersion } from '../lib/claude-runner.mjs';

const OK = JSON.stringify({ subtype: 'success', is_error: false, result: 'RESULT' });

/** 기록된 진단을 모으는 러너 — 테스트마다 새로 만든다(상태 공유 금지). */
function makeRunner(overrides = {}) {
  const diags = [];
  const run = makeClaudeRunner({
    source: 'test/callClaude',
    retriesEnvVar: 'TEST_CLAUDE_RETRIES_UNSET',
    actionFor: (kind) => `조치:${kind}`,
    recordFailure: (d) => diags.push(d),
    log: { error() {}, warn() {}, info() {} },
    ...overrides,
  });
  return { run, diags };
}

describe('claude-runner — 과금 계약', () => {
  test('① 자식 env 에서 ANTHROPIC_API_KEY 를 제거한다', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
    try {
      let seenEnv = null;
      const { run } = makeRunner();
      run('p', { exec: (_b, _a, o) => { seenEnv = o.env; return OK; } });
      assert.ok(seenEnv, 'exec 에 env 가 전달되지 않았다');
      assert.equal('ANTHROPIC_API_KEY' in seenEnv, false, '키가 자식 env 에 남아 종량제로 과금된다');
      assert.ok(seenEnv.PATH, 'PATH 까지 지워버리면 claude 를 못 찾는다');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  test('① 전역 process.env 는 건드리지 않는다', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-keep-in-parent';
    try {
      const { run } = makeRunner();
      run('p', { exec: () => OK });
      assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-keep-in-parent',
        '러너가 부모 프로세스의 env 를 오염시켰다');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('claude-runner — 재시도 정책', () => {
  test('② 한도 소진(확실)이면 재시도하지 않는다', () => {
    let calls = 0;
    const { run, diags } = makeRunner();
    assert.throws(() => run('p', {
      retries: 3, retryBaseMs: 0,
      versionProbe: () => ({ ok: true, version: 'v1' }),
      exec: () => { calls++; const e = new Error('Command failed'); e.stderr = 'Claude usage limit reached'; e.status = 1; throw e; },
    }), /usage-limit/);
    assert.equal(calls, 1, `한도인데 ${calls}번 호출했다 — 백오프는 슬롯만 지연시킨다`);
    assert.equal(diags.at(-1).aborted_early, 'usage-limit(확실) — 재시도 생략');
  });

  test('③ 일시적 실패는 재시도하고, 성공하면 그 결과를 돌려준다', () => {
    let calls = 0;
    const { run } = makeRunner();
    const out = run('p', {
      retries: 3, retryBaseMs: 0,
      exec: () => {
        calls++;
        if (calls < 3) { const e = new Error('Command failed'); e.stderr = 'ECONNRESET'; e.status = 1; throw e; }
        return OK;
      },
    });
    assert.equal(out, 'RESULT');
    assert.equal(calls, 3);
  });

  test('③ 재시도를 모두 소진하면 진단을 남기고 throw 한다', () => {
    const { run, diags } = makeRunner();
    assert.throws(() => run('p', {
      retries: 2, retryBaseMs: 0,
      versionProbe: () => ({ ok: true, version: 'v1' }),
      exec: () => { const e = new Error('Command failed'); e.stderr = 'ECONNRESET'; e.status = 1; throw e; },
    }));
    const d = diags.at(-1);
    assert.equal(d.kind, 'network');
    assert.equal(d.attempts, 3, '시도 횟수가 진단에 남아야 사후 추적이 된다');
    assert.equal(d.max_attempts, 3);
  });
});

describe('claude-runner — 응답 처리', () => {
  test('성공 응답에서 코드펜스를 벗긴다', () => {
    const { run } = makeRunner();
    const fenced = JSON.stringify({ subtype: 'success', is_error: false, result: '```json\n{"a":1}\n```' });
    assert.equal(run('p', { exec: () => fenced }), '{"a":1}');
  });

  test('응답 봉투가 실패면 갈래로 분류해 throw 한다', () => {
    const { run, diags } = makeRunner();
    const bad = JSON.stringify({ subtype: 'error_during_execution', is_error: true, result: null });
    assert.throws(() => run('p', {
      retries: 0, versionProbe: () => ({ ok: true, version: 'v1' }), exec: () => bad,
    }));
    assert.ok(diags.at(-1).kind, '④ 갈래 없이 실패하면 사후 추적이 불가능하다');
  });

  test('JSON 이 아니면 파싱 실패로 진단한다', () => {
    const { run, diags } = makeRunner();
    assert.throws(() => run('p', {
      retries: 0, versionProbe: () => ({ ok: true, version: 'v1' }), exec: () => 'not json',
    }));
    assert.match(diags.at(-1).message, /파싱 실패/);
  });
});

describe('claude-runner — 채널 정책 주입', () => {
  test('beforeCall 이 throw 하면 CLI 를 띄우지 않는다 (예산 상한)', () => {
    let called = 0;
    const { run } = makeRunner({ beforeCall: () => { throw new Error('예산 초과'); } });
    assert.throws(() => run('p', { exec: () => { called++; return OK; } }), /예산 초과/);
    assert.equal(called, 0, '상한을 넘겼는데 claude 를 띄웠다 — 예산 가드가 무력하다');
  });

  test('extraDiag 가 진단에 채널 필드를 얹는다', () => {
    const { run, diags } = makeRunner({ extraDiag: (cls) => ({ label: `L:${cls.kind}`, calls_used: 7 }) });
    assert.throws(() => run('p', {
      retries: 0, versionProbe: () => ({ ok: true, version: 'v1' }),
      exec: () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; },
    }));
    assert.equal(diags.at(-1).label, 'L:cli-missing');
    assert.equal(diags.at(-1).calls_used, 7);
  });

  test('source 와 재시도 환경변수가 정책대로 적용된다', () => {
    process.env.TEST_RUNNER_RETRIES = '0';
    try {
      let calls = 0;
      const { run, diags } = makeRunner({ retriesEnvVar: 'TEST_RUNNER_RETRIES' });
      assert.throws(() => run('p', {
        versionProbe: () => ({ ok: true, version: 'v1' }),
        exec: () => { calls++; const e = new Error('Command failed'); e.stderr = 'ECONNRESET'; throw e; },
      }));
      assert.equal(calls, 1, '환경변수의 retries=0 이 무시됐다');
      assert.equal(diags.at(-1).source, 'test/callClaude');
    } finally { delete process.env.TEST_RUNNER_RETRIES; }
  });
});

describe('claude-runner — 보조', () => {
  test('excerpt 는 길면 자르고 전체 길이를 남긴다', () => {
    assert.equal(excerpt('abc', 10), 'abc');
    assert.equal(excerpt('abcdef', 3), 'abc…(총 6자)');
    assert.equal(excerpt(null), '');
  });

  test('probeClaudeVersion 은 실패해도 throw 하지 않는다', () => {
    const r = probeClaudeVersion({ exec: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
  });
});
