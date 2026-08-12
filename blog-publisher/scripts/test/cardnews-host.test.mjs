#!/usr/bin/env node
/**
 * cardnews-host.test.mjs — host.mjs(§3.11, AC-7/8) 유닛테스트
 *
 * 전부 `fetchImpl` 스텁으로 네트워크를 대체한다 — 실제 Supabase 호출 없음(Step 3b 몫).
 * 검증: 업로드 409(성공 간주)·verify 404·content-type 불일치·8MB 초과·content-addressed
 * 경로 형태·`verifyStored` 실패 분기(`url-sha-mismatch`·`gone`).
 *
 * exit 0 = 전체 통과 / exit 1 = 1개 이상 실패.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { objectPath, publicUrl, uploadSlide, verifyPublic, hostSlides, verifyStored } from '../cardnews/host.mjs';

// host.mjs 는 process.env 를 우선하므로 .env 파일 유무와 무관하게 결정론적으로 동작한다.
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};

const TMP = mkdtempSync(join(tmpdir(), 'cardnews-host-'));
const FILE_A = join(TMP, 'slide-01.jpg');
const FILE_B = join(TMP, 'slide-02.jpg');
writeFileSync(FILE_A, Buffer.from('fake-jpeg-bytes-a'));
writeFileSync(FILE_B, Buffer.from('fake-jpeg-bytes-b'));

const SHA_A = '1111111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = '2222222222222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const POST_ID = 'cn-2026-08-01-a1b2c3d4';

/** 최소 fetch Response 흉내: status/headers.get/text. */
function stubResponse({ status = 200, contentType = 'image/jpeg', contentLength = 1000, text = '' } = {}) {
  return {
    status,
    headers: {
      get: (name) => {
        const k = String(name).toLowerCase();
        if (k === 'content-type') return contentType;
        if (k === 'content-length') return String(contentLength);
        return null;
      },
    },
    text: async () => text,
  };
}

// ── 1. 업로드 409 = 성공 간주(content-addressed, 같은 경로 = 같은 바이트) ────
console.log('\n[1] 업로드 409 → 성공 간주');
{
  let calls = 0;
  const fetchImpl = async (_url, _opts) => { calls++; return stubResponse({ status: 409 }); };
  const path = objectPath(POST_ID, 0, SHA_A);
  const r = await uploadSlide(FILE_A, path, { bucket: 'cardnews', fetchImpl });
  ok('409 → ok:true', r.ok === true, JSON.stringify(r));
  ok('existed:true 로 표기', r.existed === true, JSON.stringify(r));
  ok('POST 1회만 호출', calls === 1, `calls=${calls}`);
}

// ── 2. verify 404 ────────────────────────────────────────────────────────────
console.log('\n[2] verifyPublic 404');
{
  const fetchImpl = async () => stubResponse({ status: 404 });
  const r = await verifyPublic('https://stub.supabase.co/storage/v1/object/public/cardnews/x.jpg', { fetchImpl });
  ok('ok:false', r.ok === false);
  ok("reason 에 404 명시", r.reason.includes('404'), r.reason);
}

// ── 3. content-type 불일치 ───────────────────────────────────────────────────
console.log('\n[3] verifyPublic content-type 불일치');
{
  const fetchImpl = async () => stubResponse({ status: 200, contentType: 'text/html; charset=utf-8', contentLength: 500 });
  const r = await verifyPublic('https://stub.supabase.co/storage/v1/object/public/cardnews/x.jpg', { fetchImpl });
  ok('ok:false', r.ok === false);
  ok('reason 에 content-type 명시', r.reason.includes('content-type'), r.reason);
}

// ── 4. 8MB 초과 ───────────────────────────────────────────────────────────────
console.log('\n[4] verifyPublic 8MB 초과');
{
  const fetchImpl = async () => stubResponse({ status: 200, contentType: 'image/jpeg', contentLength: 8388608 }); // 정확히 상한 = 초과 취급(>=)
  const r = await verifyPublic('https://stub.supabase.co/storage/v1/object/public/cardnews/x.jpg', { fetchImpl });
  ok('ok:false(경계값 >= 포함)', r.ok === false);
  ok('reason 에 8MB 명시', r.reason.includes('8MB'), r.reason);

  const fetchImplOk = async () => stubResponse({ status: 200, contentType: 'image/jpeg', contentLength: 8388607 });
  const rOk = await verifyPublic('https://stub.supabase.co/storage/v1/object/public/cardnews/x.jpg', { fetchImpl: fetchImplOk });
  ok('경계값-1 은 통과', rOk.ok === true, JSON.stringify(rOk));
}

