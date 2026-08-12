#!/usr/bin/env node
/**
 * cardnews-meta.test.mjs — meta.mjs(§3.13, AC-10/AC-12) 유닛테스트 · Step 4b
 *
 * 증명 대상:
 *  ① **fail-closed 한도**(AC-10) — `usage<total` 만 통과, `usage===total` 차단,
 *     `quota_total` 을 못 읽으면 **차단**. 못 읽었는데 통과시키면 한도 초과 발행이 조용히
 *     실패하며 그날 채널이 죽는다. `guardPublish` 가 뒤 두 경우에 `gate:'limit'` 을 낸다.
 *  ② **어떤 함수도 throw 하지 않는다**(AC-12) — `{error:{code:190}}` 도 예외가 아니라
 *     `'token-expired'` 라벨로 돌아온다. 상위가 상태를 보존한 채 held 로 내려가야 하기 때문.
 *  ③ **가드 토큰**(§3.13.1) — 없으면 `no-guard`, 소비된 토큰 재사용도 `no-guard`.
 *  ④ **reconciliation 매칭** — 마커(M2) → 캡션 sha(M1, 정규화 후) → negative guard(ambiguous).
 *     `mediaPublish` 의 `unknown`/`rejected` 구분(재시도 금지의 근거).
 *
 * 네트워크 없음(`fetchImpl` 전량 스텁) · 크리덴셜 없음. exit 0 = 전체 통과.
 */
import {
  publishReadiness, publishingLimit, guardPublish, mediaPublish,
  createChildContainer, createCarouselContainer, recentMedia, getMedia,
  findPublished, classifyMetaError,
} from '../cardnews/meta.mjs';
import { sha256, normalizeCaption } from '../cardnews/lib.mjs';

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/** 최소 Response 흉내 — readBody 가 json() → text() 순으로 읽는다. */
const resp = (status, body) => ({
  status,
  json: async () => body,
  text: async () => JSON.stringify(body ?? {}),
});

const TOKEN = {
  ig_user_id: '17841400000000000',
  access_token: 'stub-token',
  issued_at: '2026-07-01T00:00:00.000Z',
  expires_at: '2026-08-30T00:00:00.000Z',
  graph_base: 'https://graph.instagram.test',
  api_version: 'v25.0',
};
const CFG_ON = { publish: { enabled: true }, meta: { recent_media_limit: 25 } };
const CFG_OFF = { publish: { enabled: false }, meta: {} };

// ── 1. publishReadiness — 무인 발행 마스터 스위치 ────────────────────────────
console.log('\n[1] publishReadiness — publish.enabled 가 마스터 스위치');
{
  const off = publishReadiness(CFG_OFF, TOKEN);
  eq('enabled=false → ready:false', off.ready, false);
  ok('사유가 스위치를 지목', off.reason.includes('publish.enabled=false'), off.reason);

  const on = publishReadiness(CFG_ON, TOKEN);
  eq('enabled=true + 온전한 토큰 → ready:true', on.ready, true);

  const { access_token, ...noAccess } = TOKEN;
  const miss = publishReadiness(CFG_ON, noAccess);
  eq('토큰 키 누락 → ready:false', miss.ready, false);
  ok('누락 키를 사유에 명시', miss.reason.includes('access_token'), miss.reason);
}

// ── 2. publishingLimit — AC-10 세 갈래 (fail-closed) ─────────────────────────
console.log('\n[2] publishingLimit — fail-closed 3종(AC-10)');
{
  const under = await publishingLimit(TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: { quota_total: 50 }, quota_usage: 3 }] }),
  });
  ok('① usage<total → allowed:true', under.ok === true && under.allowed === true, JSON.stringify(under));
  eq('   quotaTotal 파싱', under.quotaTotal, 50);
  eq('   quotaUsage 파싱', under.quotaUsage, 3);

  const at = await publishingLimit(TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: { quota_total: 50 }, quota_usage: 50 }] }),
  });
  ok('② usage===total → allowed:false(경계값은 차단)', at.ok === true && at.allowed === false, JSON.stringify(at));

  const noTotal = await publishingLimit(TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: {}, quota_usage: 3 }] }),
  });
  eq('③ quota_total 부재 → ok:false(fail-closed)', noTotal.ok, false);
  ok('   사유가 fail-closed 임을 밝힌다', String(noTotal.reason).includes('fail-closed'), noTotal.reason);

  const netDead = await publishingLimit(TOKEN, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  eq('네트워크 실패도 throw 아닌 ok:false', netDead.ok, false);

  const http400 = await publishingLimit(TOKEN, {
    fetchImpl: async () => resp(400, { error: { code: 190, type: 'OAuthException', message: 'expired' } }),
  });
  eq('HTTP 오류도 ok:false', http400.ok, false);
  eq('오류 라벨이 붙는다', http400.error, 'token-expired');

  // 응답이 배열이 아니라 단일 객체인 변형도 읽는다(Step 1 M-a 가 실물로 확정할 형태).
  const flat = await publishingLimit(TOKEN, {
    fetchImpl: async () => resp(200, { config: { quota_total: 25 }, quota_usage: 1 }),
  });
  ok('data 래핑 없는 응답도 파싱', flat.ok === true && flat.quotaTotal === 25, JSON.stringify(flat));
}

