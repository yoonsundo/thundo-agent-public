import AgentAvatar from '@/components/ui/AgentAvatar';
/**
 * PipelineTree — 팀별 접이식 워크플로 (각 팀 내부는 top→bottom).
 *
 * 서버 컴포넌트. 네 운영팀은 데스크톱 2열, 900px 이하 1열 아코디언으로 배치한다.
 * 팀별 상세는 기본 접힘이라 모바일에서도 필요한 흐름만 열어 세로 스크롤을 줄인다.
 * 열린 팀 안에서는 단계를 위→아래로 쌓고, 단계 사이는 세로 점선 커넥터로 잇는다.
 * 병렬 단계는 라벨 붙은 점선 서브박스 안에 auto-fit 그리드로 배치해 어떤 화면 폭에서도
 * 가로 스크롤 없이 접힌다(세로 스크롤만). 에이전트 노드는 위 카드(#agent-{id})로 스크롤
 * 이동하는 앵커 링크. 이모지 대신 이니셜 아바타로 노드를 구분한다(DESIGN.md 규칙 8).
 * SVG/이미지/클라이언트 훅 없음.
 */

type NodeVariant = 'trigger' | 'process' | 'agent';

type FlowNode = {
  title: string;
  sub: string;
  href?: string;
  variant: NodeVariant;
};

// 병렬 팬아웃 그룹 — href 의 agent id 는 supabase/agents.sql PK(및 카드 id)와 일치해야 한다.
const COLLECTORS: FlowNode[] = [
  { title: '치타', sub: '트렌드 수집', href: '#agent-cheetah', variant: 'agent' },
  { title: '아울', sub: '심층 수집', href: '#agent-owl', variant: 'agent' },
  { title: '맥파이', sub: '커뮤니티 수집', href: '#agent-magpie', variant: 'agent' },
];

const WRITERS: FlowNode[] = [
  { title: '비버', sub: 'how-to', href: '#agent-beaver', variant: 'agent' },
  { title: '폭스', sub: '리뷰', href: '#agent-fox', variant: 'agent' },
  { title: '울프', sub: '오피니언', href: '#agent-wolf', variant: 'agent' },
];

const VALIDATORS: FlowNode[] = [
  { title: '이글', sub: '사실', href: '#agent-eagle', variant: 'agent' },
  { title: '비', sub: 'SEO', href: '#agent-bee', variant: 'agent' },
  { title: '스완', sub: '편집', href: '#agent-swan', variant: 'agent' },
  { title: '레이븐', sub: '표절', href: '#agent-raven', variant: 'agent' },
  { title: '피콕', sub: '렌더', href: '#agent-peacock', variant: 'agent' },
];

// 상시 지원·관제 — 발행 파이프라인 단계가 아니라 전 과정을 곁에서 돕는 에이전트.
const ALWAYS_ON: (FlowNode & { href: string })[] = [
  { title: '크레인', sub: '건강검진', href: '#agent-crane', variant: 'agent' },
  { title: '미어캣', sub: '관제탑', href: '#agent-meerkat', variant: 'agent' },
  { title: '허밍버드', sub: 'SEO 방법론', href: '#agent-hummingbird', variant: 'agent' },
  { title: '패럿', sub: '일일 브리핑', href: '#agent-parrot', variant: 'agent' },
  { title: '스파이더', sub: '정찰·분석', href: '#agent-spider', variant: 'agent' },
];

// 팀장(C레벨) — 파이프라인을 **실행하지 않는다.** 매일 CEO와 경영회의를 열어 성과를 브리핑하고
// 다음 전략을 제안하는 자리다. 그래서 팀 실행 흐름 안이 아니라 별도 박스로 둔다 —
// 흐름 안에 끼워 넣으면 "팀장을 거쳐야 글이 나간다"는 잘못된 그림이 된다.
const LEADS: (FlowNode & { href: string })[] = [
  { title: '팰컨', sub: '블로그팀장 · CPO', href: '#agent-falcon', variant: 'agent' },
  { title: '돌핀', sub: '유튜브팀장 · CMO', href: '#agent-dolphin', variant: 'agent' },
  { title: '라이노', sub: '개발팀장 · CTO', href: '#agent-rhino', variant: 'agent' },
  { title: '팬서', sub: '인스타팀장 · CBO', href: '#agent-panther', variant: 'agent' },
];