// ── 5. content-addressed 경로 형태 ───────────────────────────────────────────
console.log('\n[5] objectPath 경로 형태');
{
  const p0 = objectPath(POST_ID, 0, SHA_A);
  ok(
    '형식: YYYY/MM/DD/{postId}/01-{sha16}.jpg (접두어 없음이 기본)',
    p0 === `2026/08/01/${POST_ID}/01-${SHA_A.slice(0, 16)}.jpg`,
    p0
  );
  const p6 = objectPath(POST_ID, 6, SHA_B);
  ok('index 는 1-based 로 패딩(07)', p6.includes('/07-'), p6);
  ok('post_id 날짜에서 뽑음(now 무관)', p0.startsWith('2026/08/01/'), p0);

  // post_id 에 날짜가 없는 폴백 케이스는 now 를 쓴다.
  const fallback = objectPath('no-date-id', 0, SHA_A, new Date('2026-01-15T00:00:00+09:00'));
  ok('post_id 에 날짜 없으면 now(KST) 로 폴백', fallback.startsWith('2026/01/15/'), fallback);

  // 접두어는 설정 주입식이다 — 버킷을 공유하게 되면 host.path_prefix 로 네임스페이스를 판다.
  const prefixed = objectPath(POST_ID, 0, SHA_A, new Date(), 'ig');
  ok('path_prefix 주입 시 앞에 붙음', prefixed === `ig/${p0}`, prefixed);
  ok('접두어 슬래시는 정규화됨', objectPath(POST_ID, 0, SHA_A, new Date(), '/ig/') === `ig/${p0}`);

  // 계획 §5.1 이 적어둔 실제 URL 예시는 `/public/cardnews/2026/…` — cardnews 가 한 번만 나온다.
  // 전용 버킷이라 버킷명이 곧 네임스페이스이므로 기본 접두어가 빈 문자열이어야 이 형태가 나온다.
  const url = publicUrl('cardnews', p0);
  ok('publicUrl 이 계획 §5.1 예시 형태(cardnews 중복 없음)',
    url === `https://stub.supabase.co/storage/v1/object/public/cardnews/2026/08/01/${POST_ID}/01-${SHA_A.slice(0, 16)}.jpg`, url);
}

// ── hostSlides 해피패스(다건 업로드+건별 verify) — 5~6 검증의 통합 확인 ──────
console.log('\n[hostSlides] 해피패스 — 2장 순차 업로드+verify');
{
  const seenPaths = [];
  const fetchImpl = async (url, opts) => {
    if (opts?.method === 'POST') { seenPaths.push(new URL(url).pathname); return stubResponse({ status: 201 }); }
    return stubResponse({ status: 200, contentType: 'image/jpeg', contentLength: 777 });
  };
  const r = await hostSlides([FILE_A, FILE_B], [SHA_A, SHA_B], { postId: POST_ID, cfg: {}, fetchImpl });
  ok('ok:true', r.ok === true, JSON.stringify(r));
  ok('urls 2개', Array.isArray(r.urls) && r.urls.length === 2, JSON.stringify(r));
  ok('URL 순서가 슬라이드 순서와 일치(01,02)', r.urls[0].includes('/01-') && r.urls[1].includes('/02-'), JSON.stringify(r.urls));
  ok('두 번 POST 됨(슬라이드마다 1회)', seenPaths.length === 2, `n=${seenPaths.length}`);
}

// ── 6. verifyStored 실패 분기: url-sha-mismatch ──────────────────────────────
console.log('\n[6a] verifyStored: url-sha-mismatch');
{
  const goodUrl = publicUrl('cardnews', objectPath(POST_ID, 0, SHA_A));
  // 🔴 URL 의 sha 접두어와 sha 배열이 서로 다른 경우 — verifyPublic 은 호출되지 않아야 한다
  // (자기참조가 아니라 진짜 교차검증임을 증명: fetchImpl 을 아예 안 쓰고도 실패해야 한다).
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return stubResponse({ status: 200 }); };
  const r = await verifyStored([goodUrl], [SHA_B], { fetchImpl }); // SHA_B 는 URL 의 SHA_A 와 불일치
  ok("reason==='url-sha-mismatch'", r.reason === 'url-sha-mismatch', JSON.stringify(r));
  ok('불일치 시 verifyPublic 을 아예 호출하지 않음(교차검증이 먼저 걸러냄)', fetchCalled === false);

  // 자기참조 회귀 가드: "저장된 sha 를 저장된 sha 와 비교" 라면 이 케이스가 거짓으로 통과했을 것이다.
  // 여기서는 sha 배열 자체를 URL 과 다르게 줘서 그 함정을 우회하지 않았음을 확인한다.
}

// ── 6b. verifyStored 실패 분기: gone ─────────────────────────────────────────
console.log('\n[6b] verifyStored: gone');
{
  const url0 = publicUrl('cardnews', objectPath(POST_ID, 0, SHA_A));
  const url1 = publicUrl('cardnews', objectPath(POST_ID, 1, SHA_B));
  // sha 는 URL 과 올바르게 일치(교차검증 통과) — 그러나 실제로는 삭제되어 404.
  const fetchImpl = async (url) => (url === url1 ? stubResponse({ status: 404 }) : stubResponse({ status: 200, contentLength: 500 }));
  const r = await verifyStored([url0, url1], [SHA_A, SHA_B], { fetchImpl });
  ok("reason==='gone'", r.reason === 'gone', JSON.stringify(r));
  ok('실패한 인덱스[1]가 detail 에 드러남', String(r.detail).includes('[1]'), JSON.stringify(r));
}

// ── 6c. verifyStored 정상 통과(회귀 기준선) ──────────────────────────────────
console.log('\n[6c] verifyStored: 정상 통과');
{
  const url0 = publicUrl('cardnews', objectPath(POST_ID, 0, SHA_A));
  const fetchImpl = async () => stubResponse({ status: 200, contentType: 'image/jpeg', contentLength: 500 });
  const r = await verifyStored([url0], [SHA_A], { fetchImpl });
  ok('ok:true', r.ok === true, JSON.stringify(r));
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\ncardnews host(Step 3a): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
