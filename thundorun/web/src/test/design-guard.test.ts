/**
 * design-guard.test.ts — DESIGN.md 절대 규칙을 소스 스캔으로 강제한다.
 *
 * 이 테스트가 통과하지 않으면 UI 변경은 머지 금지(`/DESIGN.md §12.8`).
 * "문서에만 있는 규칙"은 반드시 썩는다 — 그래서 규칙마다 실패 케이스를 만든다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  WEB_ROOT, SRC_ROOT, GLOBALS_CSS,
  sourceFiles, uiFiles, cssFiles, registeredClasses, usedClasses, stripComments,
  allStringLiterals, TAILWIND_TOKEN, looksLikeClassList, inlineStyleRegions,
  NON_KIT_CLASS_ALLOWLIST,
} from './kit';

/** 금지 스택(import·설정) 검사 대상 — src 전체. */
const allFiles = sourceFiles();
/** 표현 규칙(색·이모지·클래스) 검사 대상 — 화면을 그리는 소스만(kit.ts uiFiles 주석 참조). */
const files = uiFiles();

/** 위반 목록을 "파일:줄 → 내용" 으로 읽기 쉽게 만든다. */
function report(hits: Array<{ rel: string; line: number; detail: string }>): string {
  return hits.map((h) => `  ${h.rel}:${h.line}  ${h.detail}`).join('\n');
}

/** §12.10 픽셀 예외 표시(`design-guard: …픽셀…`)가 덮는 줄 번호. 색 관련 규칙이 공유한다. */
const PIXEL_MARK = /design-guard:.*(pixel|픽셀)/;
function pixelExemptLines(raw: string[]): Set<number> {
  const out = new Set<number>();
  raw.forEach((line, i) => {
    if (!PIXEL_MARK.test(line)) return;
    out.add(i);
    // 선언문이 끝나는 줄(`;`)까지만 덮는다. 끝을 못 찾으면 표시 줄만 면제한다.
    const LIMIT = 40;
    const covered: number[] = [];
    for (let j = i + 1; j < Math.min(raw.length, i + LIMIT); j++) {
      covered.push(j);
      if (/;\s*$/.test(raw[j])) { covered.forEach((c) => out.add(c)); break; }
    }
  });
  return out;
}

function scanLines(
  test: (line: string) => string | null,
  target: typeof files = files,
): Array<{ rel: string; line: number; detail: string }> {
  const hits: Array<{ rel: string; line: number; detail: string }> = [];
  for (const f of target) {
    const lines = stripComments(f.code).split('\n');
    lines.forEach((line, i) => {
      const detail = test(line);
      if (detail) hits.push({ rel: f.rel, line: i + 1, detail });
    });
  }
  return hits;
}

describe('규칙 0 — 금지된 UI 스택', () => {
  it('@radix-ui/themes 를 import 하지 않는다', () => {
    const hits = scanLines((l) => (l.includes('@radix-ui/themes') ? l.trim() : null), allFiles);
    expect(hits, `Radix Themes 잔존:\n${report(hits)}`).toEqual([]);
  });

  it('CSS-in-JS · styled-components 를 쓰지 않는다', () => {
    const hits = scanLines((l) =>
      /from\s+['"](styled-components|@emotion\/|@stitches\/)/.test(l) ? l.trim() : null,
    allFiles);
    expect(hits, `CSS-in-JS 사용:\n${report(hits)}`).toEqual([]);
  });

  it('package.json 에 tailwindcss · @radix-ui/themes 가 없다', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const banned = ['tailwindcss', '@tailwindcss/typography', '@radix-ui/themes'];
    expect(banned.filter((d) => d in deps)).toEqual([]);
  });

  it('tailwind 설정 파일이 존재하지 않는다', () => {
    const present = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs']
      .filter((f) => fs.existsSync(path.join(WEB_ROOT, f)));
    expect(present).toEqual([]);
  });

  it('CSS 진입점은 globals.css 하나뿐이다', () => {
    const rels = cssFiles().map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, '/'));
    expect(rels).toEqual(['app/globals.css']);
  });

  it('globals.css 에 @tailwind 지시문이 없다', () => {
    expect(fs.readFileSync(GLOBALS_CSS, 'utf8')).not.toMatch(/@tailwind\b/);
  });
});

