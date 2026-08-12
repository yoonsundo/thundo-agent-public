/**
 * cardnews/host.mjs — 카드 JPEG 7장을 Supabase Storage 공개 버킷에 올린다 (계획 §3.11)
 *
 * Meta 는 우리 이미지를 **자기가 직접 가져간다**(image_url). 따라서 인증 없이 열리는 공개
 * URL 이어야 하고, 우리가 "올렸다"고 믿는 것과 Meta 가 실제로 볼 수 있는 것이 같은지
 * 건별로 확인해야 한다 — 그래서 업로드 직후 **인증 헤더 없이** 한 번 더 GET 한다.
 *
 * 경로는 content-addressed 다: `cardnews/YYYY/MM/DD/{post_id}/{NN}-{sha16}.jpg`.
 *  - 렌더가 결정론적이면 재렌더 = 같은 sha = 같은 경로 = **같은 URL** → 재사용이 성립한다.
 *  - 렌더가 비결정론적이면 다른 sha = 다른 경로 → 그냥 새로 올라간다. 양쪽 다 안전.
 *  - 경로에 attempt_id 가 없어 host ↔ publish 순환 의존이 생기지 않는다.
 * 같은 바이트를 다시 올리면 409 가 나는데, 경로가 같으면 내용도 같다는 뜻이므로 **성공으로 친다**.
 *
 * 실패는 throw 가 아니라 `{ok:false, reason}` 으로 돌려주고, 이미 올라간 것을 지우지 않는다
 * (부분 결과는 다음 런의 재사용 자산이다).
 */
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from './lib.mjs';
import { makeLogger } from '../lib/log.mjs';

const log = makeLogger('cardnews/host');

const MAX_PUBLIC_BYTES = 8388608; // 8MB — Meta 이미지 상한(계획 §3.11 AC-8)