// ── 3. guardPublish — 초크포인트 발급 조건 ───────────────────────────────────
console.log('\n[3] guardPublish — readiness → limit, 둘 다 통과할 때만 토큰');
{
  let calls = 0;
  const g1 = await guardPublish(CFG_OFF, TOKEN, { fetchImpl: async () => { calls++; return resp(200, {}); } });
  eq('publish.enabled=false → gate:readiness', g1.gate, 'readiness');
  eq('   ok:false', g1.ok, false);
  eq('   🔴 한도 조회조차 하지 않는다(네트워크 0회)', calls, 0);
  ok('   가드 토큰 미발급', g1.guardToken === undefined);

  const g2 = await guardPublish(CFG_ON, TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: { quota_total: 50 }, quota_usage: 50 }] }),
  });
  eq('② quota 소진 → gate:limit', g2.gate, 'limit');
  ok('   사유에 수치가 남는다', String(g2.reason).includes('50/50'), g2.reason);

  const g3 = await guardPublish(CFG_ON, TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: {}, quota_usage: 1 }] }),
  });
  eq('③ quota_total 미파싱 → gate:limit(fail-closed)', g3.gate, 'limit');

  const g4 = await guardPublish(CFG_ON, TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: { quota_total: 50 }, quota_usage: 0 }] }),
  });
  ok('통과 시 guardToken 발급', g4.ok === true && typeof g4.guardToken?.id === 'string', JSON.stringify(g4));
  ok('issuedAt 기록(TTL 도입 비용을 한 줄로 남겨둔다)', Number.isFinite(g4.guardToken.issuedAt));
}

/** 유효한 가드 1개 발급(한도 통과 스텁). */
async function freshGuard() {
  return guardPublish(CFG_ON, TOKEN, {
    fetchImpl: async () => resp(200, { data: [{ config: { quota_total: 50 }, quota_usage: 0 }] }),
  });
}

// ── 4. mediaPublish — 가드 · 1회용 · unknown/rejected 구분 ───────────────────
console.log('\n[4] mediaPublish — 가드 없이는 네트워크를 건드리지 않는다');
{
  let calls = 0;
  const fetchImpl = async () => { calls++; return resp(200, { id: '17999' }); };
  const noGuard = await mediaPublish(TOKEN, { creationId: '1', guardToken: undefined }, { fetchImpl });
  eq('가드 없음 → rejected', noGuard.outcome, 'rejected');
  eq('   reason no-guard', noGuard.reason, 'no-guard');
  eq('   🔴 fetch 0회', calls, 0);

  const fake = await mediaPublish(TOKEN, { creationId: '1', guardToken: { id: 'made-up-id' } }, { fetchImpl });
  eq('위조 토큰도 거부', fake.reason, 'no-guard');
  eq('   fetch 여전히 0회', calls, 0);

  const g = await freshGuard();
  const okPub = await mediaPublish(TOKEN, { creationId: 'carousel-1', guardToken: g.guardToken }, { fetchImpl });
  ok('유효 가드 → 발행', okPub.ok === true && okPub.mediaId === '17999', JSON.stringify(okPub));
  eq('   이제 fetch 1회', calls, 1);

  const replay = await mediaPublish(TOKEN, { creationId: 'carousel-1', guardToken: g.guardToken }, { fetchImpl });
  eq('소비된 토큰 replay → no-guard', replay.reason, 'no-guard');
  eq('   replay 는 fetch 를 늘리지 않는다', calls, 1);
}

