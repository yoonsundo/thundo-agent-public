/**
 * PortfolioPreview.tsx — 포트폴리오 사용자 화면의 관리자 전용 미리보기 (클라이언트)
 *
 * 카드 구조(사용자 요구 그대로): 제목 → 요약 → 기술스택 → 구축 방식
 * (순차 다이어그램 `.stepper` 를 위에, 아래에 1·2·3 번호 설명 `<ol>`) → 관점 노트.
 * 상단 `.tabs` 로 인사담당자/현업담당자/CEO 페르소나를 전환하면 전 카드의 관점 문단이 바뀐다.
 *
 * 표현은 Modernist Kit 등록 클래스만 사용(globals.css 무추가 — design-guard 대상).
 * 데이터(title 등)에 든 이모지는 허용 대상이지만 이 소스에는 이모지를 쓰지 않는다(규칙 8).
 * 추후 공개 전환 시 이 컴포넌트를 (site) 라우트에서 그대로 재사용한다.
 */
'use client';

import { useState } from 'react';
import type { ProjectRow } from '@/server/projects';

const PERSONAS = [
  { key: 'hr',    label: '인사담당자 관점',  hint: '비전공자도 읽히는 역량·스토리' },
  { key: 'field', label: '현업담당자 관점',  hint: '아키텍처 결정과 트레이드오프' },
  { key: 'ceo',   label: 'CEO 관점',        hint: '비용·리스크·비즈니스 임팩트' },
] as const;
type PersonaKey = (typeof PERSONAS)[number]['key'];

/**
 * role 문자열("A · B · C")을 항목 배열로 끊는다.
 *
 * 담당 역할은 카드를 펼쳤을 때 가장 먼저 확인하는 정보인데 한 줄 회색 메타(.card-meta,
 * 11px·불투명도 50%)로 두면 요약문에 묻혀 안 읽힌다. 구분자로 끊어 칩으로 세우면
 * "무엇을 맡았나"가 훑어보는 속도로 들어온다. 구분자가 없으면 통문장 1개로 그대로 둔다.
 */
export function splitRole(role: string | undefined | null): string[] {
  return (role ?? '').split('·').map((s) => s.trim()).filter(Boolean);
}

export function ProjectCard({
  p,
  persona,
  className = '',
}: {
  p: ProjectRow;
  persona: PersonaKey;
  className?: string;
}) {
  const d = p.detail;
  const roleParts = splitRole(p.role);
  return (
    // 접힌 상태 = 제목 + 요약만(사용자 요구). 클릭하면 상세가 펼쳐진다 — 킷 .accordion(native details).
    // 기간(period)은 채용 화면에서 정보값이 낮아 표시하지 않는다(데이터는 보존).
    <details className={`accordion ${className}`.trim()}>
      <summary>
        <span>
          {/* h2 유지 — 스크린리더 heading 탐색 보존(리뷰 note). .accordion > summary 가 flex 라 레이아웃 무영향. */}
          <h2 className="card-title">{p.title}</h2>
          <span className="accordion-sub">{d?.summary ?? p.description}</span>
        </span>
      </summary>

      <div className="accordion-body stack">
        {/* 담당 역할 — 기술 스택과 같은 라벨 섹션으로 올리고, 강조색 칩(tag-accent)으로
            중립 칩인 스택과 구분한다. 카드에서 유일한 강조색 칩이라 시선이 여기 먼저 간다. */}
        {roleParts.length > 0 ? (
          <div className="stack-2">
            <span className="card-kicker">담당 역할</span>
            <div className="toolbar">
              {roleParts.map((r, i) => (
                <span key={`${r}-${i}`} className="tag tag-accent">{r}</span>
              ))}
            </div>
          </div>
        ) : null}

        {/* 관점 노트 — 독자(탭 선택) 맞춤 피치를 맨 앞에. 채용 문서는 첫 문단이 승부처다. */}
        {d?.personas?.[persona] ? (
          <div className="banner" data-tone="info">
            <p>{d.personas[persona]}</p>
          </div>
        ) : null}

        {/* 기술 스택 — 라벨 있는 명시 섹션 */}
        <div className="stack-2">
          <span className="card-kicker">기술 스택</span>
          <div className="toolbar">
            {p.stack.map((s) => (
              <span key={s} className="tag tag-neutral">{s}</span>
            ))}
          </div>
        </div>

        {/* 구축 방식 — 누구나 읽히는 순차 다이어그램(위) + 번호 설명(아래) */}
        {d && d.flow.length > 0 ? (
          <div className="stack-2">
            <span className="card-kicker">구축 방식</span>
            <div className="table-scroll">
              <ol className="stepper">
                {d.flow.map((s) => (
                  <li key={s.label}>{s.label}</li>
                ))}
              </ol>
            </div>
            <ol className="stack-2">
              {d.flow.map((s) => (
                <li key={s.label}>
                  <strong>{s.label}</strong> — {s.desc}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {/* 기술 노트 — 개발자용 항목(무슨 API·무슨 모델)을 쉬운 문장으로 */}
        {d?.tech && d.tech.length > 0 ? (
          <div className="stack-2">
            <span className="card-kicker">기술 노트</span>
            <ul className="stack-2">
              {d.tech.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {p.link ? (
          <div className="row-end">
            <a className="btn btn-ghost btn-sm" href={p.link}>실물 화면 보기</a>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export default function PortfolioPreview({ projects }: { projects: ProjectRow[] }) {
  const [persona, setPersona] = useState<PersonaKey>('hr');
  const active = PERSONAS.find((x) => x.key === persona);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">포트폴리오 미리보기</h1>
          <p className="page-sub">
            사용자에게 보일 화면의 관리자 전용 미리보기입니다. 공개 전까지 이 화면은 관리자에게만 노출됩니다.
          </p>
        </div>
      </header>

      <div className="stack-6">
        <div className="stack-2">
          <div className="tabs" role="tablist" aria-label="읽는 사람 관점">
            {PERSONAS.map((x) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                className="tab"
                aria-selected={persona === x.key}
                onClick={() => setPersona(x.key)}
              >
                {x.label}
              </button>
            ))}
          </div>
          {active ? <p className="text-muted">{active.hint}</p> : null}
        </div>

        {/* 2열 배치(사용자 요구) — 킷 grid-2 는 900px 이하에서 자동 1열.
            grid-start: 아코디언 하나를 펼쳐도 같은 행의 접힌 카드가 빈 박스로 늘어나지 않게. */}
        <div className="grid-2 grid-start">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} persona={persona} />
          ))}
        </div>
      </div>
    </main>
  );
}
