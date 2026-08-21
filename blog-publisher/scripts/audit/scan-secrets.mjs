#!/usr/bin/env node
/**
 * scan-secrets.mjs — 자동 커밋에 크리덴셜이 섞여 들어가는 것을 막는다.
 *
 *   node scripts/audit/scan-secrets.mjs --staged   # 스테이징된 변경만 (일일 cron 게이트)
 *   node scripts/audit/scan-secrets.mjs            # 추적 중인 파일 전수 (수동 감사)
 *
 * 왜 필요한가
 *   `scripts/daily-claude-cron.sh` 가 매일 `published/ state/ runs/ .omc/audit/ …` 를
 *   git add → commit → **origin/main push** 한다. 스크립트가 실수로 크리덴셜을 그 안에
 *   써버리면 사람 손을 거치지 않고 GitHub 로 나간다. 그 경로에 게이트가 없었다.
 *
 * 설계 원칙 (thundorun/web/scripts/scan-secrets.mjs 와 동일)
 *   - 파일명이 아니라 **내용**을 본다(`tokens.jsonl` 은 토큰 사용량 지표라 오탐이다).
 *   - 위반 보고는 `파일:줄 + 패턴 이름`까지. **값을 출력하지 않는다** — 로그가 유출 경로가 되면 안 된다.
 *   - 정당한 인용은 같은 줄에 `secret-scan: allow <이유>` 로 예외 처리(grep 으로 전수 감사 가능).
 *
 * exit 0 = 깨끗, exit 1 = 위반, exit 2 = 실행 오류(게이트는 이것도 차단으로 취급해야 한다)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const STAGED = process.argv.includes('--staged');

const PATTERNS = [
  ['Anthropic API 키',      /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI 계열 API 키',    /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Google API 키',         /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub PAT',            /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['Slack 토큰',            /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['Slack 웹훅',            /hooks\.slack\.com\/services\/T[A-Za-z0-9/+]{20,}/],
  ['Discord 웹훅',          /discord(app)?\.com\/api\/webhooks\/[0-9]{15,}\/[A-Za-z0-9_-]{50,}/],
  ['Telegram 봇 토큰',      /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}\b/],
  ['개인키',                /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT(서비스 롤 등)',     /\beyJhbGciOi[A-Za-z0-9_-]{20,}/],
  ['DB URL 내 비밀번호',    /\b(postgres|postgresql|mysql|mongodb(\+srv)?):\/\/[^:/@\s]+:[^@\s]{3,}@/],
  ['AWS 액세스 키 ID',      /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Vercel 토큰',           /\bvercel_[A-Za-z0-9]{24,}\b/],
  ['Bearer 하드코딩',       /Bearer\s+[A-Za-z0-9._-]{40,}/],
  ['네이버 클라이언트 시크릿', /NAVER_CLIENT_SECRET\s*[:=]\s*(['"])[^'"\n]{8,}\1/],
  ['Supabase PAT',          /\bsbp_[A-Za-z0-9]{20,}\b/],
  ['시크릿 계열 키에 값',
    // i 플래그 + 인용된 키 허용 — JSON(`"API_KEY": "…"`)과 소문자 키(`token: "…"`)가 사각지대였다.
    // 값은 공백 없는 한 덩어리여야 한다(명령·문장 값 오탐 제거).
    // 키 이름이 참조·파생을 뜻하면 값이 시크릿이 아니다:
    //   *_file/_path/_dir → 파일 경로, *_env → 환경변수 이름, *_hash → 해시(저장이 정상), *_url/_id/_name
    // 값이 경로(`~/`·`/`·`./`)이거나 환경변수 이름(ALL_CAPS)인 경우도 제외한다.
    /['"]?\b[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|ACCESSTOKEN)[A-Za-z0-9_]*(?<!_file)(?<!_path)(?<!_dir)(?<!_env)(?<!_hash)(?<!_url)(?<!_id)(?<!_name)(?<!_header)(?<!_field)(?<!_label)\b['"]?\s*[:=]\s*(['"])(?!(your-|<|\$\{|xxx|changeme|placeholder|dummy|example|~\/|\.?\/|[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}['"]))[^\s'"\n]{16,}\2/i],
];

/** 바이너리·미디어는 건너뛴다. 이 스캐너 자신은 패턴을 품고 있으므로 제외한다. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2',
  '.ttf', '.otf', '.mp4', '.mp3', '.wav', '.zip', '.gz', '.pdf', '.sqlite', '.db', '.deb',
]);
const SKIP_FILES = new Set(['scripts/audit/scan-secrets.mjs']);
/** 알려진 텍스트 확장자는 널바이트가 있어도 텍스트로 읽는다(정규식에 실제 NUL 을 품은 소스가 있다). */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.mdx',
  '.txt', '.yml', '.yaml', '.toml', '.css', '.html', '.svg', '.xml', '.sh', '.sql',
]);
const ALLOW_MARK = /secret-scan:\s*allow\b/;

