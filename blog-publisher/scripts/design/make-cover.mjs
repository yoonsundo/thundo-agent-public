// make-cover.mjs — 커버 이미지 듀얼+judge 래퍼. 발행 흐름이 한 번 호출하면 끝.
// Claude(claude CLI=구독) vs Gemini(agy=Google AI Pro 구독) SVG 후보 → judge 가 더 어울리는 것 선택.
// 둘 다 구독 기반(API 키 불필요). 실패해도 발행을 막지 않게 null 반환(비차단).
import { designClaude } from './claude-designer.mjs';
import { designGemini } from './gemini-designer.mjs';
import { judgeImages } from './judge.mjs';

/**
 * @returns {Promise<{cover_image:string, image_alt:string, image_by:string}|null>}
 */
export async function makeCover(slug, title, body) {
  if (!title || !slug) return null;
  // 실 디자이너 강제(구독): claude-designer/gemini-designer 가 mock 대신 claude CLI·agy 사용.
  // (IMAGE_LIVE=1 이 isMock() 을 오버라이드 — no-mock 원칙)
  process.env.IMAGE_LIVE = '1';
  const topic = { title, slug };
  const draft = { title, slug, content: body || '' };
  const [c, g] = await Promise.all([
    designClaude(topic, draft).catch(e => { console.error('[make-cover] claude-designer:', e.message); return null; }),
    designGemini(topic, draft).catch(e => { console.error('[make-cover] gemini-designer(agy):', e.message); return null; }),
  ]);
  const candidates = [c, g].filter(Boolean);
  if (!candidates.length) { console.error('[make-cover] 후보 0 — 커버 없이 발행'); return null; }
  const result = await judgeImages(candidates, draft).catch(e => { console.error('[make-cover] judge:', e.message); return null; });
  const winner = result && result.winner;
  if (!winner) { console.error('[make-cover] judge winner 없음'); return null; }
  console.log(`[make-cover] 커버 선택: by=${winner.by}`);
  return {
    cover_image: (winner.meta && winner.meta.public) || winner.path || null,
    image_alt: winner.alt || title,
    image_by: winner.by || null,
  };
}
