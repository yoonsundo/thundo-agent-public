/**
 * shorts-curiosity/analytics-collect.mjs — YouTube 공개 통계 수집 (호기심 채널)
 *
 * 현재 OAuth 토큰(oauth_token_file)에는 yt-analytics.readonly 스코프가 없다(재동의 필요).
 * 그래서 트래픽소스·시청지속 등 상세 애널리틱스는 범위 밖 — 대신 공개 Data API v3
 * videos.list(part=statistics,snippet)로 조회수·좋아요·댓글수·게시일·제목만 수집한다.
 * channels.list(part=statistics)로 구독자·총조회·영상수도 함께 수집한다(500 구독 목표 추적).
 *
 * ⚠ 실측(2026-07-16): 이 refresh_token 의 스코프는 `youtube.upload` 뿐이고, videos.list 는
 * OAuth Bearer 로 호출 시 그보다 넓은 스코프(youtube.readonly 등)를 요구해 403
 * "insufficient authentication scopes" 로 거부된다(업로드 스코프로는 읽기가 안 됨).
 * videos.list 는 공개 영상이면 OAuth 없이 API 키만으로도 호출 가능 — 재동의 없이
 * `.env` 의 `YOUTUBE_API_KEY`(또는 `GOOGLE_API_KEY`, Google Cloud 콘솔에서 발급)가 있으면
 * OAuth 403/401 시 그 키로 자동 폴백한다.
 *
 * ⚠⚠ 무음 실패 제거 (2026-07-30): 키도 없어서 수집이 0건이 되면 예전에는 `log.warn` + exit 0
 * 으로 조용히 끝났다. 그 결과 **업로드 47편의 조회수가 단 한 번도 수집된 적이 없고**
 * (state/shorts-curiosity/analytics.jsonl 자체가 없었다) 사용자는 그 사실을 몰랐다.
 * 이제 수집 0건이면 Telegram/Discord 로 경보를 보내 드러낸다(하루 1회 마커로 중복 억제).
 * exit 계약은 그대로 0(비차단) — 조용하지 않을 뿐이다.
 *
 * state/shorts-curiosity/analytics.jsonl 에 스냅샷을 append(upsert 아님) — 날짜별 추세는
 * analytics-report.mjs가 시계열로 계산한다. 채널 통계는 channel-stats.jsonl.
 *
 * 계약(GSC/네이버 SEO 폐루프와 동일):
 *   - 업로드된(youtube_id 보유) 항목 0개 → info + exit 0 (크리덴셜 문제 아님 → 경보 없음)
 *   - upload.enabled=false·OAuth 토큰 없음/불완전·스코프 부족+API키 없음 → 경보 + exit 0
 *   - RUN_MODE=mock → 실 API 호출 없이 합성 스텁으로 정상 종료(검증용, 경보 없음)
 */
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { paths } from '../lib/config.mjs';
import { loadConfig, loadIndex } from './lib.mjs';
import { uploadReadiness } from '../shorts/upload.mjs';
import { notify, EVENTS } from '../notify/index.mjs';

const log = makeLogger('curiosity-analytics');

const ANALYTICS_DIR = join(paths.state, 'shorts-curiosity');
const ANALYTICS_PATH = join(ANALYTICS_DIR, 'analytics.jsonl');
const CHANNEL_STATS_PATH = join(ANALYTICS_DIR, 'channel-stats.jsonl');

/** API 키는 호출 시점에 읽는다 — 모듈 로드 시 const 로 굳히면 테스트가 env 를 주입할 수 없다. */
function apiKey() {
  return process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || '';
}

/**
 * RUN_MODE=mock 명시 여부(원본 env 직접 확인).
 * lib/config.mjs 의 파생 isMock()은 이 채널과 무관한 자격(GITHUB_TOKEN 등) 누락 시에도
 * live 요청을 mock 으로 강등시켜(§detectRunMode) 유튜브 실크리덴셜이 있어도 항상 mock으로
 * 빠진다 — GSC/네이버 SEO 수집기(naver-search.mjs isMockMode)와 동일하게 원본 env로 판정.
 */
function isMockMode() {
  return process.env.RUN_MODE === 'mock';
}

