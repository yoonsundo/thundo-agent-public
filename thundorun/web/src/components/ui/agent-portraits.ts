/**
 * agent-portraits — 마스코트 초상을 보유한 에이전트 id 집합.
 *
 * 실제 파일은 `public/agent-portraits/<id>.jpg` (208x208, 사용자 소유 punchgrow 크리처 자산).
 * 출처·매핑 근거는 `public/agent-portraits/_source.json`.
 *
 * ⚠ 목록을 파일 시스템 스캔이 아니라 **명시 집합**으로 두는 이유: 서버 컴포넌트에서 fs 를 읽으면
 *   빌드/런타임 환경에 따라 결과가 갈리고, 정적 배포에서 조용히 빈 목록이 된다. 여기에 적힌
 *   id 만 초상을 쓰고 나머지는 lucide 역할 아이콘 → 모노그램으로 떨어진다.
 * ⚠ 파일을 추가·삭제하면 이 목록도 같이 고쳐야 한다 — 단위 테스트가 둘의 일치를 강제한다.
 */
export const AGENT_PORTRAITS = new Set<string>([
  'badger', 'beaver', 'bee', 'cheetah', 'crane', 'deer',
  'dev-architect', 'dev-coder', 'dev-designer', 'dev-devops', 'dev-orchestrator', 'dev-planner',
  'dev-security', 'dev-tester', 'dev-verifier', 'dolphin', 'eagle', 'elephant',
  'falcon', 'fennec', 'firefly', 'fox', 'goose', 'hedgehog',
  'heron', 'hummingbird', 'lion', 'lynx', 'magpie', 'meerkat',
  'mole', 'nightingale', 'owl', 'panther', 'parrot', 'peacock',
  'penguin', 'raccoon', 'raven', 'rhino', 'robin', 'sheepdog',
  'spider', 'swan', 'wolf', 'woodpecker',
]);
