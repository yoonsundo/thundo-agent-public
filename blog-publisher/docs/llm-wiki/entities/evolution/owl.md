# 엔티티 — owl 진화 이력 (현재 v3)

> owl(AI 퀀트·트레이딩 수집) 에이전트의 EVOLVE-BLOCK 버전 연표. SEED:locked 변경은 기록하지 않는다(영구 불변).
> frontmatter 는 에이전트 자가수정이 영구 금지이며, 인간 결정에 의한 변경만 예외적으로 이 연표에 기록한다.
> 자가발전 메커니즘 일반은 [../../concepts/self-evolution.md](../../concepts/self-evolution.md).

- **역할**: AI 퀀트·트레이딩 수집 (v3부터 — v2까지는 심층·근거 수집)
- **단계**: 1
- **현재 버전**: v3
- **정의 파일**: `.claude/agents/owl.md`

## 버전 연표

| 버전 | 날짜 | 주요 변경(EVOLVE-BLOCK) | 트리거 | 출처(iter/commit) |
|------|------|------------------------|--------|------------------|
| v1 | 2026-06-26 | 초기 심층 수집 계약 | 프로젝트 시작 | Phase1 MVP (9a0c255) |
| v2 | 2026-06-26 | 주제 선정 루브릭 승급 | 선정 품질 정량화 | iter8 (c5e19be) |
| v3 | 2026-07-02 | 수집 도메인을 AI 퀀트·트레이딩으로 전환(5카테고리: 방법론·논문·실구축·오픈소스·사례), magpie 독립 채널 원칙, SEED에 투자자문 금지 추가. **인간 결정으로 frontmatter tools 에 WebFetch·WebSearch 부여**(논문·오픈소스 수집 필수 — 자가수정 아님, hummingbird 선례) | 사용자 요청: 발행 레퍼런스 Reddit 일변도 교정 + 퀀트 니치 확장 | 인간 개정 (2026-07-02 세션) |

> 주: 작가(beaver/fox/wolf)의 v1→v5는 iter7 단일 라운드 내 토너먼트 선택의 결과로, 중간 v2~v4는
> 채택되지 않은 후보다(채택분만 version 증가). 과거 진화는 Phase 3 자율루프가 아니라 사람 주도
> self-improve 30 iteration의 산물 — 자세히는 [../../concepts/self-evolution.md](../../concepts/self-evolution.md) "현재 상태: OFF".

## 관련

- [../agent-registry.md](../agent-registry.md) — 전체 에이전트 현재 버전·역할
- [index.md](index.md) — 진화 이력 페이지 카탈로그
- [../../concepts/self-evolution.md](../../concepts/self-evolution.md) — 자가발전 메커니즘·경계
