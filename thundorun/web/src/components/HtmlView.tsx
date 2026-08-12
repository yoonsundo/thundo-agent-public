// HtmlView.tsx - semantic HTML body renderer (read view).
// content is an HTML string sanitized with a serverless-safe regex sanitizer
// (no jsdom). isomorphic-dompurify pulled jsdom -> html-encoding-sniffer ->
// @exodus/bytes (ESM) which crashes on Vercel serverless with ERR_REQUIRE_ESM.
// Blog bodies already pass the render-fit gate before publish, so the light
// sanitizer here is defense-in-depth.
// Typography comes entirely from the kit's `.article` class (DESIGN.md §11.3) —
// individual markdown/HTML elements are not styled here.
import { sanitizeHtml } from '@/lib/sanitize';

interface Props {
  content: string;
}

export default function HtmlView({ content }: Props) {
  const clean = sanitizeHtml(content);

  return <div className="article" dangerouslySetInnerHTML={{ __html: clean }} />;
}
