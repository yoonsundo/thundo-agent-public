// enrich-images.mjs — 글 1편에 이미지를 풍성하게: 커버(듀얼+judge) + 본문 섹션 삽화 N장.
// 삽화는 designGemini(agy=구독)로 섹션 제목을 미니 주제 삼아 생성. 전부 구독, API키 0.
// blog-db 가 본문 내 /images 참조도 data URI 로 임베드하므로, 본문에 ![alt](/images/x.svg) 삽입만 하면 됨.
import { makeCover } from './make-cover.mjs';
import { designGemini } from './gemini-designer.mjs';

// 본문(마크다운)에서 H2 헤딩 추출
function h2Headings(body) {
  return [...body.matchAll(/^##\s+(.+)$/gm)].map(m => m[1].trim());
}

/**
 * 커버 + 섹션 삽화 생성 후, 본문에 삽화 마크다운을 삽입한 새 body 반환.
 * @returns {Promise<{cover:object|null, body:string, inlineCount:number}>}
 */
export async function enrichImages(slug, title, body, { sections = 2 } = {}) {
  process.env.IMAGE_LIVE = '1'; // 실 디자이너(구독) 강제
  // 1) 커버 (듀얼+judge)
  const cover = await makeCover(slug, title, body).catch(() => null);

  // 2) 섹션 삽화 — 본문 H2 중 균등 분포로 골라 designGemini(agy)로 생성
  // 멱등성: 이미 삽입된 inline /images 삽화가 있으면 제거 후 재삽입(이중 enrich 중복 방지).
  const cleanBody = body.replace(/\n*!\[[^\]]*\]\(\/images\/[^)]+\)\n*/g, '\n\n');
  const heads = h2Headings(cleanBody);
  let newBody = cleanBody;
  let inlineCount = 0;
  if (heads.length >= 2 && sections > 0) {
    // 첫 섹션은 커버와 가까우니 건너뛰고, 중간 섹션들에 배치
    const picks = [];
    const step = Math.max(1, Math.floor(heads.length / (sections + 1)));
    for (let i = 1; i <= sections && i * step < heads.length; i++) picks.push(heads[i * step]);

    for (let i = 0; i < picks.length; i++) {
      const heading = picks[i];
      const secSlug = `${slug}-sec${i + 1}`;
      // draft.slug 에도 secSlug 를 넘겨야 resolveSlug 가 고유 파일명(<secSlug>.gemini.svg) 생성 — 섹션마다 다른 삽화.
      const cand = await designGemini({ title: `${title} — ${heading}`, slug: secSlug }, { title, slug: secSlug, content: body }).catch(() => null);
      const path = cand && cand.meta && cand.meta.public;
      if (!path) continue;
      // 해당 H2 라인 다음에 삽화 마크다운 삽입
      const re = new RegExp(`(^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$)`, 'm');
      if (re.test(newBody)) {
        newBody = newBody.replace(re, `$1\n\n![${heading}](${path})`);
        inlineCount++;
      }
    }
  }
  return { cover, body: newBody, inlineCount };
}
