/**
 * motion-guard.test.ts — 모션 규칙을 소스 스캔으로 강제한다.
 *
 * 왜 필요한가:
 *   2026-08-19 개편으로 이징·지속시간 토큰과 누름 피드백이 들어갔다. 그런데 규칙이 문서에만
 *   있으면 다음 사람이 `transition: all 400ms ease-in` 을 넣는 걸 막을 방법이 0이다.
 *   DESIGN.md §12.8 이 "문서에만 있는 규칙은 반드시 썩는다"고 못박은 그 상황이라, 규칙마다
 *   테스트를 붙인다.
 *
 * 왜 값이 아니라 토큰을 강제하는가:
 *   `/run`(사진편집) 격리가 **토큰 재선언**으로 성립한다(`.run-scope`). 값을 직접 박은
 *   `transition: transform 160ms ease` 는 그 스코프가 손댈 수 없어 격리가 조용히 뚫린다.
 *
 * 기준의 출처: Emil Kowalski 의 애니메이션 규범(진입·퇴장은 ease-out, UI 는 300ms 미만,
 * transform/opacity 만, `transition: all` 금지).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { GLOBALS_CSS, uiFiles, stripComments, inlineStyleRegions } from './kit';

/** 주석을 제거한 globals.css — 규칙 설명 문구가 위반으로 잡히면 안 된다(오탐 실측). */
const CSS = stripComments(fs.readFileSync(GLOBALS_CSS, 'utf8'));

/**
 * **선언 단위** 목록. 줄 단위로 훑으면 여러 줄에 걸친 선언의 2행 이후를 통째로 놓친다.
 *
 *   transition: opacity 200ms var(--ease-out),
 *               width 500ms var(--ease-out);      ← 이 줄이 검사에서 빠졌다
 *
 * 이 저장소 자신이 `.btn` 에서 여러 줄 transition 을 쓰고 있어, 줄 단위 가드는 지키려는
 * 대상 자체를 못 보고 있었다(사후 리뷰 적발). 그래서 `;` 까지 이어 붙여 한 덩어리로 본다.
 * 줄번호는 선언이 **시작된** 줄을 보고한다.
 */
const DECLARATIONS: Array<{ text: string; line: number }> = (() => {
  const out: Array<{ text: string; line: number }> = [];
  let buf = '';
  let startLine = 1;
  CSS.split('\n').forEach((raw, i) => {
    if (!buf) startLine = i + 1;
    buf += (buf ? ' ' : '') + raw.trim();
    // 선언은 `;` 로 끝난다. 블록 경계(`{`/`}`)도 구분점으로 삼아 버퍼가 무한히 자라지 않게 한다.
    if (/[;{}]\s*$/.test(raw.trim()) || raw.includes(';')) {
      for (const piece of buf.split(';')) {
        // ⚠ 선택자를 떼어내야 한다. 한 줄짜리 규칙(`.x { transition: … }`)에서는 첫 선언 앞에
        //    `.x {` 가 붙어 있어 `^transition:` 같은 검사가 전부 빗나간다.
        //    (실제로 위반 샘플을 주입해 보고 이 구멍을 발견했다 — 통과 표시만 믿으면 못 본다.)
        const t = piece.replace(/^[\s\S]*\{/, '').replace(/\}\s*$/, '').trim();
        if (t) out.push({ text: t, line: startLine });
      }
      buf = '';
    }
  });
  if (buf.trim()) out.push({ text: buf.trim(), line: startLine });
  return out;
})();

/**
 * `/run` 사진편집 동결 파일 — 규칙 6(인라인 transition) 면제 대상.
 * 편집기는 개편 범위 밖이고 파일을 고치지 않기로 했다(`run-scope.test.tsx` 참조).
 */
const FROZEN_RUN_FILES = [
  'app/run/page.tsx',
  'components/BackgroundRemoval.tsx',
  'components/ColorChange.tsx',
  'components/ColorCorrection.tsx',
  'components/EraserTool.tsx',
  'components/LayerCanvas.tsx',
  'components/LayerList.tsx',
  'components/SizeTool.tsx',
];

function hits(test: (decl: string) => string | null) {
  const out: string[] = [];
  for (const { text, line } of DECLARATIONS) {
    const d = test(text);
    if (d) out.push(`  globals.css:${line}  ${d}`);
  }
  return out;
}

