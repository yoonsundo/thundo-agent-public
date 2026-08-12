/**
 * shorts/tts/index.mjs — TTS 어댑터 디스패치
 *
 * provider 를 config(tts.provider)로 스왑한다: 'google' | 'edge' | 'elevenlabs'.
 * edge=무료 Microsoft Edge-TTS(WSS, SSML prosody 완전지원). google=Chirp3-HD(문장부호
 * 기반 자연 pause). elevenlabs=유료 폴백. 각 어댑터는 synth(text, outPath, cfg) → durationSec.
 */
import { synthGoogle } from './google.mjs';
import { synthEdge } from './edge.mjs';
import { synthElevenlabs } from './elevenlabs.mjs';

const ADAPTERS = { google: synthGoogle, edge: synthEdge, elevenlabs: synthElevenlabs };

/**
 * 한 문장(또는 카드 narration)을 mp3 로 합성.
 * @returns {Promise<{ok:boolean, durationSec?:number, error?:string}>}
 */
export async function synthesize(text, outPath, cfg) {
  const provider = cfg.tts?.provider || 'google';
  const fn = ADAPTERS[provider];
  if (!fn) return { ok: false, error: `알 수 없는 TTS provider: ${provider}` };
  if (!text || !text.trim()) return { ok: false, error: '빈 텍스트' };
  return fn(text.trim(), outPath, cfg);
}

export function activeProvider(cfg) { return cfg.tts?.provider || 'google'; }
