/**
 * kit.ts — 디자인 가드 테스트용 소스 스캐너.
 *
 * globals.css 에 등록된 Modernist Kit 클래스 목록을 파싱하고, src 아래
 * 소스에서 사용된 className 토큰을 추출한다. DESIGN.md 의 절대 규칙을
 * "문서"가 아니라 "테스트"로 강제하기 위한 공용 유틸.
 */
import fs from 'node:fs';
import path from 'node:path';

export const WEB_ROOT = path.resolve(__dirname, '../..');
export const SRC_ROOT = path.join(WEB_ROOT, 'src');
export const GLOBALS_CSS = path.join(SRC_ROOT, 'app/globals.css');

/**
 * 스캔 제외 경로 — src 기준 상대경로로 정확히 지정한다.
 * (이름이 `test` 인 디렉터리를 통째로 제외하면 `components/test/Foo.tsx` 같은
 *  실제 UI 도 검사망에서 빠진다 — 리뷰 지적으로 경로 기준으로 좁혔다.)
 */
const EXCLUDE_DIRS = new Set(['node_modules', '.next']);
const EXCLUDE_REL = ['test', 'e2e'];

export interface SourceFile {
  /** src 기준 상대경로 */
  rel: string;
  abs: string;
  code: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const rel = path.relative(SRC_ROOT, path.join(dir, entry.name)).replace(/\\/g, '/');
      if (EXCLUDE_REL.includes(rel)) continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** 주석을 공백으로 치환 — 규칙 검사는 실제 코드만 대상으로 한다. */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** src 아래 .ts/.tsx 소스 (테스트·E2E 제외). */
export function sourceFiles(exts = ['.ts', '.tsx']): SourceFile[] {
  return walk(SRC_ROOT)
    .filter((f) => exts.includes(path.extname(f)))
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .map((abs) => ({
      abs,
      rel: path.relative(SRC_ROOT, abs).replace(/\\/g, '/'),
      code: fs.readFileSync(abs, 'utf8'),
    }));
}

/**
 * 화면을 그리는 소스만 골라낸다 — 디자인 규칙의 적용 대상.
 *
 * 규칙 1(하드코딩 색)·규칙 8(이모지)은 **UI 표현**에 관한 규칙이다. 서버 코드가
 * Slack/Discord 알림 문구나 LLM 프롬프트에 이모지를 쓰는 것, 로그에 화살표를 쓰는 것,
 * 알림 임베드에 색 코드를 넣는 것은 UI 가 아니므로 이 규칙의 대상이 아니다.
 * (렌더 결과에 이모지가 섞이는 경우는 소스 스캔으로 잡을 수 없으므로 E2E 에서
 *  실제 DOM 을 검사한다 — `e2e/kit.spec.ts`.)
 */
export function uiFiles(): SourceFile[] {
  return sourceFiles().filter((f) => {
    if (f.rel.startsWith('app/api/')) return false;        // 라우트 핸들러 — JSX 없음
    if (f.rel.startsWith('server/')) return false;          // 서버 전용 로직·알림 문구
    if (f.rel.startsWith('lib/')) return false;             // 순수 로직·데이터
    if (f.rel === 'middleware.ts') return false;
    return f.rel.startsWith('app/') || f.rel.startsWith('components/');
  });
}

/** src 아래 .css 파일 전부. */
export function cssFiles(): string[] {
  return walk(SRC_ROOT).filter((f) => path.extname(f) === '.css');
}

/** globals.css 에 정의된 클래스 이름 집합. */
export function registeredClasses(): Set<string> {
  const css = stripComments(fs.readFileSync(GLOBALS_CSS, 'utf8'));
  const out = new Set<string>();
  // `{` 직전 구간이 곧 선택자(또는 @media/@supports 프렐류드)다.
  // 선언 본문에는 `{` 가 없으므로 이 방식이 @supports 중첩까지 정확히 처리한다
  // (split('}') 방식은 중첩 블록 안의 .pt-safe 같은 클래스를 놓쳤다).
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    for (const c of m[1].matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) out.add(c[1]);
  }
  return out;
}

