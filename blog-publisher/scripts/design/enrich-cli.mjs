// enrich-cli.mjs — 초안 파일에 이미지(커버+섹션삽화)를 입히는 CLI 래퍼.
// 사용: node scripts/design/enrich-cli.mjs <draft.md> [sections]
// 동작: 초안 본문에 섹션 삽화 마크다운을 삽입(in place) + 커버 정보를 stdout JSON 으로 출력.
// 호출부(런북/스크립트)는 그 cover 를 발행 frontmatter 에 cover_image/image_alt/image_by 로 부착.
import { readFileSync, writeFileSync } from 'node:fs';
import { enrichImages } from './enrich-images.mjs';

const draftFile = process.argv[2];
const sections = parseInt(process.argv[3] || '2', 10);
if (!draftFile) { console.error('사용: enrich-cli.mjs <draft.md> [sections]'); process.exit(1); }

const md = readFileSync(draftFile, 'utf8');
const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
if (!m) { console.error('frontmatter 파싱 실패'); process.exit(1); }
const fm = m[1], body = m[2];
const slug = (fm.match(/^slug:\s*(.+)/m) || [, ''])[1].trim().replace(/["']/g, '');
const title = (fm.match(/^title:\s*(.+)/m) || [, ''])[1].trim().replace(/["']/g, '');

const r = await enrichImages(slug, title, body, { sections });
writeFileSync(draftFile, `---\n${fm}\n---\n${r.body}`);
// 호출부가 파싱할 한 줄
console.log('ENRICH_COVER=' + JSON.stringify(r.cover || null) + ' inline=' + r.inlineCount);
