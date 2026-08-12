/**
 * scan-secrets.mjs — 커밋물에 크리덴셜이 섞여 들어가는 것을 막는다.
 *
 *   npm run scan:secrets              # 저장소 전체 추적 파일
 *   npm run scan:secrets -- --staged  # 스테이징된 변경만 (커밋 직전용)
 *
 * ## 범위는 저장소 루트 전체
 * `web/` 만 보면 `.github/workflows/*.yml`·`.claude/settings.json`·루트 문서 50여 개를
 * 통째로 놓친다 — 워크플로와 settings 는 토큰이 실제로 박히는 자리다.
 *
 * ## --staged 는 index blob 을 읽는다
 * `git diff --cached` 는 **저장소 루트 기준** 경로를 준다. 초기 버전은 그걸 `web/` 에 join 해
 * `web/web/src/x.ts` 를 찾다가 ENOENT 를 맨몸 `catch` 로 삼켰고, 결과적으로 **모든 파일이
 * 조용히 스킵돼 항상 0건**이 나왔다(거짓 green — 커밋 직전 모드가 아무것도 막지 못했다).
 * 지금은 루트 기준으로 풀고, 워킹트리가 아니라 `git show :path` 로 **실제로 커밋될 내용**을 읽는다.
 *
 * ## 못 잡는 것 (정규식 스캐너는 만능이 아니다)
 * - 문자열 결합·줄바꿈으로 쪼갠 키, base64 로 한 번 감싼 키
 * - 접두어가 없는 **불투명 고엔트로피 값**(AWS secret access key, 게이트웨이 토큰 등)이
 *   시크릿처럼 보이지 않는 이름에 담긴 경우
 * - 바이너리(sqlite·pdf 등) 내부 — 널바이트 검사에서 스킵된다. 이건 스캔이 아니라
 *   **추적 인벤토리 검토**로 다뤄야 해서, 스킵한 파일 목록을 매번 출력한다.
 * 즉 이 스캐너는 마지막 방어선이 아니라 **명백한 실수를 막는 그물**이다.
 *
 * ## 원칙
 * - 파일명이 아니라 내용을 본다(`tokens.jsonl` 은 토큰 사용량 지표라 오탐이다).
 * - 위반 보고는 `파일:줄 + 패턴 이름`까지. **값을 출력하지 않는다** — 로그가 유출 경로가 되면 안 된다.
 * - 읽기 실패를 침묵시키지 않는다(그 침묵이 위 버그를 감췄다). 못 읽으면 exit 2.
 * - 정당한 인용은 `secret-scan: allow <이유>`. **이유가 없거나 산문(.md/.txt) 밖이면 실패**한다.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const STAGED = process.argv.includes('--staged');

/**
 * 실제 크리덴셜 형태. 마지막 캐치올은 `i` 플래그 + 인용된 키 허용 —
 * JSON(`"API_KEY": "…"`)과 소문자 키(`token: "…"`)가 초기 버전의 구조적 사각지대였다.
 */
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
  ['Supabase PAT',          /\bsbp_[A-Za-z0-9]{20,}\b/],
  ['Bearer 하드코딩',       /Bearer\s+[A-Za-z0-9._-]{40,}/],
  ['시크릿 계열 키에 값',
    // 값은 **공백 없는** 한 덩어리여야 한다. 크리덴셜에는 공백이 없고,
    // 이 조건이 `"scan:secrets": "node scripts/scan-secrets.mjs"` 같은
    // 명령·문장 값을 걸러낸다(i 플래그를 켜면서 새로 생긴 오탐이었다).
    // 키 이름이 참조·파생을 뜻하면 값이 시크릿이 아니다:
    //   *_file/_path/_dir → 파일 경로, *_env → 환경변수 이름, *_hash → 해시(저장이 정상), *_url/_id/_name
    // 값이 경로(`~/`·`/`·`./`)이거나 환경변수 이름(ALL_CAPS)인 경우도 제외한다.
    /['"]?\b[A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY|ACCESSTOKEN)[A-Za-z0-9_]*(?<!_file)(?<!_path)(?<!_dir)(?<!_env)(?<!_hash)(?<!_url)(?<!_id)(?<!_name)(?<!_header)(?<!_field)(?<!_label)\b['"]?\s*[:=]\s*(['"])(?!(your-|<|\$\{|xxx|changeme|placeholder|dummy|example|~\/|\.?\/|[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}['"]))[^\s'"\n]{16,}\2/i],
];

/**
 * 성능용 스킵 힌트. **텍스트 포맷은 넣지 않는다** —
 * 초기 버전이 `.svg` 를 넣어 SVG 주석·metadata 안의 평문 키를 놓쳤다.
 * 진짜 바이너리는 아래 널바이트 검사가 어차피 걸러낸다.
 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.mp3', '.wav',
  '.zip', '.gz', '.pdf', '.sqlite', '.db', '.wasm',
]);
/**
 * 알려진 텍스트 확장자는 널바이트가 있어도 텍스트로 읽는다.
 * `sanitize.ts`·`md-to-html.ts` 는 C0 제어문자 제거용으로 정규식에 **실제 NUL 바이트**를
 * 품고 있어 널바이트 휴리스틱이 바이너리로 오분류했다 — 그렇게 소스가 검사망을 빠져나갔다.
 */
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc',
  '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.css', '.scss',
  '.html', '.svg', '.xml', '.sh', '.bash', '.env', '.example', '.sql',
]);

/** 저장소 루트 기준 경로. 이 스캐너 자신은 패턴을 품고 있어 제외한다. */
const SKIP_FILES = new Set(['web/scripts/scan-secrets.mjs', 'web/package-lock.json']);

const ALLOW_MARK = /secret-scan:\s*allow\s*(.*)$/;
/** 예외를 아무 곳에나 달 수 있으면 가드가 무력해진다 — 산문에서만 허용한다. */
const ALLOW_OK_EXT = new Set(['.md', '.txt', '.mdx']);

function targets() {
  const args = STAGED
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

/** --staged 는 index blob(실제 커밋될 내용)을, 기본 모드는 워킹트리를 읽는다. */
function readContent(rel) {
  if (STAGED) {
    return execFileSync('git', ['show', `:${rel}`], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 });
  }
  return fs.readFileSync(path.join(REPO, rel));
}

const files = targets();
const hits = [];
const allows = [];
const skipped = [];
const unreadable = [];

for (const rel of files) {
  if (SKIP_FILES.has(rel)) continue;
  if (SKIP_EXT.has(path.extname(rel).toLowerCase())) { skipped.push(rel); continue; }

  let buf;
  try {
    buf = readContent(rel);
  } catch (err) {
    // 침묵 금지 — 못 읽은 파일을 "검사했다"고 말할 수 없다.
    unreadable.push(`${rel} (${String(err?.message ?? err).split('\n')[0].slice(0, 70)})`);
    continue;
  }
  const isText = TEXT_EXT.has(path.extname(rel).toLowerCase());
  if (!isText && buf.includes(0)) { skipped.push(rel); continue; }

  buf.toString('utf8').split('\n').forEach((line, i) => {
    const allow = line.match(ALLOW_MARK);
    if (allow) {
      const why = (allow[1] ?? '').replace(/(?:-->|\*\/|\}|`|\*)+\s*$/g, '').trim();  // 주석 닫기(`-->`·`*/`)를 이유로 인정하면 이유 요구가 무력해진다
      const ext = path.extname(rel).toLowerCase();
      if (!why) {
        hits.push({ rel, line: i + 1, name: '예외에 이유가 없다 — `secret-scan: allow <이유>` 로 적어라' });
      } else if (!ALLOW_OK_EXT.has(ext)) {
        hits.push({ rel, line: i + 1, name: '예외는 산문(.md/.txt)에서만 허용 — 소스에서는 값을 빼라' });
      } else {
        allows.push({ rel, line: i + 1, why: why.slice(0, 80) });
      }
      return;
    }
    for (const [name, re] of PATTERNS) {
      if (re.test(line)) { hits.push({ rel, line: i + 1, name }); break; }
    }
  });
}

const scope = STAGED ? '스테이징된 변경' : '추적 중인 파일';

if (unreadable.length) {
  console.error(`⚠ 읽지 못해 검사되지 않은 파일 ${unreadable.length}건:`);
  for (const u of unreadable) console.error(`  ${u}`);
}

if (hits.length) {
  console.error(`\n✖ ${scope}에서 문제 ${hits.length}건 — 커밋하지 마세요.\n`);
  for (const h of hits) console.error(`  ${h.rel}:${h.line}  ${h.name}`);
  console.error(`
조치:
  1) 값을 소스에서 제거하고 환경변수로 옮긴다(.env 는 .gitignore 로 차단돼 있다).
  2) 이미 커밋했다면 키를 **폐기·재발급**한다 — 이력에서 지워도 유출된 것으로 간주해야 한다.
  3) 문서가 패턴을 인용하는 정당한 경우라면 그 줄에 \`secret-scan: allow <이유>\` 를 단다(.md/.txt 만).`);
  process.exit(1);
}

// 읽기 실패는 "검사 못 함"이다 — 통과로 처리하지 않는다.
if (unreadable.length) process.exit(2);

console.log(`✓ ${scope}: 크리덴셜 패턴 0건 (대상 ${files.length}건)`);
if (allows.length) {
  console.log(`\n예외 표시(secret-scan: allow) ${allows.length}건 — 정당한지 주기적으로 재검토하세요:`);
  for (const a of allows) console.log(`  ${a.rel}:${a.line}  ${a.why}`);
}
if (skipped.length) {
  console.log(`\n내용 검사 불가(바이너리·미디어) ${skipped.length}건 — 새 항목이 늘면 인벤토리를 검토하세요:`);
  for (const s of skipped) console.log(`  ${s}`);
}