/**
 * className 속성 안에서 쓰인 정적 클래스 토큰을 추출한다.
 * - className="a b" / className={'a b'} / className={`a ${x}`} / 배열 join 모두 커버
 * - 보간(${...})이 섞인 조각은 토큰 경계를 신뢰할 수 없어 버린다
 */
export function usedClasses(code: string): Map<string, number> {
  const src = stripComments(code);
  const found = new Map<string, number>();
  const CLASS_ATTR = /class(?:Name)?\s*=\s*/g;

  for (const m of src.matchAll(CLASS_ATTR)) {
    const start = (m.index ?? 0) + m[0].length;
    const region = readRegion(src, start);
    if (!region) continue;
    for (const lit of stringLiterals(region)) {
      for (const token of lit.split(/\s+/)) {
        if (!token || token.includes('${') || token.includes('{')) continue;
        // 클래스 이름에 '.' 은 없다 — 있으면 코드 조각(`report.date` 등)이므로 버린다.
        if (!/^[A-Za-z][A-Za-z0-9_:/[\]-]*$/.test(token)) continue;
        const line = src.slice(0, start).split('\n').length;
        if (!found.has(token)) found.set(token, line);
      }
    }
  }
  return found;
}

/** className= 다음의 값 구간(문자열 하나 또는 {…} 균형 블록)을 잘라낸다. */
function readRegion(src: string, start: number): string | null {
  const ch = src[start];
  if (ch === '"' || ch === "'") {
    const end = src.indexOf(ch, start + 1);
    return end === -1 ? null : src.slice(start, end + 1);
  }
  if (ch !== '{') return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 구간 안의 문자열/템플릿 리터럴 내용을 뽑는다.
 * 템플릿의 `${…}` 보간은 코드이지 클래스가 아니므로 공백으로 지운다
 * (지우지 않으면 `${report.date === d ? 'a' : 'b'}` 의 조각들이 가짜 클래스로 잡힌다).
 */
function stringLiterals(region: string): string[] {
  const out: string[] = [];
  for (const m of region.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`]*)`/g)) {
    // 비교 연산의 오른쪽 피연산자는 클래스가 아니다:
    //   className={tone === 'danger' ? 'btn btn-danger' : 'btn btn-primary'}
    // 여기서 'danger' 는 값 비교일 뿐이므로 클래스 토큰으로 세면 오탐이 된다.
    const before = region.slice(0, m.index ?? 0).trimEnd();
    if (/[=!<>]$/.test(before)) continue;
    if (m[3] !== undefined) out.push(stripInterpolations(m[3]));
    else out.push(m[1] ?? m[2] ?? '');
  }
  return out;
}

/** `${ … }` 를 균형 있게 찾아 공백으로 치환한다(중첩 중괄호 대응). */
function stripInterpolations(tpl: string): string {
  let out = '';
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] === '$' && tpl[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < tpl.length; j++) {
        if (tpl[j] === '{') depth++;
        else if (tpl[j] === '}' && --depth === 0) break;
      }
      out += ' ';
      i = j;
      continue;
    }
    out += tpl[i];
  }
  return out;
}

/**
 * Tailwind 유틸로만 존재하는 토큰 패턴.
 *
 * `usedClasses()` 는 `className=` 뒤 리터럴만 본다. 그래서 클래스 문자열을 상수·변수에
 * 담아 넘기면(`const cls = 'flex text-sm'; <div className={cls} />`) 전혀 검사되지 않는다.
 * 이 패턴은 **파일 안의 모든 문자열 리터럴**에 적용해 그 우회로를 막는다.
 * 등재 클래스와 겹치지 않도록 "Tailwind 에만 있는 형태"만 좁게 매칭한다.
 */
