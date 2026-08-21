/**
 * hub/server.mjs — CEO 대시보드 웹 서버
 * stdlib http 전용 (express 금지). ESM named export.
 *
 * 주요 export:
 *   route(method, pathname, body, headers) → {status, json}   순수 라우팅 (단위 테스트용)
 *   handleRequest(req, res)                                     Node http 핸들러
 *   createHubServer()                                           http.Server 반환
 *   renderDashboard()                                           대시보드 HTML 문자열
 *   startServer(port)                                           포트 바인딩 + 로그
 */

import http from 'node:http';
import { URL } from 'node:url';

// store-supabase 어댑터 경유 — writer(commands/briefing)와 동일 백엔드에서 읽어야
// split-brain(Supabase write ↔ JSONL read) 을 피한다. 크리덴셜 없으면 JSONL 자동 폴백.
import { timeline, readRecords, latest }    from './store-supabase.mjs';
import { executeCommand, listSafeCommands } from './commands.mjs';
import { answerQuery }                      from './query.mjs';
import { generateBriefing }                 from './briefing.mjs';
import { env }                              from '../lib/config.mjs';
import { makeLogger }                       from '../lib/log.mjs';

import { isMainModule } from '../lib/main-module.mjs';
const log = makeLogger('hub/server');

// ─── 토큰 인증 ────────────────────────────────────────────────────────────────

/**
 * checkToken(headers, searchParams) → true(통과) | false(거부)
 * HUB_DASHBOARD_TOKEN 미설정 시 항상 통과 (로컬/mock 편의), 경고 로깅.
 * 설정된 경우: 헤더 x-hub-token 또는 쿼리 ?token= 이 일치해야 통과.
 */
function checkToken(headers, searchParams) {
  const required = env('HUB_DASHBOARD_TOKEN', '');
  if (!required) {
    log.warn('HUB_DASHBOARD_TOKEN 미설정 — 토큰 검증 건너뜀 (로컬/mock 모드)');
    return true;
  }
  const fromHeader = headers['x-hub-token'] ?? '';
  const fromQuery  = searchParams.get('token') ?? '';
  return fromHeader === required || fromQuery === required;
}

// ─── 읽기(GET) 인증 요구 여부 ────────────────────────────────────────────────
//
// GET 라우트는 원래 토큰이 필요 없다(로컬 대시보드 전제). 그런데 비루프백으로 바인딩하면 그 전제가
// 깨진다 — 같은 네트워크의 누구나 타임라인·브리핑·명령목록을 읽는다. 예전엔 기동 가드가 "토큰이
// 있으면 안전" 처럼 말했지만 **토큰은 POST 만 지킨다**(2026-08-19 리뷰 지적). 그래서 외부 바인딩일
// 때는 GET 에도 토큰을 요구한다. 루프백 기본값에서는 종전과 동일하게 무인증으로 편하게 쓴다.
let requireAuthForReads = false;
export function setRequireAuthForReads(v) { requireAuthForReads = !!v; }

// ─── 순수 라우팅 함수 (단위 테스트 가능) ─────────────────────────────────────

/**
 * route(method, pathname, body, headers) → Promise<{status, json}>
 *
 * GET 은 토큰 불요. POST(변경) 는 토큰 필수(HUB_DASHBOARD_TOKEN 설정 시).
 * body: 이미 파싱된 객체 또는 null.
 * headers: 소문자 키 객체.
 *
 * @param {string} method
 * @param {string} pathname  — 쿼리스트링 포함 가능 (ex: /api/timeline?token=x)
 * @param {object|null} body
 * @param {Record<string,string>} headers
 * @returns {Promise<{status:number, json:unknown}>}
 */