// 개발팀 병렬 검토 — 코더 산출물을 테스터·보안이 동시에 검토(둘 다 통과해야 검증자로).
const DEV_REVIEW: FlowNode[] = [
  { title: '테스터', sub: '동작 검증', href: '#agent-dev-tester', variant: 'agent' },
  { title: '보안', sub: '보안 검토', href: '#agent-dev-security', variant: 'agent' },
];

/**
 * 노드 아바타 — href(`#agent-<id>`)에서 에이전트 id 를 뽑아 프로필 카드와 **같은 얼굴**을 쓴다.
 *
 * ⚠ 이전에는 `title.slice(0, 1)` 이라 흐름도에서도 첫 글자가 겹쳤다 — 이 화면 안에서만도
 *   "기능·신메뉴 요청"과 "기획자"가 둘 다 "기" 였다. 카드 쪽은 초상으로 고쳤는데 흐름도만
 *   남으면 같은 에이전트가 두 화면에서 다르게 보인다.
 * id 가 없는 노드(트리거·처리 단계)는 아바타를 쓰지 않는다 — 사람이 아니라 단계다.
 */
function NodeAvatar({ title, href }: { title: string; href?: string }) {
  const id = href?.startsWith('#agent-') ? href.slice('#agent-'.length) : '';
  if (!id) return null;
  return <AgentAvatar id={id} name={title} sizeClass="" />;
}

/** 노드 — 부모 트랙을 채운다. agent는 앵커 링크, trigger/process는 정적 노드. */
function Node({ title, sub, href, variant }: FlowNode) {
  const isAgent = variant === 'agent';
  const style: React.CSSProperties = {
    width: '100%',
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-3)',
    textAlign: 'left',
    borderStyle: variant === 'trigger' ? 'dashed' : undefined,
  };
  const cls = `card${isAgent ? ' card-link' : ' card-outline'}`;

  const inner = (
    <>
      <NodeAvatar title={title} href={href} />
      <span style={{ minWidth: 0 }}>
        <span className="card-title" style={{ display: 'block' }}>
          {title}
        </span>
        <span className="card-meta">{sub}</span>
      </span>
    </>
  );

  if (isAgent && href) {
    return (
      <a href={href} className={cls} style={style}>
        {inner}
      </a>
    );
  }
  return (
    <div className={cls} style={style}>
      {inner}
    </div>
  );
}