console.log('\n[5] mediaPublish — unknown vs rejected(재시도 금지의 근거)');
{
  const g1 = await freshGuard();
  const timeout = await mediaPublish(TOKEN, { creationId: 'c', guardToken: g1.guardToken }, {
    fetchImpl: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; },
  });
  eq('AbortError → unknown(발행됐는지 모른다)', timeout.outcome, 'unknown');

  const g2 = await freshGuard();
  const five = await mediaPublish(TOKEN, { creationId: 'c', guardToken: g2.guardToken }, {
    fetchImpl: async () => resp(503, { error: { message: 'service unavailable' } }),
  });
  eq('5xx → unknown', five.outcome, 'unknown');

  const g3 = await freshGuard();
  const four = await mediaPublish(TOKEN, { creationId: 'c', guardToken: g3.guardToken }, {
    fetchImpl: async () => resp(400, { error: { code: 190, type: 'OAuthException' } }),
  });
  eq('4xx → rejected', four.outcome, 'rejected');
  eq('   사유는 분류 라벨', four.reason, 'token-expired');

  const g4 = await freshGuard();
  const noId = await mediaPublish(TOKEN, { creationId: 'c', guardToken: g4.guardToken }, {
    fetchImpl: async () => resp(200, {}),
  });
  eq('200 인데 id 부재 → unknown(성공으로 치지 않는다)', noId.outcome, 'unknown');

  const g5 = await freshGuard();
  const noCreation = await mediaPublish(TOKEN, { creationId: '', guardToken: g5.guardToken }, {
    fetchImpl: async () => resp(200, { id: 'x' }),
  });
  eq('creation_id 없음 → rejected', noCreation.outcome, 'rejected');
}