describe('규칙 1 — 하드코딩 금지 (색·폰트·그림자는 var(--*))', () => {
  /**
   * 캔버스 픽셀 값 예외.
   *
   * `/run` 이미지 편집기는 사용자가 고르는 **색 자체가 제품 데이터**다(팔레트, 배경
   * 채우기 색). 이건 UI 스타일이 아니므로 토큰으로 바꿀 수 없다. 파일 전체를 면제하면
   * 그 파일의 실제 UI 색이 함께 새므로, **줄 단위로 명시 표시**만 허용한다:
   *
   *   // design-guard: 팔레트 프리셋(픽셀 처리 데이터), UI 장식색 아님
   *   const PALETTE = ['#ffffff', '#000000', …];
   *
   * 표시는 선언 바로 위(또는 같은 줄)에 두면 그 **선언문 끝(`;`)까지** 적용된다.
   * 이유에 `픽셀`/`pixel` 을 반드시 적어 의도를 남긴다 — grep 으로 전수 감사 가능해야 한다.
   */
  const PIXEL_OPT_OUT = /design-guard:.*(pixel|픽셀)/;

  /** 예외 표시가 덮는 줄 번호 집합(표시 줄 ~ 선언문 끝). */
  const exemptLines = pixelExemptLines;
  function _unusedExemptLines(raw: string[]): Set<number> {
    const out = new Set<number>();
    raw.forEach((line, i) => {
      if (!PIXEL_OPT_OUT.test(line)) return;
      out.add(i);
      // 선언문이 끝나는 줄(`;`)까지만 덮는다. 끝을 못 찾으면 **표시 줄만** 면제한다
      // — 못 찾았는데 40줄을 통째로 면제하면 예외가 사실상 무제한이 된다(리뷰 지적).
      const LIMIT = 40;
      const covered: number[] = [];
      let closed = false;
      for (let j = i + 1; j < Math.min(raw.length, i + LIMIT); j++) {
        covered.push(j);
        if (/;\s*$/.test(raw[j])) { closed = true; break; }
      }
      if (closed) covered.forEach((j) => out.add(j));
    });
    return out;
  }

  it('소스에 hex · rgb() · hsl() 색을 직접 쓰지 않는다 (캔버스 픽셀 값은 줄 단위 예외 표시)', () => {
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      const raw = f.code.split('\n');            // 예외 표시는 주석이라 원본에서 찾는다
      const code = stripComments(f.code).split('\n'); // 검출은 주석 제거본에서
      const exempt = exemptLines(raw);
      code.forEach((line, i) => {
        const hex = line.match(/#[0-9a-fA-F]{3,8}\b/g)?.filter((h) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h));
        const fn = line.match(/\b(rgba?|hsla?)\s*\(/);
        if (!hex?.length && !fn) return;
        if (exempt.has(i)) return;
        hits.push({
          rel: f.rel,
          line: i + 1,
          detail: hex?.length
            ? `하드코딩 색 ${hex.join(', ')} → var(--color-*) 사용`
            : `하드코딩 색 ${fn![1]}() → var(--color-*) 사용`,
        });
      });
    }
    expect(hits, `색 하드코딩:\n${report(hits)}`).toEqual([]);
  });

  it('픽셀 예외 표시는 /run 편집기 안에서만 쓴다 (남용 차단)', () => {
    const abusers = files
      .filter((f) => PIXEL_OPT_OUT.test(f.code))
      .map((f) => f.rel)
      .filter((rel) => !/^(app\/run\/|components\/(BackgroundRemoval|ColorChange|ColorCorrection|EraserTool|LayerCanvas|LayerList|SizeTool))/.test(rel));
    expect(abusers, `픽셀 예외는 이미지 편집기 전용이다: ${abusers.join(', ')}`).toEqual([]);
  });

  it('인라인 style 에 색·폰트·그림자를 직접 넣지 않는다', () => {
    const hits = scanLines((line) => {
      const m = line.match(/\b(color|background|backgroundColor|borderColor|boxShadow|fontFamily)\s*:\s*(['"][^'"]*['"])/);
      if (!m) return null;
      if (m[2].includes('var(--') || /['"](none|transparent|inherit|currentColor|unset|initial)['"]/.test(m[2])) return null;
      return `${m[1]}: ${m[2]} → 토큰(var(--*)) 또는 키트 클래스 사용`;
    });
    expect(hits, `인라인 스타일 하드코딩:\n${report(hits)}`).toEqual([]);
  });
});

describe('규칙 2 — 모서리 반경은 토큰으로', () => {
  it('borderRadius 에 임의 px·% 를 쓰지 않는다', () => {
    const hits = scanLines((line) => {
      const m = line.match(/\bborderRadius\s*:\s*([^,}\n]+)/);
      if (!m) return null;
      const v = m[1].trim();
      if (v.includes('var(--radius-')) return null;
      return `borderRadius: ${v} → var(--radius-sm|md|lg|pill)`;
    });
    expect(hits, `radius 토큰 위반:\n${report(hits)}`).toEqual([]);
  });
});

describe('규칙 7 — 미등재 클래스 금지 (Tailwind 유틸 포함)', () => {
  const registered = registeredClasses();

  it('globals.css 파싱이 키트 클래스를 실제로 찾아낸다 (가드의 가드)', () => {
    for (const c of ['btn', 'btn-primary', 'card', 'table', 'tag', 'empty', 'article', 'container']) {
      expect(registered.has(c), `globals.css 에 .${c} 가 없다`).toBe(true);
    }
    expect(registered.size).toBeGreaterThan(80);
  });

  it('src 에서 쓰는 모든 className 이 globals.css 에 등록되어 있다', () => {
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      for (const [token, line] of usedClasses(f.code)) {
        if (registered.has(token) || NON_KIT_CLASS_ALLOWLIST.has(token)) continue;
        hits.push({ rel: f.rel, line, detail: `미등재 클래스 "${token}" (Tailwind 유틸이면 키트 클래스로 교체, 정말 필요하면 globals.css + DESIGN.md §11 에 등재)` });
      }
    }
    expect(hits, `미등재 클래스 ${hits.length}건:\n${report(hits)}`).toEqual([]);
  });

  it('Tailwind 반응형·상태 접두사(md: hover: dark:)를 쓰지 않는다', () => {
    // className 토큰만 본다 — 소스 전체를 훑으면 `active:summary->x` 같은 SQL 이 오탐된다.
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      for (const [token, line] of usedClasses(f.code)) {
        if (/^(sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover):/.test(token)) {
          hits.push({ rel: f.rel, line, detail: `Tailwind 접두사 "${token}"` });
        }
      }
    }
    expect(hits, `Tailwind 접두사:\n${report(hits)}`).toEqual([]);
  });

  it('@tailwindcss/typography 의 prose 클래스를 쓰지 않는다 (.article 사용)', () => {
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      for (const [token, line] of usedClasses(f.code)) {
        if (/^prose(-\w+)?$/.test(token)) hits.push({ rel: f.rel, line, detail: `prose 클래스 "${token}"` });
      }
    }
    expect(hits, `prose 잔존:\n${report(hits)}`).toEqual([]);
  });
});