/**
 * 생성된 산문은 검사하지 않는다 — 위협 모델이 다르다.
 *
 * 블로그 초안·발행물·리포트는 LLM 이 공개 주제로 쓴 글이라 "텔레그램 봇토큰은
 * `110201543:AAH…` 형식입니다" 처럼 **크리덴셜 형식을 설명**하는 문장이 정상적으로 나온다.
 * 그걸 막으면 일일 cron 이 오탐으로 멈춘다(무증상 정지가 유출보다 더 자주 아프다).
 * 반대로 우리 실제 키가 새는 경로는 산문이 아니라 **로그·상태·감사 파일**이다 —
 * 그쪽은 그대로 검사한다.
 */
const PROSE_PATHS = [
  /^published\/.*\.md$/,          // runs/ 와 대칭 — 비-md 산출물은 산문이 아니다
  /^runs\/.*\.md$/,
  /^docs\/reports\//,             // LLM·게이트웨이 브리핑
  /^benchmark\//,
  /^state\/shorts-backlog\//,
];
// ⚠ `docs/work-history/`·`docs/handoff/log/` 는 **제외하지 않는다** —
//    daily-brief.mjs 가 git 사실에서 기계 생성하고 cron 이 스테이징하는 파일이라
//    "LLM 이 쓴 산문"이 아니라 로그 부류다. 명령 출력이 그대로 들어간다.

/**
 * 산문에서도 **끄지 않는** 패턴 이름.
 * 블로그 글이 정상적으로 만들어내는 건 "봇토큰은 이런 형식입니다" 같은 **형식 설명**이지
 * 살아있는 개인키 블록이 아니다. 그러니 명백한 것은 전 경로에서 강제한다.
 * 단, 문서 예시처럼 보이는 값(XXXX·0000·EXAMPLE·your- 등)은 산문에서 통과시킨다 —
 * 안 그러면 튜토리얼 한 편에 무인 cron 이 멈춘다.
 */
const ALWAYS_ENFORCED = new Set([
  '개인키', 'Slack 웹훅', 'Discord 웹훅', 'DB URL 내 비밀번호',
  'GitHub PAT', 'Slack 토큰', 'Supabase PAT', 'Vercel 토큰',
]);
/** 문서 예시로 흔히 쓰이는 형태 — 산문에서 ALWAYS 패턴에 걸려도 이건 통과시킨다. */
const LOOKS_LIKE_EXAMPLE = /XXXX|xxxx|0000000|EXAMPLE|example|your[-_]|<[a-z-]+>|abc123|11111/;