/** refresh_token → access token. shorts/upload.mjs accessToken()과 동일 패턴(export 없어 로컬 재구현). */
async function accessToken(tok) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tok.client_id, client_secret: tok.client_secret,
      refresh_token: tok.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (res.status !== 200) throw new Error(`토큰 갱신 실패 HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('access_token 부재');
  return j.access_token;
}

/** 인덱스에서 uploaded + youtube_id 보유 항목만 추출 → [{id, youtube_id, subject}] */
export function uploadedEntries() {
  const idx = loadIndex();
  return Object.entries(idx)
    .filter(([, v]) => v.status === 'uploaded' && v.youtube_id)
    .map(([id, v]) => ({ id, youtube_id: v.youtube_id, subject: v.subject || '' }));
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * videos.list part=statistics,snippet 실 호출 (ID 50개씩 배치 — Data API id 상한).
 * OAuth Bearer 먼저 시도 → 401/403(스코프 부족)이고 API 키가 있으면 공개 API 키로 폴백.
 */
export async function fetchStats(token, ids) {
  const out = new Map();
  const key = apiKey();
  for (const group of chunk(ids, 50)) {
    const base = `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${group.join(',')}`;
    let res = token ? await fetch(base, { headers: { Authorization: `Bearer ${token}` } }) : null;
    if ((!res || res.status === 401 || res.status === 403) && key) {
      res = await fetch(`${base}&key=${key}`);
    }
    if (!res) throw new Error('videos.list 호출 수단 없음(OAuth·API 키 모두 부재)');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`videos.list HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const item of (data.items || [])) {
      out.set(item.id, {
        title: item.snippet?.title || '',
        channel_id: item.snippet?.channelId || null,
        published_at: item.snippet?.publishedAt || null,
        views: item.statistics?.viewCount != null ? Number(item.statistics.viewCount) : null,
        likes: item.statistics?.likeCount != null ? Number(item.statistics.likeCount) : null,
        comments: item.statistics?.commentCount != null ? Number(item.statistics.commentCount) : null,
      });
    }
  }
  return out;
}

/**
 * channels.list part=statistics,snippet → 구독자·총조회·영상수 (US-006 구독 500 추적).
 * 시도 순서: (1) API 키 + channelId — 재동의 없이 되는 경로라 우선,
 *            (2) OAuth + channelId, (3) OAuth + mine=true(채널ID 모를 때).
 * channelId 는 videos.list 응답의 snippet.channelId 에서 유도한다(API 키만으로 얻어짐).
 */
export async function fetchChannelStats({ token = '', channelId = '' } = {}) {
  const key = apiKey();
  const base = 'https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet';
  const attempts = [];
  if (channelId && key) attempts.push({ url: `${base}&id=${channelId}&key=${key}`, headers: {} });
  if (channelId && token) attempts.push({ url: `${base}&id=${channelId}`, headers: { Authorization: `Bearer ${token}` } });
  if (token) attempts.push({ url: `${base}&mine=true`, headers: { Authorization: `Bearer ${token}` } });
  if (attempts.length === 0) throw new Error('channels.list 호출 수단 없음(API 키·OAuth 모두 부재)');

  const errors = [];
  for (const a of attempts) {
    let res;
    try {
      res = await fetch(a.url, { headers: a.headers });
    } catch (e) {
      errors.push(`fetch 실패: ${e.message}`);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      errors.push(`HTTP ${res.status}: ${text.slice(0, 120)}`);
      continue;
    }
    const data = await res.json();
    const item = (data.items || [])[0];
    if (!item) { errors.push('items 비어 있음'); continue; }
    const s = item.statistics || {};
    return {
      channel_id: item.id || channelId || null,
      channel_title: item.snippet?.title || null,
      subscribers: s.subscriberCount != null ? Number(s.subscriberCount) : null,
      subscribers_hidden: !!s.hiddenSubscriberCount,
      views: s.viewCount != null ? Number(s.viewCount) : null,
      videos: s.videoCount != null ? Number(s.videoCount) : null,
    };
  }
  throw new Error(`channels.list 전 경로 실패 — ${errors.join(' / ')}`);
}

/** mock 합성 스텁 — youtube_id 문자열 기반 결정론적 가짜 지표(네트워크 호출 없음). */
function mockStats(youtube_id) {
  let h = 0;
  for (const c of String(youtube_id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const views = 200 + (h % 5000);
  return {
    title: null, published_at: null,
    views, likes: Math.round(views * 0.04), comments: Math.round(views * 0.003),
  };
}

/** mock 채널 통계 — 편수 기반 결정론(리포트의 구독자·ETA 경로를 mock 에서도 태우기 위함). */
function mockChannelStats(records) {
  const views = records.reduce((a, r) => a + (r.views || 0), 0);
  return {
    channel_id: 'MOCK_CHANNEL', channel_title: '(mock) 호기심 채널',
    subscribers: 100 + records.length, subscribers_hidden: false,
    views, videos: records.length,
  };
}

function appendSnapshots(records) {
  mkdirSync(ANALYTICS_DIR, { recursive: true });
  const ts = new Date().toISOString();
  for (const r of records) {
    appendFileSync(ANALYTICS_PATH, JSON.stringify({ ts, ...r }) + '\n', 'utf8');
  }
}

function appendChannelStats(stats) {
  mkdirSync(ANALYTICS_DIR, { recursive: true });
  appendFileSync(CHANNEL_STATS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...stats }) + '\n', 'utf8');
}

