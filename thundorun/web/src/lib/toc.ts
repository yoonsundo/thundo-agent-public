// toc.ts — 블로그 본문 HTML에서 H2·H3 헤딩을 추출해 목차를 만들고,
// 앵커 점프가 가능하도록 헤딩에 id를 주입한다. 서버 전용(정규식 기반, DOM 불필요 —
// HtmlView/sanitize 가 jsdom 을 피하는 것과 동일한 serverless-safe 방식).

export interface TocHeading {
  depth: number; // 2 | 3
  slug: string;
  text: string;
}

// 한글·라틴·숫자를 보존하는 slugify (github-slugger 기본 동작에 준함).
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // 글자(한글 포함)·숫자·공백·하이픈만 유지
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 본문 HTML 에서 H2·H3 를 추출하고, id 없는 헤딩엔 고유 id 를 주입한다.
 * 반환: { html: id가 주입된 HTML, headings: 목차 항목 }
 */
export function buildToc(html: string): { html: string; headings: TocHeading[] } {
  const headings: TocHeading[] = [];
  const used = new Set<string>();

  const out = String(html ?? '').replace(
    /<(h[23])([^>]*)>([\s\S]*?)<\/\1>/gi,
    (match, tag: string, attrs: string, inner: string) => {
      const depth = tag.toLowerCase() === 'h2' ? 2 : 3;
      const text = inner
        .replace(/<[^>]+>/g, '') // 내부 인라인 태그 제거
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) return match;

      // 이미 id 가 있으면 그대로 사용, 없으면 텍스트 기반으로 생성.
      const existing = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
      let slug = existing ? existing[1] : slugify(text) || `section-${headings.length + 1}`;

      if (!existing) {
        let unique = slug;
        let i = 1;
        while (used.has(unique)) unique = `${slug}-${i++}`;
        slug = unique;
      }
      used.add(slug);
      headings.push({ depth, slug, text });

      if (existing) return match;
      return `<${tag}${attrs} id="${slug}">${inner}</${tag}>`;
    },
  );

  return { html: out, headings };
}