function targets() {
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

try {
  const hits = [];
  /** 예외 표시 사용 현황 — 매 실행마다 노출해 남용이 조용히 쌓이지 않게 한다. */
  const allows = [];
  const unreadable = [];
  for (const rel of targets()) {
    if (SKIP_FILES.has(rel)) continue;
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
    const isProse = PROSE_PATHS.some((re) => re.test(rel));

    let text;
    try {
      const buf = fs.readFileSync(path.join(REPO, rel));
      if (!TEXT_EXT.has(path.extname(rel).toLowerCase()) && buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch (err) {
      // 침묵 금지 — 못 읽은 파일을 "검사했다"고 말할 수 없다.
      unreadable.push(`${rel} (${String(err?.message ?? err).split('\n')[0].slice(0, 70)})`);
      continue;
    }

    text.split('\n').forEach((line, i) => {
      if (ALLOW_MARK.test(line)) {
        // 아무 줄에나 달 수 있으면 가드가 무력해진다 — 이유 필수, 산문에서만 허용.
        const why = (line.match(/secret-scan:\s*allow\s*(.*)$/)?.[1] ?? '').replace(/(?:-->|\*\/|\}|`|\*)+\s*$/g, '').trim();  // 주석 닫기(`-->`·`*/`)를 이유로 인정하면 이유 요구가 무력해진다
        const ext = path.extname(rel).toLowerCase();
        if (!why) hits.push({ rel, line: i + 1, name: '예외에 이유가 없다 — `secret-scan: allow <이유>`' });
        else if (!['.md', '.txt', '.mdx'].includes(ext) && !rel.startsWith('scripts/'))
          hits.push({ rel, line: i + 1, name: '예외는 산문·스크립트에서만 허용' });
        else allows.push({ rel, line: i + 1, why: why.slice(0, 80) });
        return;
      }
      for (const [name, re] of PATTERNS) {
        const m = line.match(re);
        if (!m) continue;
        if (isProse) {
          // 산문에서는 명백한 것만 강제한다.
          if (!ALWAYS_ENFORCED.has(name)) continue;
          // 자리표시자 판정은 **매치된 값**에만 건다. 줄 전체에 걸면
          // "예시:" 같은 설명이 같은 줄에 있다는 이유로 살아있는 키까지 통과한다 —
          // 산문은 설명하는 글이라 그 조합이 오히려 자연스럽고, 하필 마지막 방어선이
          // 가장 필요한 자리에서 넓게 열린다.
          if (LOOKS_LIKE_EXAMPLE.test(m[0])) continue;
        }
        hits.push({ rel, line: i + 1, name });
        break;
      }
    });
  }

  const scope = STAGED ? '스테이징된 변경' : '추적 중인 파일';
  if (unreadable.length) {
    console.error(`⚠ 읽지 못해 검사되지 않은 파일 ${unreadable.length}건:`);
    for (const u of unreadable) console.error(`  ${u}`);
  }
  if (hits.length) {
    console.error(`✖ ${scope}에서 크리덴셜 패턴 ${hits.length}건 — 커밋 중단`);
    for (const h of hits) console.error(`  ${h.rel}:${h.line}  ${h.name}`);
    console.error('조치: 값을 소스에서 빼고 .env 로 옮긴다. 이미 푸시됐다면 키를 폐기·재발급한다.');
    console.error('정당한 인용이면 그 줄에 `secret-scan: allow <이유>` 를 단다.');
    process.exit(1);
  }
  if (unreadable.length) process.exit(2);   // 검사 못 한 것을 통과로 처리하지 않는다
  console.log(`✓ ${scope}: 크리덴셜 패턴 0건`);
  if (allows.length) {
    console.log(`\n예외 표시(secret-scan: allow) ${allows.length}건 — 정당한지 주기적으로 재검토하세요:`);
    for (const a of allows) console.log(`  ${a.rel}:${a.line}  ${a.why}`);
  }
  process.exit(0);
} catch (err) {
  // 게이트는 실행 오류도 차단으로 취급해야 한다 — 조용히 통과시키면 가드가 없는 것과 같다.
  console.error(`✖ 스캔 실행 오류: ${err?.message ?? err}`);
  process.exit(2);
}