// ─── 무음 실패 제거: 수집 0건 경보 ───────────────────────────────────────────

/** 경보 하루 1회 마커 경로. cron 이 새벽 2시마다 같은 경보를 반복하지 않게 한다. */
export function alertMarkerPath(now = new Date()) {
  // KST 기준 날짜 — 사람이 보는 날짜와 마커가 어긋나지 않도록 타임존 명시.
  const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  return join(ANALYTICS_DIR, `.analytics-alert-${day}`);
}

/**
 * 원시 API 응답을 사람이 읽는 한 줄로 정제.
 * 왜: YouTube API 오류 본문(중괄호·따옴표·역슬래시 덩어리)을 경보에 그대로 실어 보내
 * Telegram 이 HTTP 400 "can't parse entities" 로 거부했다(2026-07-30 실측 — 가장 중요한
 * 경보가 텔레그램에 도달하지 못하고 Discord 만 부분 전달됐다). 원시 응답은 로그에만 남긴다.
 */
function sanitizeText(s, max = 140) {
  let t = String(s || '');
  // JSON 본문이 붙어 있으면 사람에게 의미 있는 message 필드만 뽑아 쓴다.
  const msg = t.match(/"message"\s*:\s*"([^"]{0,200})"/);
  const head = t.split('{')[0];
  t = msg ? `${head.trim()} ${msg[1]}` : head || t;
  t = t.replace(/[{}[\]"\\`*_|]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 실패를 사람이 조치할 수 있는 갈래로 분류한다 → { kind, summary, fix }.
 * 갈래: oauth-scope(스코프 부족) / no-api-key(키 미설정) / quota(쿼터·권한) /
 *       http(그 외 상태코드) / network(네트워크) / other.
 */
export function classifyFailure({ reason, hasApiKey = apiKey() !== '' } = {}) {
  const raw = String(reason || '');
  const short = sanitizeText(raw);
  const httpCode = (raw.match(/HTTP\s+(\d{3})/) || [])[1] || null;

  const FIX_KEY = [
    '조치: 1) Google Cloud Console → API 및 서비스 → YouTube Data API v3 사용설정',
    '      2) 사용자 인증 정보 → API 키 만들기',
    '      3) .env 에 YOUTUBE_API_KEY=발급받은키 추가',
    '      4) 다음 새벽 2시 cron 이 자동 수집 (즉시 확인: npm run curiosity:analytics)',
  ].join('\n');

  if (/insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT|스코프 부족/i.test(raw)) {
    return {
      kind: 'oauth-scope',
      summary: 'OAuth 스코프가 youtube.upload 뿐이라 조회수 읽기 불가 (videos.list 403 거부)',
      fix: hasApiKey
        ? '조치: API 키는 있으나 거부됐다 → Cloud Console 에서 그 키의 YouTube Data API v3 사용설정·키 제한(HTTP 리퍼러/IP)을 확인.'
        : FIX_KEY,
    };
  }
  if (!hasApiKey && (/호출 수단 없음|API 키 부재|토큰/.test(raw) || httpCode === '401' || httpCode === '403')) {
    return {
      kind: 'no-api-key',
      summary: 'YOUTUBE_API_KEY 미설정 — OAuth 는 업로드 전용 스코프라 조회수 읽기 경로가 없음',
      fix: FIX_KEY,
    };
  }
  if (/quota|rateLimit|429/i.test(raw) || httpCode === '429') {
    return {
      kind: 'quota',
      summary: `YouTube API 쿼터/호출제한에 걸림 (HTTP ${httpCode || 429}: ${short})`,
      fix: '조치: Cloud Console → API 및 서비스 → YouTube Data API v3 → 할당량 확인. 일 한도면 다음날 자동 회복된다.',
    };
  }
  if (httpCode) {
    return {
      kind: 'http',
      summary: `YouTube API 가 HTTP ${httpCode} 로 거부 (${short})`,
      fix: hasApiKey
        ? '조치: Cloud Console 에서 YouTube Data API v3 사용설정·API 키 유효성을 확인. 반복되면 로그(runs/curiosity-analytics-*.log)의 원시 응답을 확인.'
        : FIX_KEY,
    };
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|timeout/i.test(raw)) {
    return {
      kind: 'network',
      summary: `네트워크 오류로 API 호출 실패 (${short})`,
      fix: '조치: 일시 장애면 다음 새벽 2시 cron 이 재시도한다. 반복되면 박스 네트워크·DNS 확인.',
    };
  }
  return {
    kind: 'other',
    summary: short || '원인 미상',
    fix: hasApiKey ? '조치: runs/curiosity-analytics-*.log 의 원시 응답 확인.' : FIX_KEY,
  };
}

/**
 * 경보 본문 — (i) 왜 못 걷었는지(분류된 한 줄) (ii) 조치 (iii) 측정 불가 편수.
 * 원시 JSON 은 절대 싣지 않는다(로그 전용). Telegram parse_mode=Markdown 을 깨는
 * 중괄호·따옴표·역슬래시·`*_` 는 sanitizeText 가 제거한다.
 */
export function buildAlertPayload({ reason, uploads = 0, hasApiKey = apiKey() !== '' }) {
  const c = classifyFailure({ reason, hasApiKey });
  const lines = [
    `현황: 업로드 ${uploads}편의 조회수가 측정 불가 (수집 0건 — state/shorts-curiosity/analytics.jsonl 미갱신)`,
    `원인: ${c.summary}`,
  ];
  if (!hasApiKey && c.kind !== 'no-api-key') lines.push('참고: .env 에 YOUTUBE_API_KEY 도 없어 공개 API 키 폴백 경로가 없다');
  lines.push(c.fix);
  lines.push('영향: 성과 기반 주제 선정·구독 500 추적이 눈 감고 돌아간다');
  return { reason: `호기심 쇼츠 조회수 수집 실패 — ${c.summary}`, details: lines.join('\n'), kind: c.kind };
}

/**
 * 수집 0건 경보 발송. 하루 1회 마커로 중복 억제, 발송 결과는 반환값 sent 로 확인해 로그에 남긴다
 * ("보냈다고 가정" 금지 — notify() 는 크리덴셜 없으면 console-fallback 을 반환한다).
 * 절대 throw 하지 않는다(경보 실패가 cron 을 죽이면 안 됨).
 * @returns {Promise<{alerted:boolean, skipped?:string, delivery?:object, marker:string}>}
 */
export async function alertBlocked({ reason, uploads = 0, notifier = notify, now = new Date() } = {}) {
  const marker = alertMarkerPath(now);
  const payload = buildAlertPayload({ reason, uploads });

  if (existsSync(marker)) {
    log.warn(`수집 0건(${reason}) — 오늘 경보 이미 발송됨(${marker}) → 중복 발송 생략`);
    return { alerted: false, skipped: 'daily-marker', marker };
  }

  // 운영 경보다 — 이 박스는 필수 크리덴셜 누락으로 config 가 항상 mock 으로 강등되므로
  // NOTIFY_FORCE_LIVE=1 없이는 .mock-out/notify.log 에만 적히고 사람에게 도달하지 않는다.
  // forceLive() 는 호출 시점 env 를 읽으므로 여기서 세팅해도 유효하다(git-persist-fail.mjs 관례).
  process.env.NOTIFY_FORCE_LIVE = '1';

  let delivery;
  try {
    // 전용 이벤트 타입이 없어 TRIPWIRE(감시 발동)로 싣는다 — 사유 문구에 맥락을 담는다.
    delivery = await notifier(EVENTS.TRIPWIRE, payload);
  } catch (e) {
    log.error(`경보 발송 자체 실패: ${e?.message || e}`);
    delivery = { telegram: 'error', discord: 'error' };
  }

  const sent = delivery && (delivery.telegram === 'sent' || delivery.discord === 'sent');
  if (sent) log.info(`수집 0건 경보 발송됨 — telegram=${delivery.telegram} discord=${delivery.discord}`);
  else log.warn(`수집 0건 경보가 사람에게 도달하지 않았다(크리덴셜 확인) — ${JSON.stringify(delivery)}`);

  try {
    mkdirSync(ANALYTICS_DIR, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()} ${reason}\n`, 'utf8');
  } catch (e) {
    log.warn(`경보 마커 기록 실패(다음 런에서 재발송될 수 있음): ${e.message}`);
  }

  return { alerted: true, delivery, sent: !!sent, marker };
}

async function main() {
  const cfg = loadConfig();
  const entries = uploadedEntries();
  const mock = isMockMode();

  if (entries.length === 0) {
    log.info('업로드된(youtube_id 보유) 항목 없음 — 수집 스킵');
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no-uploaded-entries' }));
    process.exit(0);
  }

  if (mock) {
    // mock: true 태그 — 같은 jsonl 에 append 하는 기존 계약을 지키면서도, 합성 수치가 실 추세
    // (구독 ETA·전일대비)에 섞이지 않게 한다. analytics-report.mjs 가 live 런에서 걸러낸다.
    const records = entries.map(e => ({ youtube_id: e.youtube_id, subject: e.subject, mock: true, ...mockStats(e.youtube_id) }));
    appendSnapshots(records);
    const ch = { ...mockChannelStats(records), mock: true };
    appendChannelStats(ch);
    log.info(`[mock] 합성 스냅샷 ${records.length}건 + 채널통계(구독 ${ch.subscribers}) append`);
    console.log(JSON.stringify({ ok: true, mode: 'mock', collected: records.length, subscribers: ch.subscribers, path: ANALYTICS_PATH }));
    return;
  }

  const readiness = uploadReadiness(cfg);
  if (!readiness.ready) {
    log.warn(`수집 불가: ${readiness.reason}`);
    const a = await alertBlocked({ reason: readiness.reason, uploads: entries.length });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: readiness.reason, alerted: a.alerted }));
    process.exit(0);
  }

  let token = '';
  try {
    token = await accessToken(readiness.token);
  } catch (e) {
    // 토큰이 죽었어도 API 키가 있으면 공개 통계는 걷을 수 있다 → 즉시 포기하지 않는다.
    log.warn(`토큰 발급 실패: ${e.message}${apiKey() ? ' — API 키로 계속' : ''}`);
    if (!apiKey()) {
      const a = await alertBlocked({ reason: `OAuth 토큰 발급 실패(${e.message})`, uploads: entries.length });
      console.log(JSON.stringify({ ok: true, skipped: true, reason: `token: ${e.message}`, alerted: a.alerted }));
      process.exit(0);
    }
  }

  const ids = entries.map(e => e.youtube_id);
  let statsMap;
  try {
    statsMap = await fetchStats(token, ids);
  } catch (e) {
    log.warn(`videos.list 호출 실패: ${e.message}`);
    const a = await alertBlocked({ reason: e.message, uploads: entries.length });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: e.message, alerted: a.alerted }));
    process.exit(0);
  }

  const records = [];
  const missing = [];
  for (const e of entries) {
    const s = statsMap.get(e.youtube_id);
    if (!s) { missing.push(e.youtube_id); continue; }
    records.push({
      youtube_id: e.youtube_id, subject: e.subject,
      title: s.title, published_at: s.published_at,
      views: s.views, likes: s.likes, comments: s.comments,
    });
  }

  if (records.length === 0) {
    log.warn(`videos.list 응답에 매칭 영상 없음(전부 비공개 전환/삭제?) — 저장 스킵, 업로드 ${entries.length}편 측정 불가`);
    const a = await alertBlocked({ reason: `videos.list 응답에 매칭 영상 0건(요청 ${ids.length}개)`, uploads: entries.length });
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'no-matched-videos', missing, alerted: a.alerted }));
    process.exit(0);
  }

  appendSnapshots(records);
  log.info(`state/shorts-curiosity/analytics.jsonl append 완료: ${records.length}건${missing.length ? ` (매칭실패 ${missing.length}건)` : ''}`);

  // 채널 통계(구독자 500 추적) — 실패해도 영상 스냅샷은 이미 저장됐으므로 비차단.
  // 다만 조용히 넘기지 않는다: 같은 하루1회 마커 경보에 합류시킨다.
  let channel = null;
  const channelId = [...statsMap.values()].map(v => v.channel_id).find(Boolean) || '';
  try {
    channel = await fetchChannelStats({ token, channelId });
    appendChannelStats(channel);
    log.info(`채널통계 append: 구독 ${channel.subscribers ?? '-'} · 총조회 ${channel.views ?? '-'} · 영상 ${channel.videos ?? '-'}`);
  } catch (e) {
    log.warn(`채널통계 수집 실패: ${e.message}`);
    await alertBlocked({ reason: `구독자 수집 실패(${e.message})`, uploads: entries.length });
  }

  console.log(JSON.stringify({
    ok: true, mode: 'live', collected: records.length, missing,
    subscribers: channel?.subscribers ?? null, path: ANALYTICS_PATH,
  }));
}

if (process.argv[1] && process.argv[1].endsWith('analytics-collect.mjs')) {
  main().catch(e => { log.error(`치명 오류: ${e.message}`); process.exit(1); });
}
