export const dynamic = 'force-dynamic';

import { Rocket, Mail, Bird, Activity, Globe, RefreshCw, Stethoscope } from 'lucide-react';
import { getActiveAgents } from '@/server/agents';
import AgentAvatar from '@/components/ui/AgentAvatar';
import Empty from '@/components/state/Empty';
import PipelineTree from './PipelineTree';

export const metadata = {
  title: '에이전트 소개 — Thundo',
  description:
    '블로그 자동발행 파이프라인을 함께 운영하는 AI 에이전트 팀을 소개합니다. 수집, 집필, 품질 검증, 발행, 감사까지 각 에이전트의 역할을 확인하세요.',
};

const SCHEDULE = [
  {
    time: '매일 09:07',
    title: '일일 발행 런 시작',
    desc: '수집 · 주제 선정 · 집필 · 게이트 15종 · 검증자 5명 · 발행 순으로 진행되며, 통상 40~60분 소요됩니다.',
    icon: Rocket,
  },
  {
    time: '매일 09:50 무렵',
    title: 'SEO/AEO 성과 브리핑 도착',
    desc: '런 종료 직후 발행 결과·검색 성과 내러티브 브리핑이 발송되고, 에이전트 일지가 갱신됩니다.',
    icon: Mail,
  },
  {
    time: '평일 09:00',
    title: 'Parrot 외부 프로젝트 브리핑',
    desc: '관리 중인 외부 개발 프로젝트를 읽기전용으로 조사해 상세 브리핑을 보냅니다. 주말·공휴일은 다음 평일에 묶어 발송합니다.',
    icon: Bird,
  },
  {
    time: '매일 09:03',
    title: 'Woodpecker 서버 관제 브리핑',
    // 관찰 대상은 거래처 자산이라 이름을 공개 페이지에 적지 않는다.
    desc: '외부 개발 서버의 인프라 건강을 읽기전용으로 점검해 이상 징후를 브리핑합니다.',
    icon: Activity,
  },
  {
    time: '매일 09:05',
    title: 'Goose 사이트 관제 브리핑',
    desc: '이 블로그(thundo.kr)의 홈·블로그·사이트맵 응답과 속도를 바깥에서 실측해 브리핑합니다.',
    icon: Globe,
  },
  {
    time: '일요일 10:30',
    title: '주간 AEO/SEO 방법론 사이클',
    desc: 'Hummingbird가 최신 SEO/AEO 방법론을 수집하고, 승격 게이트와 검증자 진화까지 한 사이클을 돌립니다.',
    icon: RefreshCw,
  },
  {
    time: '상시',
    title: '건강검진 · 자가복구',
    desc: 'Crane이 에이전트 이상을 감지하고, 워치독이 5분 주기로 멈춘 데몬을 자동 재가동합니다.',
    icon: Stethoscope,
  },
];

export default async function AgentsPage() {
  const agents = await getActiveAgents();

  return (
    <div className="container">
      {/* 페이지 헤더 */}
      <div className="page-head">
        <div>
          <p className="kicker">AI 에이전트 팀</p>
          <h1 className="page-title" style={{ marginTop: 'var(--space-1)' }}>에이전트 소개</h1>
          <p className="text-muted" style={{ marginTop: 'var(--space-2)', maxWidth: '64ch' }}>
            블로그 자동발행 파이프라인을 함께 운영하는 AI 에이전트 팀 소개입니다. 트렌드 수집부터
            초안 집필, 사실 검증, 발행, 거버넌스 감사까지 각 에이전트가 전담 역할을 수행합니다.
          </p>
        </div>
      </div>

      {/* 빈 상태 */}
      {agents.length === 0 ? (
        <Empty title="등록된 에이전트가 없습니다" body="아직 에이전트 정보가 준비되지 않았습니다. 잠시 후 다시 확인해 주세요." />
      ) : (
        <div className="grid-3">
          {agents.map((agent) => (
            <div key={agent.id} id={`agent-${agent.id}`} className="card" style={{ scrollMarginTop: 96 }}>
              {/* 아바타 — 마스코트 마크 · lucide 역할 아이콘 · 모노그램 3층 (DESIGN.md §12.12).
                  ⚠ 이전에는 `name.slice(0, 1)` 이라 6개 군 13명이 첫 글자에서 충돌했다
                  (라=라이언·라이노·라쿤 등). 사진 처리는 §12.11 — 흑백으로 만들지 않는다. */}
              <AgentAvatar id={agent.id} name={agent.name} imageUrl={agent.image_url} />

              {/* 이름 */}
              <span className="card-title">{agent.name}</span>

              {/* 역할 배지 */}
              <span className="tag tag-accent">{agent.role}</span>

              {/* 설명 */}
              <p className="card-body">{agent.description}</p>
            </div>
          ))}
        </div>
      )}

      {/* 운영 스케줄 — 브리핑·런이 도는 시간 (KST) */}
      <div style={{ marginTop: 'var(--space-12)' }}>
        <p className="kicker">운영 스케줄 (KST)</p>
        <h2 style={{ marginTop: 'var(--space-1)' }}>브리핑은 언제 오나요</h2>
        <p className="text-muted" style={{ marginTop: 'var(--space-2)', maxWidth: '64ch' }}>
          에이전트 팀은 아래 시간표대로 자동 가동됩니다. 발행 결과와 SEO/AEO 성과 브리핑은 매일
          아침 런이 끝나는 대로 도착합니다.
        </p>

        <div className="grid-2" style={{ marginTop: 'var(--space-4)' }}>
          {SCHEDULE.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="card" style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <span className="avatar avatar-neutral" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <div>
                  <span className="tag tag-accent">{item.time}</span>
                  <p className="card-title" style={{ marginTop: 'var(--space-2)' }}>{item.title}</p>
                  <p className="card-body">{item.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <PipelineTree />
    </div>
  );
}