export async function route(method, pathname, body, headers) {
  // pathname 에 쿼리가 섞여 들어올 수 있으므로 URL 파싱
  let url;
  try {
    url = new URL(pathname, 'http://localhost');
  } catch {
    url = new URL('/', 'http://localhost');
  }
  const path   = url.pathname;
  const params = url.searchParams;

  // ── GET 엔드포인트 ──────────────────────────────────────────────────────────

  if (method === 'GET') {
    // 외부 바인딩 시에만 읽기도 토큰 필요(위 requireAuthForReads 주석 참고).
    if (requireAuthForReads && !checkToken(headers, params)) {
      return { status: 401, json: { error: 'unauthorized' } };
    }

    if (path === '/api/briefings') {
      const records = await readRecords('briefing', { limit: 20 });
      return { status: 200, json: records };
    }

    if (path === '/api/timeline') {
      const records = await timeline({ limit: 50 });
      return { status: 200, json: records };
    }

    if (path === '/api/commands') {
      const cmds = listSafeCommands();
      return { status: 200, json: cmds };
    }

    // 알 수 없는 GET
    return { status: 404, json: { error: '알 수 없는 경로', path } };
  }

  // ── POST 엔드포인트 ─────────────────────────────────────────────────────────

  if (method === 'POST') {
    // 모든 POST 는 토큰 검증
    if (!checkToken(headers, params)) {
      return { status: 401, json: { error: 'unauthorized' } };
    }

    if (path === '/api/command') {
      const { type, args } = body ?? {};

      // 안전 명령 화이트리스트 검사 (executeCommand 도 하지만 여기서 먼저 거부)
      const safeKeys = listSafeCommands().map(c => c.key);
      if (!type || !safeKeys.includes(type)) {
        return { status: 400, json: { rejected: true, reason: `허용되지 않은 명령: '${type}'` } };
      }

      const result = await executeCommand({ type, args: args ?? {}, actor: 'ceo-dashboard' });
      const status = result.rejected ? 400 : 200;
      return { status, json: result };
    }

    if (path === '/api/query') {
      const question = body?.question ?? '';
      const result   = answerQuery(question);
      return { status: 200, json: result };
    }

    if (path === '/api/refresh') {
      // 브리핑 갱신 후 최신 브리핑 반환
      await generateBriefing();
      const record = await latest('briefing');
      return { status: 200, json: record };
    }

    // 알 수 없는 POST
    return { status: 404, json: { error: '알 수 없는 경로', path } };
  }

  // ── 지원하지 않는 메서드 ────────────────────────────────────────────────────
  return { status: 405, json: { error: '지원하지 않는 HTTP 메서드', method } };
}

// ─── 대시보드 HTML ────────────────────────────────────────────────────────────

/**
 * renderDashboard() → HTML 문자열
 * 외부 CDN 없이 인라인 <style>·<script> 만 사용.
 * 5초 주기 자동 새로고침, 명령 버튼 3종, 질의창 포함.
 */