let _env = null;
/** process.env 우선, 없으면 .env 직접 파싱(cron 은 --env-file 로 주입하지만 단독 실행도 지원). */
export function envVar(name) {
  if (process.env[name]) return process.env[name];
  if (_env === null) {
    _env = {};
    try {
      for (const line of readFileSync(`${REPO_ROOT}/.env`, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m) _env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch { /* .env 없음 */ }
  }
  return _env[name] || null;
}

function kstYmd(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).split('-');
}

/**
 * content-addressed 오브젝트 경로. 날짜는 post_id 와 같은 KST 기준(파티셔닝 용도).
 * @param {string} postId @param {number} i 0-based 카드 index @param {string} sha 해당 카드 sha256
 */
export function objectPath(postId, i, sha, now = new Date(), prefix = '') {
  // ⚠ 날짜는 반드시 post_id 에서 뽑는다 — "지금"에서 뽑으면 안 된다.
  // post_id 는 `cn-YYYY-MM-DD-<hash>` 로 날짜를 품고 있고, content-addressed 경로의
  // 핵심 성질은 "같은 내용 → 같은 URL" 이다. 자정을 넘긴 재시도나 sweep 의 재호스팅이
  // "지금" 기준으로 날짜를 잡으면 동일 sha 가 다른 경로를 받아 그 성질이 깨지고,
  // §3.14.1 의 슬롯 재사용 판정(public_url 일치)이 영구히 false 가 된다.
  // 날짜 접두어 GC(gcOlderThan) 도 post_id 날짜 기준이어야 맞다.
  const m1 = /^cn-(\d{4})-(\d{2})-(\d{2})-/.exec(postId);
  const [y, m, d] = m1 ? [m1[1], m1[2], m1[3]] : kstYmd(now);
  const nn = String(i + 1).padStart(2, '0');
  // 접두어는 설정(`host.path_prefix`)에서 온다. 하드코딩하면 (a) 그 설정 키가 죽고
  // (b) 버킷명도 `cardnews` 라 URL 이 `/public/cardnews/cardnews/2026/…` 로 겹치는데,
  // 계획 §5.1 이 적어둔 실제 URL 예시는 `/public/cardnews/2026/…` 로 한 번만 나온다.
  // 전용 버킷이라 버킷명이 곧 네임스페이스이므로 기본 접두어는 빈 문자열이다.
  const p = prefix ? `${String(prefix).replace(/^\/+|\/+$/g, '')}/` : '';
  return `${p}${y}/${m}/${d}/${postId}/${nn}-${String(sha).slice(0, 16)}.jpg`;
}

export function publicUrl(bucket, path) {
  return `${envVar('SUPABASE_URL')}/storage/v1/object/public/${bucket}/${path}`;
}

/**
 * 슬라이드 1장 업로드. x-upsert:false — 덮어쓰지 않는다.
 * 409(이미 존재)는 content-addressed 특성상 "같은 바이트가 이미 있다"이므로 성공 취급.
 */
export async function uploadSlide(file, path, { bucket, fetchImpl = fetch } = {}) {
  const url = envVar('SUPABASE_URL');
  const key = envVar('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return { ok: false, reason: 'Supabase 크리덴셜 없음(SUPABASE_URL/SERVICE_ROLE_KEY)' };
  let body;
  try { body = readFileSync(file); } catch (e) { return { ok: false, reason: `파일 읽기 실패: ${e.message}` }; }
  try {
    const res = await fetchImpl(`${url}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'image/jpeg',
        'x-upsert': 'false',
      },
      body,
    });
    if (res.status === 409) return { ok: true, status: 409, existed: true };
    if (res.status >= 300) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };
    }
    return { ok: true, status: res.status, existed: false };
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}` };
  }
}

/**
 * 공개 URL 실측 — **인증 헤더 없이** 가져와 Meta 가 볼 수 있는지 확인한다.
 * 200 + content-type image/jpeg + 8MB 미만, 세 조건을 전부 만족해야 통과(AC-8).
 */
export async function verifyPublic(url, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = res.headers?.get?.('content-type') || '';
    if (!ct.startsWith('image/jpeg')) return { ok: false, reason: `content-type=${ct || '(없음)'}` };
    const len = Number(res.headers?.get?.('content-length'));
    if (!Number.isFinite(len)) return { ok: false, reason: 'content-length 없음' };
    if (len >= MAX_PUBLIC_BYTES) return { ok: false, reason: `content-length=${len} (>=8MB)` };
    return { ok: true, bytes: len };
  } catch (e) {
    return { ok: false, reason: `네트워크: ${e.message}` };
  }
}

/**
 * 카드 7장 순차 업로드 + **건별 즉시 verify**.
 * 중간 실패 시 이미 올린 URL 을 지우지 않고 그대로 돌려준다(재사용 자산 보존, AC-19 정신).
 * @param {string[]} files @param {string[]} sha files 와 같은 순서의 sha256
 * @returns {Promise<{ok:true, urls:string[]}|{ok:false, reason:string, uploadedUrls:string[]}>}
 */
export async function hostSlides(files, sha, { postId, cfg, now = new Date(), fetchImpl = fetch } = {}) {
  const h = cfg?.host || {};
  const bucket = h.bucket || 'cardnews';
  const timeoutMs = h.verify_timeout_ms || 15000;
  const uploadedUrls = [];
  if (!Array.isArray(files) || !Array.isArray(sha) || files.length !== sha.length) {
    return { ok: false, reason: 'files/sha 길이 불일치', uploadedUrls };
  }
  for (let i = 0; i < files.length; i++) {
    const path = objectPath(postId, i, sha[i], now, h.path_prefix ?? '');
    const up = await uploadSlide(files[i], path, { bucket, fetchImpl });
    if (!up.ok) return { ok: false, reason: `upload[${i}]: ${up.reason}`, uploadedUrls };
    const url = publicUrl(bucket, path);
    const v = await verifyPublic(url, { timeoutMs, fetchImpl });
    if (!v.ok) return { ok: false, reason: `verify[${i}]: ${v.reason}`, uploadedUrls };
    uploadedUrls.push(url);
  }
  log.info(`슬라이드 ${uploadedUrls.length}장 호스팅 완료 (${postId})`);
  return { ok: true, urls: uploadedUrls };
}

/**
 * resume 전용 검증 — 저장돼 있던 URL 과 sha 가 **서로** 맞는지, 그리고 지금도 실제로
 * 열리는지 확인한다.
 *
 * 🔴 URL↔sha 교차검증이 이 함수의 핵심이다. 저장된 sha 를 저장된 sha 와 비교하면 아무것도
 * 증명하지 못한다(자기참조). URL 에 박힌 sha 앞 16자와 sha 배열을 대조해야, 두 개의 독립
 * 저장 필드가 같은 산출물을 가리킨다는 사실이 성립하고 그때만 재렌더를 건너뛸 수 있다.
 *
 * @returns {Promise<{ok:true}|{ok:false, reason:'url-sha-mismatch'|'gone'|string}>}
 */
export async function verifyStored(urls, sha, { cfg, fetchImpl = fetch } = {}) {
  if (!Array.isArray(urls) || !Array.isArray(sha) || urls.length === 0 || urls.length !== sha.length) {
    return { ok: false, reason: 'url-sha-mismatch' };
  }
  const crossed = urls.every((u, i) => typeof u === 'string' && typeof sha[i] === 'string'
    && sha[i].length >= 16 && u.includes(sha[i].slice(0, 16)));
  if (!crossed) return { ok: false, reason: 'url-sha-mismatch' };

  const timeoutMs = cfg?.host?.verify_timeout_ms || 15000;
  for (let i = 0; i < urls.length; i++) {
    const v = await verifyPublic(urls[i], { timeoutMs, fetchImpl });
    if (!v.ok) return { ok: false, reason: 'gone', detail: `[${i}] ${v.reason}` };
  }
  return { ok: true };
}
