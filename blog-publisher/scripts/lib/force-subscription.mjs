// scripts/lib/force-subscription.mjs — import 하는 순간 process.env.ANTHROPIC_API_KEY 를
// 제거해, 이 프로세스가 spawn 하는 모든 claude 가 구독(Claude Code OAuth) 인증을 쓰도록
// 강제한다(API 종량제 방지). claudeText/agent-runner 를 안 거치고 claude 를 직접 spawn 하는
// 스크립트(브리핑·디자인·selfheal·naver 등)용 방어선.
// 부작용 전용 모듈: `import '../lib/force-subscription.mjs';` 한 줄로 적용.
if (process.env.ANTHROPIC_API_KEY) delete process.env.ANTHROPIC_API_KEY;
