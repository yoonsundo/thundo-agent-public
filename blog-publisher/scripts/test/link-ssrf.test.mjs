#!/usr/bin/env node
/**
 * link-ssrf.test.mjs — 링크 게이트(게이트5)의 SSRF 가드 회귀 테스트.
 *
 * 배경(2026-08-19 감사): 이 게이트는 초안의 링크를 **우리 박스에서** HEAD 요청한다. 초안은 LLM 이
 * 외부 수집물을 보고 쓴 것이라 링크는 신뢰할 수 없는 입력이다. 주소 제한이 없어 127.0.0.1·
 * 169.254.169.254 같은 내부 주소도 조회했고, 상태코드가 evidence 에 남아 내부 서비스 존재 여부가
 * 드러났다(블라인드 SSRF).
 *
 * 네트워크 없이 결정론으로 돌린다 — 차단 대상은 애초에 fetch 하지 않으므로 외부 의존이 없다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = join(ROOT, 'scripts', 'gates', 'check-links.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'link-ssrf-'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
};

/** 링크 1개짜리 초안을 만들어 게이트를 돌리고 그 링크의 판정을 돌려준다. */
function judge(url) {
  const f = join(TMP, `d-${Buffer.from(url).toString('hex').slice(0, 24)}.md`);
  writeFileSync(f, `---\ntitle: SSRF 픽스처\nwriter: beaver\n---\n\n## 섹션\n\n[링크](${url}) 문단이다.\n\n## 섹션2\n\n본문.\n`, 'utf8');
  let out;
  try { out = execFileSync('node', [GATE, f], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; }   // 게이트 fail 은 exit 1 — stdout 은 그대로 나온다
  const line = out.split('\n').find(l => l.startsWith('{'));
  const d = JSON.parse(line);
  const dead = (d.evidence.dead || []).find(x => x.url === url);
  return { blocked: !!(dead && /차단\(SSRF 방어/.test(dead.error || '')), reason: dead?.error || '(차단 아님)' };
}

console.log('\n[1] 루프백·사설망·링크로컬은 요청 전에 차단된다');
for (const u of [
  'http://127.0.0.1:8787/api/timeline',
  'http://localhost:3000/',
  'http://10.0.0.5/',
  'http://172.16.3.4/',
  'http://192.168.0.1/',
  'http://169.254.169.254/latest/meta-data/',
  'http://0.0.0.0/',
]) {
  const r = judge(u);
  ok(`차단: ${u}`, r.blocked, r.reason);
}

console.log('\n[2] 표기 우회(IPv4-mapped IPv6·십진·16진)도 차단된다');
for (const u of ['http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::1]/']) {
  const r = judge(u);
  ok(`차단: ${u}`, r.blocked, r.reason);
}

console.log('\n[3] 내부 호스트명·IPv6 사설대역도 차단된다 (fe80/fc00/`::`·CGNAT — 리뷰 F3)');
// 섹션 제목이 예전엔 "http(s) 외 프로토콜"이었는데 그 케이스가 없었다(extractLinks 가 https? 만
// 뽑아 도달 불가). 제목을 실제 검사 내용과 맞추고 IPv6 대역을 추가한다.
for (const u of ['http://db.internal/', 'http://box.local/', 'http://[::]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://100.64.1.1/']) {
  const r = judge(u);
  ok(`차단: ${u}`, r.blocked, r.reason);
}

console.log(`\n링크 게이트 SSRF 가드: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