/** 세로 점선 커넥터 — 단계 사이의 세로선. label은 선 위 알약 배지. */
function VConnector({ label }: { label?: string }) {
  return (
    <div className="row" style={{ justifyContent: 'center' }}>
      <div
        style={{
          position: 'relative',
          width: 1,
          height: label ? 44 : 28,
          borderLeft: '1px dashed var(--color-hairline)',
        }}
        aria-hidden="true"
      >
        {label ? (
          <span
            className="tag tag-neutral"
            style={{
              position: 'absolute', left: '50%', top: '50%',
              transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 단일 단계 — 노드 하나를 가로 중앙에. */
function Stage({ node }: { node: FlowNode }) {
  return (
    <div className="row" style={{ justifyContent: 'center', width: '100%', maxWidth: 184, margin: '0 auto' }}>
      <Node {...node} />
    </div>
  );
}

/** 병렬 그룹 — auto-fit 최소폭 그리드. 모바일에서도 가능한 경우 2열을 유지한다. */
function ParallelGroup({ items }: { items: FlowNode[] }) {
  return (
    <div
      className="grid-auto-sm"
      style={{
        margin: '0 auto', width: '100%',
        border: '1px dashed var(--color-hairline)', borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-3)',
      }}
    >
      {items.map((it) => (
        <Node key={it.title} {...it} />
      ))}
    </div>
  );
}

/** 상시 감시 플로팅 노드 — 원형(circle), 흐름과 분리. 라벨은 flush left(규칙 3). */
function FloatingNode({ title, sub, href }: FlowNode & { href: string }) {
  return (
    <a href={href} className="stack-2 card-link" style={{ width: 104 }}>
      <NodeAvatar title={title} href={href} />
      <span className="card-title">{title}</span>
      <span className="card-meta">{sub}</span>
    </a>
  );
}

/** 파이프라인 하나를 감싸는 native details. 기본 접힘이라 긴 페이지와 모바일 스크롤을 줄인다. */
function PipelineBox({
  label,
  summary,
  children,
}: {
  label: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="accordion">
      <summary>
        <span>
          <span className="card-title">{label}</span>
          <span className="accordion-sub">{summary}</span>
        </span>
      </summary>
      <div className="accordion-body">
        <div className="stack">{children}</div>
      </div>
    </details>
  );
}

export default function PipelineTree() {
  return (
    <section aria-label="워킹 트리 파이프라인" style={{ marginTop: 'var(--space-12)' }}>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <p className="kicker">워킹 트리</p>
        <h2 style={{ marginTop: 'var(--space-1)' }}>파이프라인</h2>
        <p className="text-muted" style={{ marginTop: 'var(--space-2)' }}>
          경영회의 1 · 4개 팀 · 필요한 흐름만 펼쳐서 확인 · 노드를 누르면 에이전트 카드로 이동
        </p>
        <p className="text-muted">
          팀 이름을 클릭하면 실제 업무 순서와 담당 에이전트가 단계별로 펼쳐집니다. 흐름 안의
          에이전트 노드를 누르면 위 역할 카드로 바로 이동합니다.
        </p>
      </div>

      {/* 캔버스 — 데스크톱 2열, 900px 이하 1열. 팀 내부만 세로 흐름. */}
      <div className="card-outline" style={{ padding: 'var(--space-6) var(--space-4)' }}>
        {/* 경영회의 — 네 팀 위의 의사결정 계층. 실행이 아니라 전략·판정이 일어나는 자리다. */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <PipelineBox label="경영회의 · 매일 09:20" summary="CEO 1인 · 팀장 4인 · 브리핑과 반론">
            <Stage node={{ title: '라이언', sub: 'CEO · 악마의 대변인', href: '#agent-lion', variant: 'agent' }} />
            <VConnector label="브리핑" />
            <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center', gap: 'var(--space-6)' }}>
              {LEADS.map((a) => (
                <FloatingNode key={a.title} {...a} />
              ))}
            </div>
          </PipelineBox>
        </div>

        <div className="grid-2 grid-start">
          {/* 마케팅 팀 — 블로그 발행 파이프라인 */}
          <PipelineBox label="마케팅 팀 · 블로그 발행" summary="수집부터 발행·감사까지 · 8단계 · 팀장 팰컨">
            <Stage node={{ title: '매일 아침 실행', sub: '스케줄 트리거', variant: 'trigger' }} />
            <VConnector />
            <Stage node={{ title: '라이언', sub: '오케스트레이터', href: '#agent-lion', variant: 'agent' }} />
            <VConnector label="병렬 수집" />
            <ParallelGroup items={COLLECTORS} />
            <VConnector />
            <Stage node={{ title: '주제 3개 확정', sub: '라이언 · 주제 선정', href: '#agent-lion', variant: 'agent' }} />
            <VConnector label="병렬 집필" />
            <ParallelGroup items={WRITERS} />
            <VConnector />
            <Stage node={{ title: '품질 게이트 14종', sub: '결정론 검사', variant: 'process' }} />
            <VConnector label="병렬 검증" />
            <ParallelGroup items={VALIDATORS} />
            <VConnector />
            <Stage node={{ title: '펭귄', sub: '발행', href: '#agent-penguin', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '엘리펀트', sub: '거버넌스 감사', href: '#agent-elephant', variant: 'agent' }} />
          </PipelineBox>

          {/* 개발팀 — 홈페이지 기능 추가·신메뉴 개설 파이프라인 */}
          <PipelineBox label="개발팀 · 홈페이지" summary="요청부터 검증·배포까지 · 9단계 · 팀장 라이노">
            <Stage node={{ title: '기능·신메뉴 요청', sub: '운영자 트리거', variant: 'trigger' }} />
            <VConnector />
            <Stage node={{ title: '지휘자', sub: '오케스트레이터', href: '#agent-dev-orchestrator', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '기획자', sub: '스펙 확정', href: '#agent-dev-planner', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '설계자', sub: '구조·데이터모델', href: '#agent-dev-architect', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '디자이너', sub: 'UI 설계', href: '#agent-dev-designer', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '코더', sub: '구현', href: '#agent-dev-coder', variant: 'agent' }} />
            <VConnector label="병렬 검토" />
            <ParallelGroup items={DEV_REVIEW} />
            <VConnector />
            <Stage node={{ title: '검증자', sub: '최종 게이트', href: '#agent-dev-verifier', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '배포담당', sub: '마이그레이션 후 배포', href: '#agent-dev-devops', variant: 'agent' }} />
          </PipelineBox>

          {/* 호기심 쇼츠 팀 — 유튜브 쇼츠 파이프라인 */}
          <PipelineBox label="호기심 쇼츠 · 유튜브" summary="아이디어부터 유튜브 발행까지 · 8단계 · 팀장 돌핀">
            <Stage node={{ title: '매일 10·12·18시', sub: '시차 스케줄', variant: 'trigger' }} />
            <VConnector />
            <Stage node={{ title: '라쿤', sub: '아이디어 발굴', href: '#agent-raccoon', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '링스', sub: '선정', href: '#agent-lynx', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '배저', sub: '팩트체크', href: '#agent-badger', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '나이팅게일', sub: '대본·아트', href: '#agent-nightingale', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '제작 코어', sub: 'AI배경·더빙·조립', variant: 'process' }} />
            <VConnector />
            <Stage node={{ title: '페넥', sub: '총괄 오케', href: '#agent-fennec', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '유튜브 발행', sub: 'staged 업로드', variant: 'process' }} />
          </PipelineBox>

          {/* 카드뉴스 팀 — 인스타그램 카드뉴스 파이프라인 */}
          <PipelineBox label="카드뉴스 · 인스타그램" summary="소재부터 인스타 발행까지 · 9단계 · 팀장 팬서">
            <Stage node={{ title: '하루 2편', sub: '스케줄 트리거', variant: 'trigger' }} />
            <VConnector />
            <Stage node={{ title: '헤론', sub: '소재 발굴', href: '#agent-heron', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '디어', sub: '편성·선정', href: '#agent-deer', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '원문 대조', sub: '고전 전문 확인', variant: 'process' }} />
            <VConnector />
            <Stage node={{ title: '헤지호그', sub: '인용 검증', href: '#agent-hedgehog', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '로빈', sub: '카드 7장 대본', href: '#agent-robin', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '카드 렌더', sub: '인용·일반화 게이트', variant: 'process' }} />
            <VConnector />
            <Stage node={{ title: '파이어플라이', sub: '총괄 오케', href: '#agent-firefly', variant: 'agent' }} />
            <VConnector />
            <Stage node={{ title: '인스타 발행', sub: 'staged 업로드', variant: 'process' }} />
          </PipelineBox>
        </div>

        {/* 상시 감시 — 네 팀 아래의 별도 접이식 클러스터 */}
        <div style={{ marginTop: 'var(--space-4)' }}>
          <PipelineBox label="상시 지원 · 관제" summary="5개 에이전트 · 모든 파이프라인 병행">
            <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'center', gap: 'var(--space-6)' }}>
              {ALWAYS_ON.map((a) => (
                <FloatingNode key={a.title} {...a} />
              ))}
            </div>
          </PipelineBox>
        </div>
      </div>
    </section>
  );
}
