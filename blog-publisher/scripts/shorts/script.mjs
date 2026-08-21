#!/usr/bin/env node
/**
 * shorts/script.mjs — 발행글 1편 → 카드형 쇼츠 대본(JSON) 생성
 *
 * 사용: node scripts/shorts/script.mjs <published/….md>
 *
 * 구독 claude CLI(-p --output-format json)로 30~60초 카드 스크립트를 만든다.
 * 실 LLM 필수(mock 하네스 금지 — 프로젝트 하드 제약). CLI 부재 시 exit 2.
 *
 * 산출: state/shorts-queue/work/<slug>/script.json
 *   { slug, title, backlink, hook, cards:[{caption, narration}], cta }
 * 계약: stdout JSON 1줄 {ok, slug, cards, script_file}. exit 0 / 2=오류
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { parseDoc } from '../lib/published-doc.mjs';
import { loadShortsConfig, workDir, isMainModule } from './lib.mjs';

import { makeClaudeRunner } from '../lib/claude-runner.mjs';
const log = makeLogger('shorts/script');

/**
 * claude 호출은 공용 러너 하나가 맡는다(F-05). 이 파일에 있던 간이판은
 * 재시도도 실패 분류도 없었고, 구독 인증 강제를 `force-subscription` import 한 줄에
 * 의존했다 — 러너를 쓰면 셋 다 공짜로 따라온다.
 *
 * 이 채널의 정책은 진단 출처 이름과 재시도 환경변수뿐이다.
 */
const callClaude = makeClaudeRunner({
  source:        'shorts/script/callClaude',
  retriesEnvVar: 'SHORTS_CLAUDE_RETRIES',
  actionFor:     (kind) => kind === 'cli-missing'
    ? 'claude CLI 부재(구독 LLM 없음) — 대본 생성 불가. PATH 확인 후 재설치.'
    : 'claude 호출 실패 — 다음 슬롯이 재시도한다. 반복되면 로그인·회선을 확인.',
  // 이 채널은 별도 진단 파일을 두지 않는다(런 로그에 구조화 로그가 남는다).
  recordFailure: () => {},
  log,
});

/** 카드 스크립트 생성 프롬프트. 출력은 순수 JSON(코드펜스 허용)만. */
export function buildPrompt(fm, body, backlink, cfg) {
  const min = cfg.script?.min_cards ?? 3;
  const max = cfg.script?.max_cards ?? 5;
  const [sylLo, sylHi] = cfg.script?.narration_syllables_per_card ?? [110, 190];
  return `너는 한국어 유튜브 쇼츠 대본 작가다. 아래 [블로그 원문]을 30~60초 **세로 쇼츠**용 카드 대본으로 압축·재구성하라.

[훅 — 첫 3초가 전부다]
- 스크롤 이탈은 1~1.5초에 결정된다. "안녕하세요/오늘은 ~에 대해" 식 인사·주제소개형 오프닝 금지.
- 이 소재에 가장 잘 맞는 훅 패턴 1개를 골라 "hook" 한 문장을 벼려라:
  1. 흔한믿음부정형: "다들 OO인 줄 알죠? 그거 사실 아니에요." 식 단정 부정.
  2. 숫자충격선공개: 결과/수치를 설명 없이 먼저 던진다("27억 원, 이게…").
  3. 직접질문형: 2인칭 질문으로 시작("~하는 거 아세요?", "왜 ~일까요?").
  4. 인메디아스레스: 사건 한가운데로 뚝 떨어뜨리는 미니 서사 한 줄.
  5. 모순결합형: 통념을 부정한 뒤 "3초 안에 알려드릴게요" 식 약속을 덧붙임.
- 궁금증(오픈루프)을 하나 만든 뒤, 그 답(페이오프)은 hook 에서 바로 풀지 말고 최소 카드 1개 이상 지연시켜 회수하라.

[더빙 자연스러움 — 성우가 말하듯]
- narration 은 사람이 실제로 말하듯 자연 구어체다. AI 티(번역체·문어체·리스트 나열·똑같은 길이 문장 반복·"결론적으로/시사하는 바")를 철저히 배격.
- 문장 길이를 불규칙하게 교차(짧게 치고 가끔 길게 풀고). 종결어미를 "~예요/~거든요/~잖아요/~죠?" 로 다양화(4문장 연속 같은 종결 금지). "근데/사실은/놀랍게도/그거 아세요?" 입말 연결어를 자연스럽게 섞어라.
- 문장 끝은 마침표/물음표로 또렷이 끊어라(성우 프로소디에 자연스러운 쉼이 실린다). 쉼표로 길게 늘어뜨리지 마라.

[형식 — 반드시 지켜라]
- 카드 ${min}~${max}장. 각 카드:
  { "caption": 화면에 크게 띄울 한 줄(22자 이내, 핵심 후킹),
    "narration": 위 '더빙 자연스러움' 규칙을 지킨 구어체(카드당 한국어 ${sylLo}~${sylHi}음절),
    "image_prompt": 이 카드 배경 AI 이미지 영어 프롬프트,
    "footage_keywords": 이 카드 배경에 어울리는 실사 스톡영상 검색용 **영어 키워드 2~4개**(공백 구분, 예: "server room data flow"). 한국어 금지 — 스톡은 영어로만 검색된다. 구체적 사물/장면 위주(추상어 지양). }
- image_prompt 규칙: **영어**, 카드 내용을 은유하는 시네마틱 배경. 글자·로고·UI·워터마크 없음(no text, no letters, no UI), 세로 구도, 중앙 여백(텍스트 공간), 톤은 짙은 남색·보라 계열 테크 무드 통일. 예: "cinematic 3D render of interconnected glowing network nodes failing and reconnecting, dark navy background, dramatic rim light, depth of field, no text".
- "hook": 위 훅 패턴으로 벼린 맨 처음 성우 한 문장(12~30음절).
- "hook_image_prompt": 훅 배경용 영어 이미지 프롬프트(위 규칙 동일, 가장 임팩트 있게).
- "hook_footage_keywords": 훅 배경용 영어 스톡영상 키워드(선택, 없으면 빈 문자열).
- "cta": 마지막 성우 한 줄 — 마무리 + 전체 글 보러 오라는 자연스러운 유도(밑에 링크 있다는 식). 20~40음절.
- 사실·수치·주장은 원문과 동일 유지. 없는 내용 창작 금지. caption·narration 에 이모지·해시태그·마크다운 기호 금지(순수 텍스트).

[출력]
- 아래 JSON 스키마 **그대로**, 다른 설명 없이 JSON 만 출력:
{ "hook": "...", "hook_image_prompt": "...", "hook_footage_keywords": "...", "cards": [ { "caption": "...", "narration": "...", "image_prompt": "...", "footage_keywords": "..." } ], "cta": "..." }

[블로그 원문]
제목: ${fm.title || ''}
${body}
`;
}


