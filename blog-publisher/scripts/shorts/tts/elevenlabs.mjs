/**
 * shorts/tts/elevenlabs.mjs — ElevenLabs TTS 어댑터 (유료 폴백)
 *
 * 무료(Google) 품질이 "AI 티" 기준에 못 미칠 때 config tts.provider='elevenlabs'
 * 로 스왑하는 폴백. ELEVENLABS_API_KEY + voice_id 필요. 없으면 명확한 에러.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { probeDurationSec } from '../lib.mjs';

export async function synthElevenlabs(text, outPath, cfg) {
  const e = cfg.tts?.elevenlabs || {};
  const apiKey = process.env[e.api_key_env || 'ELEVENLABS_API_KEY'];
  if (!apiKey) return { ok: false, error: `${e.api_key_env || 'ELEVENLABS_API_KEY'} 미설정` };
  if (!e.voice_id) return { ok: false, error: 'elevenlabs voice_id 미설정(config)' };
  let res;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${e.voice_id}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: e.model || 'eleven_multilingual_v2' }),
    });
  } catch (err) { return { ok: false, error: `네트워크 오류: ${err.message}` }; }
  if (res.status !== 200) {
    let msg = `HTTP ${res.status}`;
    try { msg += ` — ${(await res.text()).slice(0, 200)}`; } catch {}
    return { ok: false, error: msg };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  return { ok: true, durationSec: probeDurationSec(outPath) };
}