export const TAILWIND_TOKEN =
  /^(?:(?:sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover|focus-visible):.+|prose(?:-\w+)?|flex|grid|hidden|inline-flex|antialiased|truncate|(?:items|justify|self|place|content)-(?:center|start|end|between|around|evenly|stretch|baseline)|(?:gap|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|space-x|space-y|w|h|min-w|min-h|max-w|max-h|top|left|right|bottom|inset|z|opacity|rounded|border|shadow|leading|tracking|ring|divide|basis|grow|shrink|order|col|row|aspect|duration|delay)-(?:\d+|px|full|auto|none|sm|md|lg|xl|2xl|3xl|screen|dvh|svh|\[.+\])|(?:text|bg|border|fill|stroke|from|via|to|ring|divide|decoration|placeholder|accent|caret|shadow|outline)-(?:\w+-\d{2,3}|white|black|transparent|current|inherit|xs|sm|base|lg|xl|\dxl)(?:\/\d+)?|(?:font|text)-(?:thin|light|normal|medium|semibold|bold|extrabold|black|left|center|right|justify)|(?:overflow|overscroll)-(?:auto|hidden|visible|scroll|clip|contain|none)|(?:bg|from|via|to)-gradient-to-\w+|animate-\w+|transition(?:-\w+)?|cursor-\w+|select-\w+|pointer-events-\w+|whitespace-\w+|backdrop-\w+|sr-only-\w+)$/;

/**
 * 인라인 `style={{ … }}` 객체 구간만 뽑는다.
 *
 * 줄 단위로 `color:` 같은 키를 찾으면 **타입 주석**(`onChange: (color: string) => void`)이나
 * 일반 객체 속성까지 잡는다. 실제로 그 오탐 때문에 소스의 파라미터명이 바뀐 일이 있어
 * (규칙이 코드를 왜곡했다) 검사 범위를 인라인 스타일 객체로 한정한다.
 */
export function inlineStyleRegions(code: string): Array<{ text: string; line: number }> {
  const src = stripComments(code);
  const out: Array<{ text: string; line: number }> = [];
  for (const m of src.matchAll(/style\s*=\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length - 1;   // 첫 `{` 위치
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ text: src.slice(start, i + 1), line: src.slice(0, start).split('\n').length });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * 문자열이 "클래스 목록"으로 보이는지 판단한다.
 *
 * `'flex'` `'hidden'` `'grid'` 는 Tailwind 클래스이기도 하지만 인라인 CSS 의 값
 * (`display: 'flex'`, `overflow: 'hidden'`)이기도 하다. 단독 토큰일 때는 CSS 값으로 보고
 * 넘긴다 — 클래스로 쓰였다면 `className=` 경로의 등재 검사가 이미 잡는다.
 * 토큰이 둘 이상이거나 Tailwind 특유의 형태(`-`/`:` 포함)면 클래스 목록으로 본다.
 */
export function looksLikeClassList(value: string, token: string): boolean {
  const multi = value.trim().split(/\s+/).length > 1;
  return multi || /[-:]/.test(token);
}

/** 파일 전체의 문자열 리터럴을 (내용, 줄번호)로 뽑는다. 동적 className 검사에 쓴다. */
export function allStringLiterals(code: string): Array<{ value: string; line: number }> {
  const src = stripComments(code);
  const out: Array<{ value: string; line: number }> = [];
  for (const m of src.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`]*)`/g)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    if (!raw.trim()) continue;
    out.push({ value: raw, line: src.slice(0, m.index ?? 0).split('\n').length });
  }
  return out;
}

/**
 * CSS 클래스가 아닌 정당한 className 토큰 화이트리스트.
 * (제3자 라이브러리 훅 클래스 등 — 늘리기 전에 정말 필요한지 검토할 것)
 */
export const NON_KIT_CLASS_ALLOWLIST = new Set<string>([
  'ProseMirror', // tiptap 이 자체적으로 붙이는 클래스(우리가 정의하지 않음)
]);