/**
 * 영어 스톡 검색어 정규화 → 최대 3개 문자열 배열(AC-4).
 * 문자열("a, b"·"a") 또는 배열 모두 허용. 비면 [](produce 가 image_prompt 폴백).
 */
export function normKeywords(v) {
  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/[,;/]|\band\b/i);
  return arr.map(s => String(s || '').trim()).filter(Boolean).slice(0, 3);
}

/** 텍스트에서 JSON 객체 추출·검증. 스키마 위반이면 throw. */
export function parseScript(text, cfg) {
  let obj;
  const m = text.match(/\{[\s\S]*\}/);
  try { obj = JSON.parse(m ? m[0] : text); }
  catch { throw new Error('대본 JSON 파싱 실패'); }
  if (!obj || typeof obj.hook !== 'string' || !Array.isArray(obj.cards)) throw new Error('대본 스키마 위반(hook/cards)');
  const min = cfg.script?.min_cards ?? 3, max = cfg.script?.max_cards ?? 5;
  obj.cards = obj.cards.filter(c => c && typeof c.caption === 'string' && typeof c.narration === 'string')
    .map(c => ({
      ...c,
      image_prompt: typeof c.image_prompt === 'string' ? c.image_prompt : '',
      // AC-4: 영어 스톡 검색어(1~3). 누락/오형이면 [] → produce 가 image_prompt 로 폴백.
      footage_keywords: normKeywords(c.footage_keywords),
    }));
  if (obj.cards.length < min) throw new Error(`카드 부족: ${obj.cards.length} < ${min}`);
  if (obj.cards.length > max) obj.cards = obj.cards.slice(0, max);
  obj.cta = typeof obj.cta === 'string' ? obj.cta : '';
  obj.hook_image_prompt = typeof obj.hook_image_prompt === 'string' ? obj.hook_image_prompt : '';
  obj.hook_footage_keywords = normKeywords(obj.hook_footage_keywords);
  return obj;
}

export async function generateScript(srcPath, { cfg } = {}) {
  cfg = cfg || loadShortsConfig();
  const raw = readFileSync(srcPath, 'utf8');
  const { fm, body } = parseDoc(raw);
  // 파이프라인 identity slug = 파일명 기준(선별·인덱스 dedup 과 동일 출처, 리뷰 #2).
  const slug = basename(srcPath, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  // 역링크 URL 은 사이트 실제 slug(frontmatter) 우선.
  const urlSlug = fm.slug || slug;
  const backlink = `${(cfg.site_base_url || 'https://www.thundo.kr/blog').replace(/\/$/, '')}/${urlSlug}`;
  const text = callClaude(buildPrompt(fm, body, backlink, cfg));
  const parsed = parseScript(text, cfg);
  const out = { slug, title: fm.title || slug, backlink, ...parsed };
  const dir = workDir(slug);
  mkdirSync(dir, { recursive: true });
  const scriptFile = join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return { slug, cards: out.cards.length, script_file: scriptFile, script: out };
}

async function main() {
  const argPath = process.argv[2];
  if (!argPath) { log.error('사용법: shorts/script.mjs <published/….md>'); process.exit(2); }
  try {
    const r = await generateScript(resolve(argPath));
    log.info(`대본 생성: ${r.slug} (${r.cards} 카드) → ${r.script_file}`);
    process.stdout.write(JSON.stringify({ ok: true, slug: r.slug, cards: r.cards, script_file: r.script_file }) + '\n');
  } catch (e) {
    log.error(`대본 생성 실패: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
