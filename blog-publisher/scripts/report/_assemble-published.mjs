// _assemble-published.mjs — enriched draft → published/<date>-<slug>.md
// 사용: node scripts/report/_assemble-published.mjs <draftPath> <cover> <alt> <by>
import { readFileSync, writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const [draftPath, cover, alt, by] = process.argv.slice(2);
const text = readFileSync(draftPath, 'utf8');
const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) { console.error('frontmatter 파싱 실패'); process.exit(2); }
const fm = yaml.load(m[1]);
const body = m[2].replace(/^\s+/, '');
const syll = (body.match(/[가-힣]/g) || []).length;

const out = {
  title: fm.title,
  date: fm.date,
  status: 'published',
  slug: fm.slug,
  writer: fm.writer,
  char_count: syll,
  tags: fm.tags,
  description: fm.description,
  source_refs: fm.source_refs,
};
if (cover && cover !== '-') out.cover_image = cover;
if (alt && alt !== '-') out.image_alt = alt;
if (by && by !== '-') out.image_by = by;

const fmStr = yaml.dump(out, { lineWidth: -1, quotingType: '"', forceQuotes: false, noRefs: true });
const outPath = `published/${fm.date}-${fm.slug}.md`;
writeFileSync(outPath, `---\n${fmStr}---\n\n${body}`);
console.log(`WROTE ${outPath} (음절 ${syll})`);
