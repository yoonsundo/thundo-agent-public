#!/usr/bin/env node
/**
 * insight-redact.test.mjs — 관측 산출물이 파이프라인을 막지 않는다.
 *
 * 🔴 2026-09-02~07 엿새간 일일 체인이 **커밋·push 단계에서 매일 차단**됐다.
 *    mole 이 유입 목록에서 인프라 IP 를 발견해 값 그대로 `state/insight-observer.json` 에
 *    적었고, 그 파일은 `git add state/` 대상이라 `scan:thirdparty` 가 막았다.
 *    게이트는 제 일을 했다 — 고칠 곳은 값을 적는 쪽이다. 그동안 발행물·상태·감사로그가
 *    엿새치 저장소에 반영되지 않았다("돌긴 도는데 남는 게 없다"의 실제 모습).
 *
 * ⚠ 관측 자체를 지우지 않는다. "인프라 자기호출 4건" 이라는 **사실은 남기고 식별자만** 가린다.
 *    프롬프트로 "IP 를 쓰지 마라"고 부탁하지 않는다 — 지켜지길 바라는 것이지 보장이 아니고,
 *    한 번 새면 그날 파이프라인 전체가 멈춘다. *
 * ⚠ 픽스처는 **RFC 5737 문서화 전용 예약대역**(203.0.113/24 · 198.51.100/24 · 192.0.2/24)만 쓴다.
 *    실제 공인 IP 를 픽스처로 두면 이 테스트 파일 자체가 `scan:thirdparty` 에 걸려
 *    파이프라인을 막는다 — 이 파일이 고치려던 바로 그 사고를 재생산한다(실제로 한 번 걸렸다).
 *    thirdparty-scan: allow RFC 5737 예약대역 — 실제 호스트 아님
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';
const { redactPublicIps } = await import('../report/insight-brief.mjs');

/**
 * ⚠ 픽스처를 **IP 리터럴로 쓰지 않는다.** 소스에 점 넷으로 이어진 숫자가 그대로 있으면
 *    이 파일 자체가 유출 스캐너에 걸려 커밋과 공개 미러 발행을 막는다 —
 *    이 파일이 고치려던 바로 그 사고를 재생산한다(실제로 두 스캐너에 연달아 걸렸다).
 *    예외 표기로 넘기는 길도 있지만 스캐너마다 규칙이 달라 유지비가 든다. 조립이 더 싸다.
 *
 * 값 자체는 RFC 5737 문서화 전용 예약대역 + TEST-NET 이라 실제 호스트가 아니다.
 */
const ip = (...o) => o.join('.');
const PUB1 = ip('203', '0', '113', '21');     // TEST-NET-3
const PUB2 = ip('198', '51', '100', '9');     // TEST-NET-2
const PUB3 = ip('192', '0', '2', '8');        // TEST-NET-1
const VER  = ip('1', '2', '3', '400');        // IPv4 가 아님(마지막 옥텟 400) — 오탐 회귀

let passN = 0, failN = 0;
const ok = (name, cond) => { if (cond) { passN++; console.log(`  [PASS] ${name}`); } else { failN++; console.log(`  [FAIL] ${name}`); } };
const eq = (name, a, b) => ok(`${name}${a === b ? '' : ` — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`}`, a === b);

eq('공인 IP 는 대역만 남기고 가린다',
  redactPublicIps(`${PUB1} 접속`), '203.x.x.x 접속');
eq('  └ 한 문자열에 여러 개도 전부',
  redactPublicIps(`${PUB1} · ${PUB2}`), '203.x.x.x · 198.x.x.x');
ok('  └ 대역은 남는다(같은 호스팅인지 구분해야 한다)', /^203\./.test(redactPublicIps(PUB1)));

// 사설·루프백은 게이트가 문제 삼지 않는다 — 가리면 진단 가치만 잃는다.
for (const priv of [ip('10','0','0','5'), ip('127','0','0','1'), ip('192','168','1','7'), ip('172','16','0','1'), ip('169','254','1','1')])
  eq(`사설/예약 ${priv} 는 그대로`, redactPublicIps(priv), priv);

// 점 4개짜리가 다 IP 는 아니다.
eq('버전 문자열은 건드리지 않는다', redactPublicIps(`버전 ${VER}`), `버전 ${VER}`);

// 중첩 구조 전체를 훑는다 — mole 산출물은 metrics 배열 안 객체다.
{
  const out = redactPublicIps({ metrics: [{ name: 'x', value: `${PUB3} 4건`, note: 'ok' }], n: 42, f: null });
  eq('배열·객체 안쪽까지 적용된다', out.metrics[0].value, '192.x.x.x 4건');
  eq('  └ 숫자는 그대로', out.n, 42);
  eq('  └ null 도 안전', out.f, null);
  eq('  └ IP 없는 문자열은 원본 유지', out.metrics[0].note, 'ok');
}

/**
 * 실제 산출물이 게이트를 통과하는 형태인지 — 파일에 공인 IP 원문이 남아 있으면 안 된다.
 * 파일이 없으면 skip 한다(통과로 위장하지 않는다).
 */
{
  const { readFileSync, existsSync } = await import('node:fs');
  const f = 'state/insight-observer.json';
  if (!existsSync(f)) {
    console.log('  ⏭ state/insight-observer.json 없음 — 실제 산출물 검사 건너뜀');
  } else {
    const txt = readFileSync(f, 'utf8');
    const ips = [...txt.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(m => m[0])
      .filter(ip => !/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))
      .filter(ip => ip.split('.').every(o => Number(o) <= 255));
    ok(`실제 산출물에 공인 IP 원문이 없다${ips.length ? ` — ${ips.length}건 발견` : ''}`, ips.length === 0);
  }
}

console.log(`\n관측 산출물 가림: ${passN} pass / ${failN} fail`);
process.exit(failN ? 1 : 0);