describe('규칙 8 — 이모지 금지 (아이콘은 lucide-react)', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2190}-\u{2BFF}\u{FE0F}\u{2600}-\u{27BF}]/u;

  it('UI 소스에 이모지·기하문자를 쓰지 않는다', () => {
    const hits = scanLines((line) => {
      const m = line.match(EMOJI);
      return m ? `이모지/기하문자 "${m[0]}" → lucide-react 아이콘 사용` : null;
    });
    expect(hits, `이모지 ${hits.length}건:\n${report(hits)}`).toEqual([]);
  });
});


describe('규칙 1 보강 — 인라인 style 은 치수 한정 (§12.5)', () => {
  // §12.10 픽셀 예외는 이 규칙에도 적용된다 — `/run` 은 사용자가 고른 색을 캔버스에 넘긴다.
  // 리뷰 지적: 키 목록에 fontSize/fontWeight 가 없고, 값이 리터럴일 때만 검사해
  // `style={{ color: c }}` 처럼 변수로 넘기면 통과했다.
  const BANNED_STYLE_KEYS = /\b(color|background|backgroundColor|backgroundImage|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|boxShadow|fontFamily|fontSize|fontWeight|fill|stroke|textShadow|outlineColor)\s*:/g;

  it('색·폰트·그림자를 인라인 style 로 지정하지 않는다', () => {
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      const exempt = pixelExemptLines(f.code.split('\n'));
      // 인라인 style 객체 안에서만 검사한다 — 타입 주석·일반 객체는 대상이 아니다.
      for (const region of inlineStyleRegions(f.code)) {
        if (exempt.has(region.line - 1)) continue;
        for (const m of region.text.matchAll(BANNED_STYLE_KEYS)) {
          const after = region.text.slice((m.index ?? 0) + m[0].length).trim();
          if (after.startsWith('var(--') || /^['"]var\(--/.test(after)) continue;
          if (/^['"](none|transparent|inherit|currentColor|unset|initial|auto)['"]/.test(after)) continue;
          hits.push({
            rel: f.rel,
            line: region.line,
            detail: `style 안 ${m[1]} 지정 → 키트 클래스 또는 var(--*) 사용`,
          });
        }
      }
    }
    expect(hits, `인라인 스타일 위반:\n${report(hits)}`).toEqual([]);
  });
});

describe('규칙 7 보강 — 동적 className 우회 차단', () => {
  it('상수·변수에 담긴 클래스 문자열에도 Tailwind 유틸이 없다', () => {
    // `const cls = 'flex text-sm'` 처럼 담아 넘기면 className= 스캔을 빠져나간다.
    // 그래서 파일 안의 모든 문자열 리터럴을 훑는다(Tailwind 전용 형태만 좁게 매칭).
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      for (const { value, line } of allStringLiterals(f.code)) {
        for (const token of value.split(/\s+/)) {
          if (!token || !TAILWIND_TOKEN.test(token)) continue;
          if (!looksLikeClassList(value, token)) continue;   // 인라인 CSS 값(display:'flex' 등)
          hits.push({ rel: f.rel, line, detail: `Tailwind 유틸 "${token}" (문자열 "${value.slice(0, 60)}")` });
        }
      }
    }
    expect(hits, `동적 className 경로의 Tailwind 잔존 ${hits.length}건:\n${report(hits)}`).toEqual([]);
  });
});

describe('규칙 8 보강 — 아이콘 크기 (§12.3 · §12.9)', () => {
  /** 허용 크기: 본문 16/18/20 + §12.9 예외(체크박스 11, 지표 델타·캡션 14). */
  const ALLOWED = new Set([11, 14, 16, 18, 20]);

  it('lucide 아이콘 size 가 허용 스케일 안에 있다', () => {
    const hits = scanLines((line) => {
      const bad = [...line.matchAll(/\bsize=\{(\d+)\}/g)]
        .map((m) => Number(m[1]))
        .filter((n) => !ALLOWED.has(n));
      return bad.length ? `아이콘 size=${bad.join(', ')} → 16/18/20 (예외 11·14)` : null;
    });
    expect(hits, `아이콘 크기 위반:\n${report(hits)}`).toEqual([]);
  });
});

describe('§12.1 보강 — TSX 안 CSS 블록 금지', () => {
  it('컴포넌트에 <style> 블록을 넣지 않는다 (CSS 는 globals.css 하나)', () => {
    const hits = scanLines((l) => (/<style[\s>]/.test(l) ? l.trim().slice(0, 120) : null));
    expect(hits, `TSX 안 <style> 블록:\n${report(hits)}`).toEqual([]);
  });
});

describe('규칙 7 — §11 등재표와 globals.css 동기화', () => {
  it('PROJECT EXTENSIONS 의 모든 클래스가 DESIGN.md §11 표에 등재돼 있다', () => {
    const css = fs.readFileSync(GLOBALS_CSS, 'utf8');
    const marker = css.indexOf('PROJECT EXTENSIONS');
    expect(marker, 'globals.css 에 PROJECT EXTENSIONS 절이 없다').toBeGreaterThan(0);

    // 마커는 헤더 주석 안에 있다. 그 주석이 끝나는 지점부터 잘라야
    // 주석 본문의 `thundo.kr`·`DESIGN.md` 같은 텍스트가 클래스로 잡히지 않는다.
    const extStart = css.indexOf('*/', marker) + 2;
    const extCss = stripComments(css.slice(extStart));
    const baseCss = stripComments(css.slice(0, marker));

    const collect = (text: string) => {
      const out = new Set<string>();
      for (const m of text.matchAll(/([^{}]+)\{/g)) {
        for (const c of m[1].matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) out.add(c[1]);
      }
      return out;
    };
    const baseClasses = collect(baseCss);
    // 확장 절이 키트 기본 클래스를 참조하는 것(`.card-link:hover .card-title`)은 신규가 아니다.
    const extClasses = new Set([...collect(extCss)].filter((c) => !baseClasses.has(c)));

    const design = fs.readFileSync(path.join(WEB_ROOT, '..', 'DESIGN.md'), 'utf8');
    const section = design.slice(design.indexOf('# §11.'), design.indexOf('# §12.'));
    const documented = new Set([...section.matchAll(/`\.([A-Za-z_][A-Za-z0-9_-]*)`/g)].map((m) => m[1]));

    const undocumented = [...extClasses].filter((c) => !documented.has(c)).sort();
    expect(
      undocumented,
      `globals.css 확장 절에 있으나 DESIGN.md §11 표에 없는 클래스: ${undocumented.join(', ')}\n` +
        '규칙 7 — 새 클래스는 globals.css 와 §11 표에 동시에 등재해야 한다.',
    ).toEqual([]);
  });
});

describe('§12.11 — 콘텐츠 사진은 원색', () => {
  it('사진·영상 카드에 .grayscale 을 걸지 않는다', () => {
    // 키트 규칙 6(사진 흑백)은 이 저장소에서 적용하지 않기로 했다(사용자 결정 2026-07-30).
    // 팔레트가 이미 중성 회색 + 빨강 하나라 사진까지 탈색하면 화면에서 색이 사라지고,
    // VideoFacade 는 카드 래퍼에 걸려 재생 중인 iframe 까지 흑백이 됐다.
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      for (const [token, line] of usedClasses(f.code)) {
        if (token === 'grayscale') {
          hits.push({ rel: f.rel, line, detail: '콘텐츠 사진에 흑백 필터 — §12.11 에 따라 원색 유지' });
        }
      }
    }
    expect(hits, `흑백 필터 적용:\n${report(hits)}`).toEqual([]);
  });
});

describe('§12 — 테마·구조 규칙', () => {
  it('컴포넌트에서 data-theme 로 다크 분기를 만들지 않는다 (ThemeToggle 예외)', () => {
    const hits: Array<{ rel: string; line: number; detail: string }> = [];
    for (const f of files) {
      if (f.rel.includes('ThemeToggle') || f.rel === 'app/layout.tsx' || f.rel === 'lib/theme.ts') continue;
      stripComments(f.code).split('\n').forEach((line, i) => {
        if (/data-theme|dataset\.theme/.test(line)) {
          hits.push({ rel: f.rel, line: i + 1, detail: line.trim().slice(0, 120) });
        }
      });
    }
    expect(hits, `다크 분기:\n${report(hits)}`).toEqual([]);
  });

  it('루트 레이아웃이 data-theme 기본값을 light 로 준다', () => {
    const layout = fs.readFileSync(path.join(SRC_ROOT, 'app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/<html[^>]*lang="ko"/);
    expect(layout).toMatch(/data-theme="light"/);
    expect(layout, 'className="dark" 는 Tailwind 다크모드 잔존').not.toMatch(/className="dark"/);
  });
});
