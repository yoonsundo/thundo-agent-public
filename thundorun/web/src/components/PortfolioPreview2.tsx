/**
 * PortfolioPreview2.tsx — 현업 담당자 관점으로 정리한 두 번째 포트폴리오 미리보기.
 *
 * 기존 미리보기는 세 독자 관점을 비교하는 화면으로 보존하고, 이 화면은 채용 현업 담당자가
 * 개인 작업과 회사 경력을 빠르게 구분해 읽도록 두 카테고리만 제공한다.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Empty from '@/components/state/Empty';
import ConfirmDialog from '@/app/admin/ConfirmDialog';
import { ProjectCard } from '@/components/PortfolioPreview';
import PortfolioProjectEditor from '@/components/PortfolioProjectEditor';
import type { ProjectRow } from '@/server/projects';

export type PortfolioCategory = 'personal' | 'career';

const CAREER_PROJECT_IDS = new Set([
  'ai-rag-platform',
  'multi-agent-chat-analytics',
  'llm-report-automation',
  'tmoney-monitoring',
  'incheon-university-information-system',
  'chungcheong-university-information-system',
  'duksung-womens-university-information-system',
  'jangan-university-information-system',
]);

const EMOJI_SEQUENCE_RE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu;

const CATEGORY_TABS: Array<{
  id: PortfolioCategory;
  label: string;
  description: string;
}> = [
  {
    id: 'personal',
    label: '개인 프로젝트',
    description: '업무 외에 직접 기획하고 구현한 프로젝트입니다.',
  },
  {
    id: 'career',
    label: '경력기술',
    description: '회사에서 맡아 개발하거나 운영한 프로젝트입니다.',
  },
];

export function getPortfolioCategory(project: ProjectRow): PortfolioCategory {
  return project.detail?.category
    ?? (CAREER_PROJECT_IDS.has(project.id) ? 'career' : 'personal');
}

export function stripProjectTitleEmoji(title: string): string {
  return title.replace(EMOJI_SEQUENCE_RE, ' ').replace(/\s+/g, ' ').trim();
}

function CategoryPanel({
  id,
  title,
  description,
  projects,
  onEdit,
  onDelete,
}: {
  id: PortfolioCategory;
  title: string;
  description: string;
  projects: ProjectRow[];
  onEdit: (project: ProjectRow) => void;
  onDelete: (project: ProjectRow) => void;
}) {
  const tabId = `portfolio-${id}-tab`;
  const panelId = `portfolio-${id}-panel`;

  return (
    <section
      id={panelId}
      className="stack-2"
      role="tabpanel"
      aria-labelledby={tabId}
    >
      <div className="section-head">
        <h2>{title}</h2>
        <span className="tag tag-neutral">{projects.length}개</span>
      </div>
      <p className="text-muted">{description}</p>

      {projects.length > 0 ? (
        <div className="grid-2" role="group" aria-label={`${title} 카드`}>
          {projects.map((project) => {
            const displayedProject = id === 'personal'
              ? { ...project, title: stripProjectTitleEmoji(project.title) || '개인 프로젝트' }
              : project;

            return (
              <div key={project.id} className="stack-2">
                <ProjectCard
                  p={displayedProject}
                  persona="field"
                  className="portfolio-card"
                />
                <div className="row portfolio-card-actions">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => onEdit(project)}
                  >
                    수정
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => onDelete(project)}
                  >
                    삭제
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty
          title={`${title}가 아직 없습니다`}
          body="프로젝트 관리에서 항목을 추가하면 이 구역에 표시됩니다."
        />
      )}
    </section>
  );
}

export default function PortfolioPreview2({ projects }: { projects: ProjectRow[] }) {
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<PortfolioCategory>('personal');
  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [deleting, setDeleting] = useState<ProjectRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/admin/projects?id=${encodeURIComponent(deleting.id)}`, {
        method: 'DELETE',
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setDeleteError(j.error || `삭제 실패 (${res.status})`);
        return;   // 실패하면 다이얼로그를 닫지 않는다
      }
      setDeleting(null);
      router.refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : '알 수 없는 오류');
    } finally {
      setDeleteBusy(false);
    }
  }

  const personal = projects.filter((project) => getPortfolioCategory(project) === 'personal');
  const career = projects.filter((project) => getPortfolioCategory(project) === 'career');
  const projectGroups: Record<PortfolioCategory, ProjectRow[]> = { personal, career };
  const activeTab = CATEGORY_TABS.find((tab) => tab.id === activeCategory) ?? CATEGORY_TABS[0];

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">포트폴리오 미리보기 2</h1>
          <p className="page-sub">
            현업 담당자가 구현 방식과 기술적 판단을 빠르게 검토할 수 있도록 정리한 화면입니다.
          </p>
        </div>
      </header>

      {projects.length === 0 ? (
        <Empty
          title="표시할 포트폴리오가 없습니다"
          body="프로젝트 관리에서 포트폴리오 항목을 먼저 등록해 주세요."
        />
      ) : (
        <div className="stack-6">
          <div className="tabs" role="tablist" aria-label="프로젝트 분류">
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.id}
                id={`portfolio-${tab.id}-tab`}
                type="button"
                role="tab"
                className="tab"
                aria-selected={activeCategory === tab.id}
                aria-controls={`portfolio-${tab.id}-panel`}
                onClick={() => setActiveCategory(tab.id)}
              >
                {tab.label} {projectGroups[tab.id].length}
              </button>
            ))}
          </div>

          <CategoryPanel
            id={activeTab.id}
            title={activeTab.label}
            description={activeTab.description}
            projects={projectGroups[activeTab.id]}
            onEdit={setEditing}
            onDelete={(project) => { setDeleteError(''); setDeleting(project); }}
          />
        </div>
      )}

      {editing && (
        <PortfolioProjectEditor
          project={editing}
          category={getPortfolioCategory(editing)}
          onSaved={() => { setEditing(null); router.refresh(); }}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="프로젝트 삭제"
          body={`"${deleting.title}" 을(를) 삭제합니다. 되돌릴 수 없습니다.`}
          confirmLabel="삭제"
          cancelLabel="취소"
          tone="danger"
          busy={deleteBusy}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        >
          {deleteError && <span className="field-error" role="alert">{deleteError}</span>}
        </ConfirmDialog>
      )}
    </main>
  );
}