// ── 6. 컨테이너 생성 — createdAt 은 우리 시계, 오류는 라벨 ──────────────────
console.log('\n[6] createChildContainer / createCarouselContainer');
{
  const before = Date.now();
  const child = await createChildContainer(TOKEN, { imageUrl: 'https://x/1.jpg' }, {
    fetchImpl: async (url) => {
      ok('image_url 이 인코딩돼 실린다', url.includes(encodeURIComponent('https://x/1.jpg')), url);
      ok('is_carousel_item=true', url.includes('is_carousel_item=true'), url);
      return resp(200, { id: '17901' });
    },
  });
  eq('containerId 반환', child.containerId, '17901');
  const t = Date.parse(child.createdAt);
  ok('createdAt 은 호출 시점 우리 시계(Meta 는 안 준다)', t >= before && t <= Date.now(), child.createdAt);

  const fail = await createChildContainer(TOKEN, { imageUrl: 'https://x/1.jpg' }, {
    fetchImpl: async () => resp(400, { error: { code: 2207003, message: 'The image could not be fetched' } }),
  });
  eq('media-fetch 오류 라벨', fail.error, 'media-fetch');
  ok('실패해도 createdAt 은 남는다(백오프 재시도 판단용)', typeof fail.createdAt === 'string');

  const car = await createCarouselContainer(TOKEN, { childIds: ['1', '2', '3'], caption: '캡션 #cn20260801' }, {
    fetchImpl: async (url) => {
      ok('media_type=CAROUSEL', url.includes('media_type=CAROUSEL'), url);
      ok('children 이 콤마 결합', url.includes(encodeURIComponent('1,2,3')), url);
      return resp(200, { id: '17902' });
    },
  });
  eq('캐러셀 containerId', car.containerId, '17902');
  eq('childrenKey 를 돌려준다(매칭키 write-ahead 용)', car.childrenKey, '1,2,3');

  const net = await createCarouselContainer(TOKEN, { childIds: ['1'], caption: 'x' }, {
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  ok('네트워크 예외도 throw 아닌 {ok:false}', net.ok === false && net.error === 'transient', JSON.stringify(net));
}

// ── 7. findPublished — M2 → M1 → negative guard ─────────────────────────────
console.log('\n[7] findPublished — 마커(M2) → 캡션 sha(M1) → ambiguous');
{
  const MARKER = '#cn20260801a1b2c3d4';
  const CAPTION = '일본에서 밥그릇을 드는 이유\n\n본문…  여러 줄\n\n' + MARKER;
  const CAPTION_SHA = sha256(normalizeCaption(CAPTION).slice(0, 200));

  const byMarker = await findPublished(TOKEN, { idemMarker: MARKER, captionSha: CAPTION_SHA }, {
    fetchImpl: async () => resp(200, {
      data: [
        { id: '1', caption: '다른 글', timestamp: '2026-08-01T01:00:00+0000' },
        { id: '2', caption: CAPTION, timestamp: '2026-08-01T02:00:00+0000' },
      ],
    }),
  });
  ok('마커 일치 → mediaId', byMarker.mediaId === '2' && byMarker.matchedBy === 'marker', JSON.stringify(byMarker));

  // M1 폴백: 마커가 깨졌지만(플랫폼이 캡션을 손댔다) 캡션 본문은 같다.
  // 개행·공백이 달라져도 정규화 후 해시가 같아야 한다 — 그게 normalizeCaption 의 존재 이유.
  const mangled = CAPTION.replace(MARKER, '').replace(/\n+/g, '   ');
  const mangledSha = sha256(normalizeCaption(mangled).slice(0, 200));
  const bySha = await findPublished(TOKEN, { idemMarker: MARKER, captionSha: mangledSha }, {
    fetchImpl: async () => resp(200, { data: [{ id: '9', caption: mangled.replace(/ {3}/g, '\n'), timestamp: '2026-08-01T02:00:00+0000' }] }),
  });
  ok('마커 소실 시 캡션 sha 폴백(공백 정규화 후 일치)',
    bySha.mediaId === '9' && bySha.matchedBy === 'caption-sha', JSON.stringify(bySha));

  const none = await findPublished(TOKEN, { idemMarker: MARKER, captionSha: CAPTION_SHA, newerTs: '2026-08-01T02:00:00.000Z' }, {
    fetchImpl: async () => resp(200, { data: [{ id: '3', caption: '남의 글', timestamp: '2026-08-01T01:00:00+0000' }] }),
  });
  ok('매칭 0건 + 이후 미디어 없음 → 확정 미발행', none.ok === true && none.mediaId === null && none.ambiguous === false,
    JSON.stringify(none));

  const amb = await findPublished(TOKEN, { idemMarker: MARKER, captionSha: CAPTION_SHA, newerTs: '2026-08-01T02:00:00.000Z' }, {
    fetchImpl: async () => resp(200, { data: [{ id: '4', caption: '캡션 없음일 수도', timestamp: '2026-08-01T02:30:00+0000' }] }),
  });
  ok('🔴 매칭 0건인데 요청 이후 미디어 존재 → ambiguous(재발행 금지)',
    amb.ok === true && amb.mediaId === null && amb.ambiguous === true, JSON.stringify(amb));

  const dead = await findPublished(TOKEN, { idemMarker: MARKER }, {
    fetchImpl: async () => resp(500, { error: { message: 'boom' } }),
  });
  eq('조회 실패는 "미발행"이 아니라 ok:false(판단 불가)', dead.ok, false);

  // since 는 유닉스 초로 실린다(Graph API 계약).
  let seenUrl = '';
  await recentMedia(TOKEN, { limit: 25, since: '2026-08-01T01:30:00.000Z' }, {
    fetchImpl: async (url) => { seenUrl = url; return resp(200, { data: [] }); },
  });
  ok('since 가 유닉스 초로 변환된다', seenUrl.includes(`since=${Math.floor(Date.parse('2026-08-01T01:30:00.000Z') / 1000)}`), seenUrl);
}

// ── 8. getMedia — liveness ──────────────────────────────────────────────────
console.log('\n[8] getMedia — 발행 성공 ≠ 노출(R17)');
{
  const live = await getMedia(TOKEN, { mediaId: '17903' }, {
    fetchImpl: async () => resp(200, { id: '17903', permalink: 'https://www.instagram.com/p/abc/', timestamp: '2026-08-01T02:01:55+0000' }),
  });
  ok('permalink 반환', live.ok === true && live.permalink.includes('/p/abc/'), JSON.stringify(live));

  const gone = await getMedia(TOKEN, { mediaId: '17903' }, { fetchImpl: async () => resp(404, { error: { message: 'not found' } }) });
  eq('404 → ok:false(상태는 상위가 판단)', gone.ok, false);
}

// ── 9. classifyMetaError — 회복 경로 라벨 ───────────────────────────────────
console.log('\n[9] classifyMetaError — 재시도해도 낫지 않는 것을 구분한다');
{
  eq('190 → token-expired', classifyMetaError(400, { error: { code: 190 } }), 'token-expired');
  eq('OAuthException → token-expired', classifyMetaError(400, { error: { type: 'OAuthException' } }), 'token-expired');
  eq('10 → permission', classifyMetaError(403, { error: { code: 10 } }), 'permission');
  eq('200(코드) → permission', classifyMetaError(403, { error: { code: 200 } }), 'permission');
  eq('2207003 → media-fetch', classifyMetaError(400, { error: { code: 2207003 } }), 'media-fetch');
  eq('컨테이너 만료 → container-expired',
    classifyMetaError(400, { error: { message: 'The media container has expired' } }), 'container-expired');
  eq('4 → rate', classifyMetaError(400, { error: { code: 4 } }), 'rate');
  eq('5xx → transient', classifyMetaError(503, {}), 'transient');
  eq('모르면 unknown', classifyMetaError(418, { error: { code: 99999 } }), 'unknown');
}

console.log(`\ncardnews meta(Step 4b): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
