/**
 * shorts/tts/edge.mjs — Microsoft Edge read-aloud(Edge-TTS) 무료 어댑터
 *
 * pip·ws 모듈 불필요: Node v24 글로벌 WebSocket(undici)로 WSS 직결 합성.
 * ko-KR 뉴럴 음성(예: ko-KR-SunHiNeural)을 mp3 로 받는다. SSML prosody(rate/pitch)
 * 완전 지원 — 평평한 AI 톤 제거의 (b) 무료 경로. config tts.provider='edge' 로 스왑.
 *
 * 프로토콜: speech.config(텍스트 프레임) → ssml(텍스트 프레임) → 서버가 바이너리 오디오
 * 청크(Path:audio) 스트리밍 → turn.end(텍스트 프레임)로 종료. Sec-MS-GEC 토큰 필수(없으면 403).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { probeDurationSec } from '../lib.mjs';

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';  // secret-scan: allow Edge TTS 공개 상수(모든 edge-tts 구현이 동일값 사용, 발급받는 키 아님)
const GEC_VERSION = '1-131.0.2903.86';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** Sec-MS-GEC 토큰: 5분 경계로 내린 유닉스초 → Windows filetime ticks → SHA256 대문자 hex. */
function secMsGec() {
  const ticks = (Math.floor(Date.now() / 1000 / 300) * 300 + 11644473600) * 1e7;
  const str = String(ticks) + TRUSTED_TOKEN;
  return createHash('sha256').update(str).digest('hex').toUpperCase();
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, e) {
  const voice = e.voice || 'ko-KR-SunHiNeural';
  const rate = e.rate || '+0%';
  const pitch = e.pitch || '+0Hz';
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ko-KR'>`
    + `<voice name='${voice}'>`
    + `<prosody rate='${rate}' pitch='${pitch}'>${xmlEscape(text)}</prosody>`
    + `</voice></speak>`;
}

/** 바이너리 프레임 파싱: [2B headerLen BE][header ascii][audio…]. Path:audio 인 것만 오디오. */
function parseBinaryFrame(buf) {
  if (buf.length < 2) return null;
  const headerLen = buf.readUInt16BE(0);
  const headerEnd = 2 + headerLen;
  if (headerEnd > buf.length) return null;
  const header = buf.slice(2, headerEnd).toString('utf8');
  if (!/Path:\s*audio/i.test(header)) return null;
  return buf.slice(headerEnd);
}

export async function synthEdge(text, outPath, cfg) {
  const e = cfg.tts?.edge || {};
  const timeoutMs = e.timeout_ms || 30000;
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
    + `?TrustedClientToken=${TRUSTED_TOKEN}`
    + `&Sec-MS-GEC=${secMsGec()}`
    + `&Sec-MS-GEC-Version=${GEC_VERSION}`;

  if (typeof WebSocket === 'undefined') {
    return { ok: false, error: '글로벌 WebSocket 부재(Node v20+ 필요)' };
  }

  let ws;
  try {
    // undici 글로벌 WebSocket 은 옵션 객체(headers)를 허용 — 지원 안 되면 무시됨.
    ws = new WebSocket(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
        'Origin': 'chrome-extension://jdiccldimpahsjabpkodkkdkmcnfaogd',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    try { ws = new WebSocket(url); } catch (err2) { return { ok: false, error: `WSS 연결 생성 실패: ${err2.message}` }; }
  }
  ws.binaryType = 'arraybuffer';

  const chunks = [];
  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: `타임아웃(${timeoutMs}ms)` }), timeoutMs);

    ws.onopen = () => {
      const ts = new Date().toISOString();
      const config = `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}`;
      const requestId = randomUUID().replace(/-/g, '');
      const ssml = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n`
        + buildSsml(text, e);
      try {
        ws.send(config);
        ws.send(ssml);
      } catch (err) {
        finish({ ok: false, error: `프레임 전송 실패: ${err.message}` });
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (/Path:\s*turn\.end/i.test(ev.data)) {
          if (!chunks.length) return finish({ ok: false, error: '오디오 없음(turn.end 시점 빈 버퍼)' });
          finish({ ok: true });
        }
        return;
      }
      const buf = Buffer.from(ev.data);
      const audio = parseBinaryFrame(buf);
      if (audio && audio.length) chunks.push(audio);
    };

    ws.onerror = (ev) => {
      finish({ ok: false, error: `WSS 오류: ${ev?.message || ev?.error?.message || 'connection error'}` });
    };
    ws.onclose = (ev) => {
      if (chunks.length) return finish({ ok: true });
      finish({ ok: false, error: `연결 종료(code=${ev?.code ?? '?'}${ev?.reason ? `, ${ev.reason}` : ''})` });
    };
  });

  if (!result.ok) return result;

  const audioBuf = Buffer.concat(chunks);
  if (!audioBuf.length) return { ok: false, error: '오디오 없음(빈 버퍼)' };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, audioBuf);
  const durationSec = probeDurationSec(outPath);
  if (!durationSec || durationSec <= 0) return { ok: false, error: '합성된 오디오 길이 0(무효)' };
  return { ok: true, durationSec };
}
