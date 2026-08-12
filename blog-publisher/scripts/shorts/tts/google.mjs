/**
 * shorts/tts/google.mjs — Google Cloud Text-to-Speech 어댑터
 *
 * 기존 GSC 서비스계정(~/.secrets/gsc-sa.json)을 그대로 재사용(새 OAuth 불필요).
 * ko-KR Chirp3-HD 자연 음성. google-auth-library 로 access token 발급 후 REST 호출.
 *
 * ⚠ 프로젝트에 Cloud Text-to-Speech API 사용설정 필요(1회):
 *   gcloud services enable texttospeech.googleapis.com --project=<pid>
 * 미사용시 403 SERVICE_DISABLED → 명확한 에러로 반환.
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { expandHome, probeDurationSec } from '../lib.mjs';
import { normalizeForTTS } from './normalize.mjs';

/**
 * applyProsody — 프로소디 텍스트 전처리(순수 함수, 실패 불가 경로).
 *
 * ⚠ 완전한 SSML prosody(rate/pitch/break)는 edge 어댑터가 담당한다. Google Chirp3-HD 는
 * SSML 을 거부/무시할 수 있어(파괴 위험) 여기선 SSML 로 감싸지 않는다. 대신 Chirp3 가
 * 문장부호로 만드는 자연 억양·쉼(pause)을 안정적으로 유도하도록 텍스트만 정규화한다:
 *  - 공백/개행 정리(문장 끝·쉼표 뒤 단일 공백)
 *  - 문장 끝 종결부호 보장(없으면 마침표 → 카드 끝 자연 pause 유도)
 *  - 반복 종결부호(!!, .. 등)·과한 나열 쉼표 완화
 * @param {string} text
 * @param {object} cfg
 * @returns {string} 정규화 텍스트(프로소디 off 이거나 결함 시 원문 반환)
 */
export function applyProsody(text, cfg) {
  if (!cfg?.tts?.prosody?.enabled) return text;
  if (typeof text !== 'string' || !text.trim()) return text;
  let t = text
    .replace(/\r\n?/g, '\n')            // CRLF → LF
    .replace(/[ \t]+/g, ' ')           // 수평 공백 축약
    .replace(/\n{2,}/g, '\n')          // 다중 개행 축약
    .replace(/\s*\n\s*/g, ' ')         // 개행을 공백 경계로 평탄화
    .trim();
  // 반복 종결부호 완화: !!!/??? → 단일(단, 말줄임표 …/... 은 보존)
  t = t.replace(/([!?。])\1+/g, '$1').replace(/(?<!\.)\.\.(?!\.)/g, '.');
  // 문장부호 뒤 단일 공백 정규화(문장 끝·쉼표). 부호 앞 공백 제거.
  t = t.replace(/\s*([,，、])\s*/g, '$1 ')
       .replace(/\s*([.!?])\s+/g, '$1 ')
       .trim();
  // 문장 끝 종결부호 보장 → 카드 끝 자연 pause
  if (t && !/[.!?…。]$/.test(t)) t += '.';
  return t || text;
}

let _tokenClient = null;
async function getToken(keyFile) {
  if (!_tokenClient) {
    _tokenClient = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const client = await _tokenClient.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Google access token 발급 실패');
  return token;
}

export async function synthGoogle(text, outPath, cfg) {
  const g = cfg.tts?.google || {};
  const keyFile = expandHome(g.key_file || '~/.secrets/gsc-sa.json');
  try {
    JSON.parse(readFileSync(keyFile, 'utf8')); // 존재/유효성 조기 확인
  } catch {
    return { ok: false, error: `서비스계정 키 없음/손상: ${keyFile}` };
  }
  let token;
  try { token = await getToken(keyFile); }
  catch (e) { return { ok: false, error: `인증 실패: ${e.message}` }; }

  // 프로소디: SSML 없이 문장부호 기반 자연 pause 만 유도(Chirp3 파괴 방지). 실패 불가.
  // 이어서 발음 정규화(약어·기호·단위 → 한글 발음)로 딕션 뭉개짐 방지. 말하는 텍스트에만 적용.
  const spoken = normalizeForTTS(applyProsody(text, cfg));

  const body = {
    input: { text: spoken },
    voice: { languageCode: g.language_code || 'ko-KR', name: g.voice || 'ko-KR-Chirp3-HD-Aoede' },
    audioConfig: {
      audioEncoding: g.encoding || 'MP3',
      speakingRate: g.speaking_rate || 1.0,
      sampleRateHertz: g.sample_rate || 24000,
    },
  };
  let res;
  try {
    res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) { return { ok: false, error: `네트워크 오류: ${e.message}` }; }

  if (res.status !== 200) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error?.message) msg += ` — ${j.error.message.slice(0, 200)}`; } catch {}
    return { ok: false, error: msg };
  }
  let j;
  try { j = await res.json(); } catch { return { ok: false, error: '응답 JSON 파싱 실패' }; }
  if (!j.audioContent) return { ok: false, error: '오디오 없음(audioContent 부재)' };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(j.audioContent, 'base64'));
  return { ok: true, durationSec: probeDurationSec(outPath) };
}
