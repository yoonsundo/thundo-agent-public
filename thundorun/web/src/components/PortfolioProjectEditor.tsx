'use client';

/**
 * PortfolioProjectEditor — 포트폴리오 미리보기 2 의 카드별 수정 다이얼로그.
 *
 * `/admin/portfolio-2` 는 이미 admin role 게이트 뒤에 있고, 저장은 `/api/admin/projects`
 * (핸들러에서 role 재검증)로 나간다 — 화면 게이트와 서버 게이트가 둘 다 걸린다.
 *
 * ⚠ 상세(detail: summary·flow·personas·tech)는 여기서 편집하지 않는다. 서버의 upsert 가
 * detail 을 아예 보내지 않아 DB 값을 보존하는 계약이라, 폼이 그 필드를 건드리면 안 된다.
 * 분류(detail.category)만 예외로 서버의 별도 경로(setProjectCategory)를 통해 바뀐다.
 */
import { useState } from 'react';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import type { ProjectRow } from '@/server/projects';
import type { PortfolioCategory } from '@/components/PortfolioPreview2';

export interface ProjectEditPayload {
  id: string;
  title: string;
  period: string;
  role: string | null;
  stack: string[];
  description: string;
  highlights: string[];
  link: string | null;
  sort_order: number;
  pinned: boolean;
  category: PortfolioCategory;
}

/** 폼 상태 → 저장 페이로드. 빈 문자열은 null 로 눕혀 서버 기본값과 어긋나지 않게 한다. */
export function toEditPayload(form: ProjectEditPayload): ProjectEditPayload {
  return {
    ...form,
    title: form.title.trim(),
    role: form.role?.trim() ? form.role.trim() : null,
    link: form.link?.trim() ? form.link.trim() : null,
    stack: form.stack.map((s) => s.trim()).filter(Boolean),
    highlights: form.highlights.map((s) => s.trim()).filter(Boolean),
  };
}

export default function PortfolioProjectEditor({
  project,
  category,
  onSaved,
  onClose,
}: {
  project: ProjectRow;
  category: PortfolioCategory;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ProjectEditPayload>({
    id: project.id,
    title: project.title,
    period: project.period ?? '',
    role: project.role ?? '',
    stack: project.stack ?? [],
    description: project.description ?? '',
    highlights: project.highlights ?? [],
    link: project.link ?? '',
    sort_order: project.sort_order ?? 0,
    pinned: project.pinned === true,
    category,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!form.title.trim()) { setError('제목은 비울 수 없습니다.'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toEditPayload(form)),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError(j.error || `저장 실패 (${res.status})`);
        return;   // 실패하면 닫지 않는다 — 입력한 내용을 잃지 않게
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      title="프로젝트 수정"
      confirmLabel="저장"
      cancelLabel="취소"
      tone="primary"
      width={640}
      busy={busy}
      onConfirm={save}
      onClose={onClose}
    >
      <div className="stack-2 editor-body">
        <div className="field">
          <label htmlFor="pe-id">ID (변경 불가)</label>
          {/* disabled 하나로 충분하다 — readOnly 와 겹치고, disabled 라야 다이얼로그 포커스 트랩에서도 빠진다. */}
          <input id="pe-id" className="input" value={form.id} disabled />
          <span className="field-hint">ID 를 바꾸면 기존 항목이 남고 새 항목이 생깁니다.</span>
        </div>

        <div className="field">
          <label htmlFor="pe-title">제목<span className="req">*</span></label>
          <input
            id="pe-title" className="input" value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="pe-category">분류</label>
          <select
            id="pe-category" className="input" value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value as PortfolioCategory })}
          >
            <option value="personal">개인 프로젝트</option>
            <option value="career">경력기술</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="pe-period">기간</label>
          <input
            id="pe-period" className="input" value={form.period}
            onChange={(e) => setForm({ ...form, period: e.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="pe-role">역할</label>
          <input
            id="pe-role" className="input" value={form.role ?? ''}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="pe-sort">정렬 순서</label>
          <input
            id="pe-sort" className="input" type="number" value={form.sort_order}
            onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })}
          />
        </div>

        <div className="field">
          <label className="switch">
            <input
              type="checkbox" checked={form.pinned}
              onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
            />
            <span className="track" />
            상단 고정
          </label>
          <span className="field-hint">상한을 넘기면 저장이 거부되고 사유가 표시됩니다.</span>
        </div>

        <div className="field">
          <label htmlFor="pe-stack">스택 (쉼표 구분)</label>
          <input
            id="pe-stack" className="input" value={form.stack.join(', ')}
            onChange={(e) => setForm({ ...form, stack: e.target.value.split(',') })}
          />
        </div>

        <div className="field">
          <label htmlFor="pe-desc">설명</label>
          <textarea
            id="pe-desc" className="input" rows={3} value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="pe-high">하이라이트 (한 줄에 하나)</label>
          <textarea
            id="pe-high" className="input" rows={5} value={form.highlights.join('\n')}
            onChange={(e) => setForm({ ...form, highlights: e.target.value.split('\n') })}
          />
        </div>

        <div className="field">
          <label htmlFor="pe-link">링크 (없으면 비움)</label>
          <input
            id="pe-link" className="input" value={form.link ?? ''}
            onChange={(e) => setForm({ ...form, link: e.target.value })}
          />
        </div>

        <span className="field-hint">
          상세 설명(요약·진행 흐름·관점별 문단·기술 노트)은 이 폼에서 건드리지 않습니다 — 그대로 보존됩니다.
        </span>

        {error && <span className="field-error" role="alert">{error}</span>}
      </div>
    </ConfirmDialog>
  );
}