describe('모션 규칙 1 — transition: all 금지', () => {
  it('속성을 명시하지 않은 transition 이 없다', () => {
    // `all` 은 의도치 않은 속성(레이아웃 포함)까지 함께 움직여 GPU 밖으로 샌다.
    const found = hits((l) => (/transition(-property)?:\s*all\b/.test(l) ? l.trim() : null));
    expect(found, `transition: all 사용:\n${found.join('\n')}`).toEqual([]);
  });
});

describe('모션 규칙 2 — UI 에 ease-in 금지', () => {
  it('ease-in(단독)을 쓰지 않는다', () => {
    // ease-in 은 시작이 느려, 사용자가 가장 주의 깊게 보는 순간을 지연시킨다.
    // ease-in-out 은 화면 안 이동에 정당하므로 제외한다.
    const found = hits((l) => {
      const m = l.match(/(?:^|[\s:,(])ease-in(?![-\w])/);
      return m ? l.trim() : null;
    });
    expect(found, `ease-in 사용:\n${found.join('\n')}`).toEqual([]);
  });
});

describe('모션 규칙 3 — UI 지속시간은 300ms 미만', () => {
  it('transition/animation 에 300ms 이상이 없다 (무한 반복 제외)', () => {
    const found = hits((l) => {
      if (!/transition|animation/.test(l)) return null;
      if (/infinite/.test(l)) return null;      // 스피너·스켈레톤은 지속 루프라 대상 아님
      // ⚠ `.2s` 처럼 **앞자리 0 이 생략된 소수**를 반드시 함께 잡아야 한다.
      //    `\d+(\.\d+)?` 로 쓰면 ".2s" 에서 "2s" 만 잡혀 0.2초가 2초로 뒤집힌다
      //    (이 가드를 처음 돌렸을 때 실제로 5건이 오탐으로 잡혔다).
      //    앞이 단어문자·점이면 숫자 중간이므로 건너뛴다.
      const times = [...l.matchAll(/(?<![\w.])(\d*\.?\d+)\s*(ms|s)\b/g)].map(([, n, u]) =>
        u === 's' ? parseFloat(n) * 1000 : parseFloat(n),
      );
      const over = times.filter((t) => t >= 300);
      return over.length ? `${over.join(', ')}ms — UI 는 300ms 미만 (${l.trim().slice(0, 70)})` : null;
    });
    expect(found, `과도한 지속시간:\n${found.join('\n')}`).toEqual([]);
  });
});

describe('모션 규칙 4 — 커브·지속시간은 토큰으로', () => {
  it('cubic-bezier 를 직접 쓰지 않는다 (:root 토큰 정의부 제외)', () => {
    // 값을 직접 박으면 `/run` 격리(.run-scope 토큰 재선언)가 뚫린다.
    const found = hits((l) => {
      if (!/cubic-bezier\(/.test(l)) return null;
      if (/^\s*--ease-[\w-]*:/.test(l)) return null;   // 토큰을 정의하는 줄은 당연히 허용
      return `하드코딩 커브 → var(--ease-*) 사용 (${l.trim().slice(0, 70)})`;
    });
    expect(found, `커브 하드코딩:\n${found.join('\n')}`).toEqual([]);
  });

  it('transition 은 지속시간·커브를 토큰으로 쓴다', () => {
    /**
     * 규칙 4 의 cubic-bezier 검사만으로는 부족하다. `transition: transform 250ms ease` 는
     * 커브가 하드코딩이 아니라서 통과하는데, **이게 정확히 `/run` 격리를 뚫는 형태다**
     * (`.run-scope` 는 토큰 값만 되돌릴 수 있다). 그래서 토큰 사용 자체를 요구한다.
     */
    const found = hits((d) => {
      if (!/^transition\s*:/.test(d)) return null;
      if (/^transition\s*:\s*(none|inherit|initial|unset)\b/.test(d)) return null;
      const hasDur = /var\(--dur-/.test(d);
      const hasEase = /var\(--ease-/.test(d);
      if (hasDur && hasEase) return null;
      const missing = [!hasDur && 'var(--dur-*)', !hasEase && 'var(--ease-*)'].filter(Boolean);
      return `${missing.join(' · ')} 누락 → 값 직접 지정은 /run 격리를 뚫는다 (${d.slice(0, 70)})`;
    });
    expect(found, `토큰 미사용 transition:\n${found.join('\n')}`).toEqual([]);
  });

  it('지속시간 토큰 정의값도 300ms 미만이다', () => {
    // 실제 값이 전부 토큰으로 옮겨간 뒤엔 `--dur-*` 정의부가 유일한 지속시간 원천이다.
    // 규칙 3 은 `transition|animation` 이 있는 선언만 보므로 여기서 따로 잠근다.
    const found = hits((d) => {
      const m = d.match(/^--dur-[\w-]+\s*:\s*(\d*\.?\d+)\s*(ms|s)$/);
      if (!m) return null;
      const ms = m[2] === 's' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
      return ms >= 300 ? `${d} → UI 토큰은 300ms 미만` : null;
    });
    expect(found, `과도한 지속시간 토큰:\n${found.join('\n')}`).toEqual([]);
  });

  it('모션 토큰이 :root 에 정의돼 있다 (가드의 가드)', () => {
    for (const t of ['--ease-out', '--ease-in-out', '--ease-drawer',
                     '--dur-press', '--dur-tip', '--dur-menu', '--dur-panel', '--press-scale']) {
      expect(CSS, `${t} 가 정의돼 있지 않다`).toMatch(new RegExp(`${t}:\\s*[^;]+;`));
    }
  });
});

describe('모션 규칙 5 — 레이아웃 속성 애니메이션 금지', () => {
  /** 이 속성들은 레이아웃→페인트→합성을 전부 다시 돌린다. transform/opacity 만 GPU 에서 끝난다. */
  const LAYOUT = ['width', 'height', 'margin', 'padding', 'top', 'left', 'right', 'bottom'];

  it('transition 대상에 레이아웃 속성이 없다', () => {
    const found = hits((l) => {
      const m = l.match(/transition(?:-property)?:\s*([^;{}]+)/);
      if (!m) return null;
      // 쉼표로 나뉜 각 항목의 **첫 토큰**만 속성 이름이다("transform 200ms" → transform).
      const props = m[1].split(',').map((seg) => seg.trim().split(/\s+/)[0]);
      const bad = props.filter((p) => LAYOUT.includes(p));
      return bad.length ? `레이아웃 속성 애니메이션: ${bad.join(', ')} → transform/opacity 사용` : null;
    });
    expect(found, `레이아웃 속성 애니메이션:\n${found.join('\n')}`).toEqual([]);
  });
});

describe('모션 규칙 6 — 컴포넌트 인라인 style 에 transition 금지', () => {
  it('TSX 인라인 style 로 transition 을 지정하지 않는다', () => {
    // 인라인은 특이도가 최고라 `.run-scope` 격리도, 감소 모션 규칙도 못 이긴다.
    const bad: string[] = [];
    for (const f of uiFiles()) {
      // `/run` 사진편집은 개편 대상에서 제외했다(사용자 결정 2026-08-19). 이 파일들은
      // 손대지 않기로 한 동결 대상이라 새 규칙을 소급 적용하지 않는다.
      // ⚠ 목록을 넓히지 말 것 — 넓히는 순간 이 가드는 아무것도 못 막는다.
      if (FROZEN_RUN_FILES.some((frozen) => f.rel === frozen)) continue;
      for (const region of inlineStyleRegions(f.code)) {
        if (/\btransition\s*:/.test(region.text)) {
          bad.push(`  ${f.rel}:${region.line}  인라인 transition → globals.css 로 옮길 것`);
        }
      }
    }
    expect(bad, `인라인 transition:\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('모션 규칙 7 — 감소 모션 안전망 유지', () => {
  it('prefers-reduced-motion 전역 차단이 살아 있다', () => {
    // 앞으로 추가되는 모션까지 자동으로 걸러 주는 안전망이다. 지우면 신규 모션마다
    // 개별 대응을 챙겨야 하고, 한 번 빠뜨리면 그대로 샌다(사용자 결정 2026-08-19).
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(CSS, '전역 차단(*) 규칙이 사라졌다').toMatch(
      /prefers-reduced-motion[\s\S]{0,400}\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition-duration/,
    );
  });
});

describe('CSS 주석 안전성', () => {
  it('주석 안에 `*/` 를 만들어 주석을 조기 종료시키지 않는다', () => {
    /**
     * 실제로 겪은 사고: 주석 안에 토큰 두 개를 슬래시로 이어 적었더니(별표 뒤에 슬래시가 붙어)
     * 주석이 거기서 끝나 버리고, 뒤 문장이 CSS 로 해석돼 **프로덕션 빌드가 깨졌다**.
     * 더 나쁜 건 테스트는 통과했다는 것 — 주석 제거기도 같은 지점에서 잘려 위반을 못 봤다.
     * 그래서 원본(주석 제거 전)에서 직접 검사한다.
     */
    const raw = fs.readFileSync(GLOBALS_CSS, 'utf8');
    const bad: string[] = [];
    let depth = 0;
    for (let i = 0; i < raw.length - 1; i++) {
      if (raw[i] === '/' && raw[i + 1] === '*') { depth++; i++; continue; }
      if (raw[i] === '*' && raw[i + 1] === '/') {
        depth--;
        if (depth < 0) {
          const line = raw.slice(0, i).split('\n').length;
          bad.push(`  globals.css:${line}  짝이 맞지 않는 주석 종료`);
          depth = 0;
        }
        i++;
      }
    }
    expect(depth, '닫히지 않은 주석이 있다').toBe(0);
    expect(bad, `주석 구조 이상:\n${bad.join('\n')}`).toEqual([]);
  });

  it('주석 제거 후에도 중괄호 짝이 맞는다 (빌드 파손 조기 감지)', () => {
    const open = (CSS.match(/\{/g) || []).length;
    const close = (CSS.match(/\}/g) || []).length;
    expect(open, `중괄호 불균형: { ${open}개 vs } ${close}개 — CSS 가 깨졌다`).toBe(close);
  });
});

describe('가드의 가드 — 검사기가 실제로 잡는지', () => {
  const probe = (lines: string[], test: (l: string) => string | null) =>
    lines.filter((l) => test(l) !== null).length;

  it('규칙 1 이 위반 샘플을 잡는다', () => {
    const t = (l: string) => (/transition(-property)?:\s*all\b/.test(l) ? l : null);
    expect(probe(['  transition: all 300ms ease;'], t)).toBe(1);
    expect(probe(['  transition: transform 200ms var(--ease-out);'], t)).toBe(0);
  });

  it('규칙 2 가 ease-in 만 잡고 ease-in-out 은 통과시킨다', () => {
    const t = (l: string) => (/(?:^|[\s:,(])ease-in(?![-\w])/.test(l) ? l : null);
    expect(probe(['  transition: opacity 200ms ease-in;'], t)).toBe(1);
    expect(probe(['  transition: opacity 200ms ease-in-out;'], t)).toBe(0);
  });

  it('규칙 3 이 앞자리 0 생략 소수(.2s)를 200ms 로 읽는다', () => {
    const parse = (l: string) =>
      [...l.matchAll(/(?<![\w.])(\d*\.?\d+)\s*(ms|s)\b/g)].map(([, n, u]) =>
        u === 's' ? parseFloat(n) * 1000 : parseFloat(n),
      );
    expect(parse('  transition: transform .2s ease;')).toEqual([200]);
    expect(parse('  transition: transform .15s ease;')).toEqual([150]);
    expect(parse('  transition: opacity 250ms ease;')).toEqual([250]);
    expect(parse('  animation: spin 1.3s linear infinite;')).toEqual([1300]);
  });

  it('선언 파서가 한 줄 규칙의 선택자를 떼어낸다', () => {
    // `.x { transition: … }` 처럼 선택자와 선언이 같은 줄이면 선택자가 검사를 가린다.
    const strip = (piece: string) =>
      piece.replace(/^[\s\S]*\{/, '').replace(/\}\s*$/, '').trim();
    expect(strip('.zz { transition: transform 250ms ease')).toBe('transition: transform 250ms ease');
    expect(strip('  transition: opacity 200ms var(--ease-out)')).toBe('transition: opacity 200ms var(--ease-out)');
    expect(strip(' color: red }')).toBe('color: red');
  });

  it('규칙 5 가 속성 이름만 보고 지속시간 숫자에 속지 않는다', () => {
    const LAYOUT = ['width', 'height', 'margin', 'padding', 'top', 'left', 'right', 'bottom'];
    const t = (l: string) => {
      const m = l.match(/transition(?:-property)?:\s*([^;{}]+)/);
      if (!m) return null;
      const props = m[1].split(',').map((seg) => seg.trim().split(/\s+/)[0]);
      return props.some((p) => LAYOUT.includes(p)) ? l : null;
    };
    expect(probe(['  transition: width 200ms ease;'], t)).toBe(1);
    // "transform" 은 "top"/"left" 를 포함하지 않는다 — 부분일치 오탐 방지 확인
    expect(probe(['  transition: transform 200ms var(--ease-out);'], t)).toBe(0);
  });
});