export function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>블로그 파이프라인 대시보드</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0f1117; color: #e2e8f0;
      min-height: 100vh;
    }
    header {
      background: #1a1d2e; border-bottom: 1px solid #2d3748;
      padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem;
    }
    header h1 { margin: 0; font-size: 1.25rem; color: #63b3ed; }
    .badge {
      font-size: 0.7rem; padding: 2px 8px; border-radius: 999px;
      background: #2d3748; color: #a0aec0; letter-spacing: .5px;
    }
    .badge.live { background: #22543d; color: #68d391; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.6} }

    main { padding: 1.5rem 2rem; display: grid; gap: 1.5rem;
           grid-template-columns: 1fr 1fr; }
    @media(max-width:768px){ main { grid-template-columns: 1fr; } }

    .card {
      background: #1a1d2e; border: 1px solid #2d3748;
      border-radius: 0.75rem; padding: 1.25rem;
    }
    .card h2 { margin: 0 0 0.75rem; font-size: 0.9rem;
               text-transform: uppercase; letter-spacing: .5px; color: #90cdf4; }
    .full-width { grid-column: 1/-1; }

    /* 브리핑 섹션 */
    .briefing-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    @media(max-width:600px){ .briefing-grid { grid-template-columns: 1fr; } }
    .section-box {
      background: #171923; border: 1px solid #2d3748; border-radius: 0.5rem;
      padding: 0.75rem; min-height: 80px;
    }
    .section-box h3 { margin: 0 0 0.4rem; font-size: 0.8rem; color: #a0aec0; }
    .section-box p  { margin: 0; font-size: 0.85rem; line-height: 1.5; }

    /* 타임라인 */
    .timeline-list { list-style: none; margin: 0; padding: 0; max-height: 320px;
                     overflow-y: auto; }
    .timeline-list li {
      display: flex; gap: 0.75rem; align-items: flex-start;
      padding: 0.5rem 0; border-bottom: 1px solid #2d3748; font-size: 0.82rem;
    }
    .timeline-list li:last-child { border-bottom: none; }
    .tl-ts { color: #718096; flex-shrink: 0; width: 140px; }
    .tl-type {
      flex-shrink: 0; font-size: 0.7rem; padding: 1px 6px; border-radius: 4px;
      background: #2d3748; color: #90cdf4;
    }
    .tl-body { flex: 1; color: #cbd5e0; }

    /* 명령 버튼 */
    .cmd-row { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 0.75rem; }
    button {
      cursor: pointer; border: none; border-radius: 0.4rem;
      padding: 0.4rem 0.9rem; font-size: 0.82rem; transition: filter .15s;
    }
    button:hover { filter: brightness(1.15); }
    .btn-pause  { background: #9b2c2c; color: #fff; }
    .btn-resume { background: #276749; color: #fff; }
    .btn-approve{ background: #2b6cb0; color: #fff; }
    .btn-reject { background: #553c9a; color: #fff; }
    .btn-rerun  { background: #7b341e; color: #fff; }
    .btn-refresh{ background: #2d3748; color: #a0aec0; font-size: 0.75rem; }
    .btn-send   { background: #2b6cb0; color: #fff; padding: 0.4rem 1.2rem; }

    /* 토큰 입력 */
    .token-row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
    .token-row label { font-size: 0.8rem; color: #a0aec0; white-space: nowrap; }
    input[type=text], input[type=password], textarea {
      background: #171923; border: 1px solid #4a5568; color: #e2e8f0;
      border-radius: 0.4rem; padding: 0.35rem 0.6rem; font-size: 0.85rem;
      font-family: inherit; outline: none;
    }
    input[type=password] { flex: 1; }
    input[type=text] { width: 100%; }
    textarea { width: 100%; resize: vertical; min-height: 60px; }

    /* 질의 */
    .query-row { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .query-row input { flex: 1; }

    /* 결과 박스 */
    .result-box {
      background: #171923; border: 1px solid #2d3748; border-radius: 0.5rem;
      padding: 0.75rem; margin-top: 0.75rem; font-size: 0.85rem;
      white-space: pre-wrap; word-break: break-word; min-height: 40px;
      max-height: 180px; overflow-y: auto; color: #cbd5e0;
    }
    .result-box.error { border-color: #9b2c2c; color: #fc8181; }

    .status-bar {
      grid-column: 1/-1; font-size: 0.75rem; color: #718096;
      text-align: right;
    }
  </style>
</head>
<body>
<header>
  <h1>블로그 파이프라인 대시보드</h1>
  <span class="badge live" id="live-badge">● LIVE</span>
  <span class="badge" id="last-refresh">–</span>
</header>

<main>
  <!-- 브리핑 4섹션 -->
  <div class="card full-width">
    <h2>최신 브리핑</h2>
    <div class="briefing-grid">
      <div class="section-box">
        <h3>어제 요약</h3>
        <p id="sec-yesterday">로드 중…</p>
      </div>
      <div class="section-box">
        <h3>예산 현황</h3>
        <p id="sec-budget">로드 중…</p>
      </div>
      <div class="section-box">
        <h3>주의 / 이상 알람</h3>
        <p id="sec-alerts">로드 중…</p>
      </div>
      <div class="section-box">
        <h3>결정 필요 건</h3>
        <p id="sec-decisions">로드 중…</p>
      </div>
    </div>
  </div>

  <!-- 타임라인 -->
  <div class="card">
    <h2>누적 타임라인</h2>
    <ul class="timeline-list" id="timeline-list">
      <li><span class="tl-body">로드 중…</span></li>
    </ul>
  </div>

  <!-- 명령 패널 -->
  <div class="card">
    <h2>CEO 명령 패널</h2>
    <div class="token-row">
      <label>토큰</label>
      <input type="password" id="token-input" placeholder="HUB_DASHBOARD_TOKEN (없으면 공란)" />
    </div>
    <div class="cmd-row">
      <button class="btn-pause"   onclick="sendCmd('pause_resume',{action:'pause'})">멈춰 (일시중단)</button>
      <button class="btn-resume"  onclick="sendCmd('pause_resume',{action:'resume'})">재개</button>
      <button class="btn-approve" onclick="sendCmd('topic_decision',{choice:'approve'})">주제 승인</button>
      <button class="btn-reject"  onclick="sendCmd('topic_decision',{choice:'reject'})">주제 거부</button>
      <button class="btn-rerun"   onclick="sendCmd('rerun',{target:'last'})">재실행 (last)</button>
      <button class="btn-refresh" onclick="doRefresh()">브리핑 갱신</button>
    </div>
    <div class="result-box" id="cmd-result">명령 결과가 여기에 표시됩니다.</div>

    <!-- 질의 -->
    <h2 style="margin-top:1.25rem">CEO 질의</h2>
    <div class="query-row">
      <input type="text" id="query-input" placeholder="예: 예산 어때? / 오늘 발행 몇 편?" />
      <button class="btn-send" onclick="sendQuery()">전송</button>
    </div>
    <div class="result-box" id="query-result">질의 결과가 여기에 표시됩니다.</div>
  </div>

  <div class="status-bar" id="status-bar">–</div>
</main>

<script>
  // ─── 토큰 헬퍼 ─────────────────────────────────────────────────────────────
  function getToken() {
    return document.getElementById('token-input').value.trim();
  }

  function postHeaders() {
    const h = { 'Content-Type': 'application/json; charset=utf-8' };
    const t = getToken();
    if (t) h['x-hub-token'] = t;
    return h;
  }

  // ─── 결과 표시 ──────────────────────────────────────────────────────────────
  /** HTML 이스케이프 — innerHTML 조립부 전용(레코드 텍스트는 신뢰 불가 입력). */
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function showResult(id, data, isErr) {
    const el = document.getElementById(id);
    el.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    el.className   = 'result-box' + (isErr ? ' error' : '');
  }

  // ─── 브리핑 로드 ────────────────────────────────────────────────────────────
  async function loadBriefings() {
    try {
      const res  = await fetch('/api/briefings');
      const list = await res.json();
      const b    = list[0] ?? null;

      const yesterday = b?.yesterday ?? b?.sections?.yesterday ?? null;
      const budget    = b?.budget    ?? b?.sections?.budget    ?? null;
      const alerts    = b?.alerts    ?? b?.sections?.alerts    ?? null;
      const decisions = b?.decisions ?? b?.sections?.decisions ?? null;

      // 객체/배열을 사람이 읽을 한 줄로 — [object Object] 방지
      const line = (it) => {
        if (it == null) return '';
        if (typeof it === 'string') return '• ' + it;
        if (it.detail)  return '• ' + (it.type ? '[' + it.type + '] ' : '') + it.detail;
        if (it.item)    return '• ' + it.item + (Array.isArray(it.options) ? ' (' + it.options.join('/') + ')' : '');
        return '• ' + JSON.stringify(it);
      };
      const fmtArr = (arr, empty) => arr.length ? arr.map(line).join('\\n') : empty;
      const fmtObj = (o) => Object.entries(o).map(([k, v]) =>
        k + ': ' + (Array.isArray(v) ? v.join(', ') : (v == null ? '—' : v))).join('\\n');

      document.getElementById('sec-yesterday').textContent =
        yesterday ? (typeof yesterday === 'object' ? fmtObj(yesterday) : String(yesterday)) : '데이터 없음';
      document.getElementById('sec-budget').textContent =
        budget    ? (typeof budget === 'object' ? fmtObj(budget) : String(budget)) : '데이터 없음';
      document.getElementById('sec-alerts').textContent =
        Array.isArray(alerts)   ? fmtArr(alerts, '이상 없음')
        : (alerts ? JSON.stringify(alerts) : '데이터 없음');
      document.getElementById('sec-decisions').textContent =
        Array.isArray(decisions) ? fmtArr(decisions, '결정 대기 없음')
        : (decisions ? JSON.stringify(decisions) : '데이터 없음');
    } catch (e) {
      ['sec-yesterday','sec-budget','sec-alerts','sec-decisions']
        .forEach(id => document.getElementById(id).textContent = '로드 실패: ' + e.message);
    }
  }

  // ─── 타임라인 로드 ──────────────────────────────────────────────────────────
  async function loadTimeline() {
    try {
      const res  = await fetch('/api/timeline');
      const list = await res.json();
      const ul   = document.getElementById('timeline-list');
      if (!list.length) {
        ul.innerHTML = '<li><span class="tl-body">기록 없음</span></li>';
        return;
      }
      // esc 필수(2026-08-19): 타임라인 레코드는 에이전트 산출물·봇 메시지에서 오고, 그 원재료는
      // Reddit/HN 수집물과 LLM 출력이다. 이스케이프 없이 innerHTML 에 넣으면 레코드 한 건으로
      // 대시보드에서 스크립트가 실행된다 — 같은 화면의 토큰 입력값을 읽어 POST 명령(파이프라인
      // 중단·주제 승인)까지 낼 수 있으므로 단순 표시 문제가 아니다.
      ul.innerHTML = list.map(r => {
        const ts   = r.ts ? r.ts.replace('T',' ').slice(0,19) : '';
        const type = r.type ?? '?';
        const body = r.answer ?? r.question ?? r.kind ?? r.status ?? JSON.stringify(r).slice(0,80);
        return \`<li>
          <span class="tl-ts">\${esc(ts)}</span>
          <span class="tl-type">\${esc(type)}</span>
          <span class="tl-body">\${esc(body)}</span>
        </li>\`;
      }).join('');
    } catch (e) {
      document.getElementById('timeline-list').innerHTML =
        '<li><span class="tl-body">로드 실패: ' + esc(e.message) + '</span></li>';
    }
  }

  // ─── 명령 전송 ──────────────────────────────────────────────────────────────
  async function sendCmd(type, args) {
    showResult('cmd-result', '전송 중…', false);
    try {
      const res  = await fetch('/api/command', {
        method: 'POST', headers: postHeaders(),
        body: JSON.stringify({ type, args }),
      });
      const data = await res.json();
      showResult('cmd-result', data, !res.ok);
    } catch (e) {
      showResult('cmd-result', '오류: ' + e.message, true);
    }
  }

  // ─── 브리핑 갱신 ────────────────────────────────────────────────────────────
  async function doRefresh() {
    showResult('cmd-result', '브리핑 갱신 중…', false);
    try {
      const res  = await fetch('/api/refresh', {
        method: 'POST', headers: postHeaders(), body: '{}',
      });
      const data = await res.json();
      showResult('cmd-result', data, !res.ok);
      await loadBriefings();
    } catch (e) {
      showResult('cmd-result', '갱신 실패: ' + e.message, true);
    }
  }

  // ─── 질의 전송 ──────────────────────────────────────────────────────────────
  async function sendQuery() {
    const question = document.getElementById('query-input').value.trim();
    if (!question) return;
    showResult('query-result', '응답 중…', false);
    try {
      const res  = await fetch('/api/query', {
        method: 'POST', headers: postHeaders(),
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      showResult('query-result', data.answer ?? JSON.stringify(data), !res.ok);
    } catch (e) {
      showResult('query-result', '오류: ' + e.message, true);
    }
  }

  // ─── 엔터키 질의 ────────────────────────────────────────────────────────────
  document.getElementById('query-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendQuery();
  });

  // ─── 자동 새로고침 (5초) ────────────────────────────────────────────────────
  async function refresh() {
    await Promise.all([loadBriefings(), loadTimeline()]);
    const now = new Date().toLocaleTimeString('ko-KR');
    document.getElementById('last-refresh').textContent = '갱신: ' + now;
    document.getElementById('status-bar').textContent   = '마지막 갱신: ' + now;
  }

  refresh();
  setInterval(refresh, 5000);
</script>
</body>
</html>`;
}

// ─── HTTP 핸들러 ──────────────────────────────────────────────────────────────

/**
 * handleRequest(req, res) — Node http.createServer 에 직접 넘기는 핸들러.
 * req body 를 읽어 JSON 파싱 후 route() 호출, 결과를 JSON 또는 HTML 로 응답.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse}  res
 */
export async function handleRequest(req, res) {
  const method = req.method?.toUpperCase() ?? 'GET';

  // 대시보드 HTML 서빙 (인증 불요)
  if (method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = renderDashboard();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return;
  }

  // req body 읽기 (POST)
  let body = null;
  if (method === 'POST') {
    body = await new Promise((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { raw += chunk; });
      req.on('end',  () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', reject);
    });
  }

  // 소문자 헤더 맵 생성
  const headers = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }

  // pathname 에 query 포함 전달 (checkToken 이 params.get('token') 을 사용하므로)
  const pathname = req.url ?? '/';

  let result;
  try {
    result = await route(method, pathname, body, headers);
  } catch (err) {
    log.error(`route 처리 오류: ${err.message}`, err);
    result = { status: 500, json: { error: '내부 서버 오류', message: err.message } };
  }

  res.writeHead(result.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(result.json));
}

// ─── 서버 팩토리 ─────────────────────────────────────────────────────────────

/**
 * createHubServer() → http.Server
 * 테스트가 handleRequest 를 직접 써도 되고, 포트 바인딩을 원하면 .listen() 호출.
 */
export function createHubServer() {
  return http.createServer(handleRequest);
}

// ─── 기동 헬퍼 ───────────────────────────────────────────────────────────────

/**
 * startServer(port) → http.Server (listening)
 * port 생략 시 HUB_PORT 환경변수, 기본 8787.
 */
export function startServer(port, host) {
  const p = port ?? (Number(env('HUB_PORT', '8787')) || 8787);
  // 바인딩 주소(2026-08-19 보안 조치): 기본 루프백.
  // 예전엔 listen(port) 만 호출해 **0.0.0.0(전 인터페이스)** 에 열렸다 — 로그만 "localhost" 라고
  // 찍혀서 로컬 전용처럼 보였다. GET 라우트는 설계상 토큰이 필요 없으므로(타임라인·레코드·브리핑
  // 전부 조회 가능) 같은 네트워크(WSL2 라면 윈도우 호스트·LAN)의 누구나 운영 데이터를 읽을 수 있었다.
  const h = host ?? env('HUB_HOST', '127.0.0.1');
  const loopback = h === '127.0.0.1' || h === 'localhost' || h === '::1';
  // 외부에 노출할 의도라면(HUB_HOST 를 명시적으로 바꾼 경우) 토큰 없이는 기동을 거부한다.
  // 토큰 미설정 시 checkToken 이 통과로 fail-open 하므로, 그 조합은 무인증 공개와 같다.
  if (!loopback && !env('HUB_DASHBOARD_TOKEN', '')) {
    throw new Error(
      `HUB_HOST=${h} (비루프백) 로 기동하려면 HUB_DASHBOARD_TOKEN 이 필요하다 — ` +
      '토큰 없이 외부 바인딩하면 대시보드·API 가 무인증으로 공개된다.'
    );
  }
  // 외부 바인딩이면 읽기(GET)도 토큰을 요구한다. 토큰은 원래 POST 만 지켰으므로, 이걸 켜지 않으면
  // "토큰 설정했으니 안전" 이 거짓이 된다(타임라인·브리핑이 그대로 열림).
  setRequireAuthForReads(!loopback);
  const server = createHubServer();
  server.listen(p, h, () => {
    log.info(`허브 대시보드 기동 완료 — http://${h}:${p}`);
    console.log(`[hub/server] 대시보드: http://${h}:${p}`);
  });
  return server;
}

// ─── CLI 진입점 ──────────────────────────────────────────────────────────────
const isCLI = isMainModule(import.meta.url);
if (isCLI) {
  const port = Number(env('HUB_PORT', '8787')) || 8787;
  try {
    startServer(port);
  } catch (e) {
    console.error(`[hub/server] 기동 거부: ${e.message}`);
    process.exit(2);
  }
}
