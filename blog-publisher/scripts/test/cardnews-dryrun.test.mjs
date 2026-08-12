#!/usr/bin/env node
/**
 * cardnews-dryrun.test.mjs — Step 5.5 통합 드라이런 (계획 §4 "Step 5.5" · AC-9 · AC-18)
 *
 * **왜 이 테스트가 따로 있는가**: Step 2는 손수 만든 픽스처로 렌더하고, Step 4는 meta+host 를
 * 통째로 스텁하며, Step 5는 `pick` 에서 멈춘다. 즉 `script.mjs → render.mjs → caption.mjs` 의
 * 스키마 계약이 **한 번도 같이 실행된 적이 없다**. 그 첫 실행이 go-live 가 되면 실계정 앞에서
 * 불일치를 발견하게 되고, 인스타 발행에는 삭제 엔드포인트가 없다.
 *
 * **스텁 경계 = 네트워크 하나뿐이다.**
 *  - `deps.fetchImpl` 하나가 Graph API·Supabase Storage 를 대신한다. `meta.mjs` 는 **진짜**로
 *    돈다 — 가드 원장(`_activeGuards`)·1회용 토큰·`classifyMetaError` 가 실제로 관여한다.
 *  - `deps.meta` 는 `metaModule` 을 그대로 편 얇은 기록용 프록시다. `guardPublish` 만 감싸는데,
 *    그 첫 단계인 `publishReadiness`(meta.mjs:132)가 **동기·비네트워크**라 fetch 경계에서
 *    관측되지 않기 때문이다. 나머지 5개 호출은 URL 로 식별해 fetch 에서 직접 기록한다.
 *  - `callClaude` 는 스텁이다(이 레포는 claude CLI 다일 장애 이력이 있다 — 테스트가 그걸 타면
 *    안 된다). 렌더는 **진짜 chromium** 이다: 두부·치수·용량은 실행해야만 드러난다.
 *
 * **2차 방어**: `config/cardnews.json` 의 `publish.enabled` 는 이 테스트가 손대지 않는다.
 * (5)에서 디스크 설정을 그대로 읽어 `readiness` 게이트가 여전히 닫혀 있음을 **단언**한다 —
 * "안 건드렸다"는 자세가 아니라 관측이어야 방어층이다.
 *
 * 완료 단언 6개:
 *  ① script.mjs 산출 → render.mjs → 7장 → gates.mjs 통과
 *  ② buildCaption 불변식(2200자·30태그·cta 보존·**마커가 최말미**)
 *  ③ 기록 시퀀스가 AC-9 순서: publishReadiness → publishingLimit → createChildContainer×7
 *     → createCarouselContainer → mediaPublish
 *  ④ history[] 가 9-state 순서
 *  ⑤ guardPublish(=publishReadiness)가 createChildContainer 보다 **먼저**
 *  ⑥ runs.jsonl 에 정확히 1줄
 *
 * 추가 폴트 시나리오:
 *  (A) 팩트체크 hold 가 인덱스에 남아 **다음날 다시 뽑히지 않는다**(pick.mjs pendingBacklog 공백)
 *  (B) 킬스위치·토큰 halt·예산 halt 각 경로가 `appendRun` 1줄을 남긴다(1-B)
 *
 * 네트워크 0 · 크리덴셜 0 · 실제 발행 0. exit 0 = 전체 통과.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const TMP = mkdtempSync(join(tmpdir(), 'cardnews-dryrun-'));

// ⚠ import 전에 세팅 — `paths.state` 는 모듈 초기화 시점에 고정된다.
process.env.STATE_DIR_OVERRIDE = TMP;
process.env.RUN_MODE = 'mock';
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key';

// ── 설정: 실 config 를 베이스로 쓰되(스키마 드리프트를 잡는다) 드라이런 안전값만 덮는다 ──
const DISK_CFG = JSON.parse(readFileSync(join(REPO, 'config', 'cardnews.json'), 'utf8'));
const TOKEN_FILE = join(TMP, 'instagram-oauth.json');
const DRY_CFG = {
  ...DISK_CFG,
  imagen: { ...DISK_CFG.imagen, enabled: false },   // Vertex 도 네트워크 경계다 → 끈다(그라데이션 폴백)
  meta: { ...DISK_CFG.meta, token_file: TOKEN_FILE, child_retry: { max: 2, base_ms: 1 } },
  // 🔴 파일이 아니라 **메모리 사본**에서만 켠다. 디스크의 마스터 스위치는 손대지 않는다.
  publish: { ...DISK_CFG.publish, enabled: true },
};
const CFG_PATH = join(TMP, 'cardnews.json');
writeFileSync(CFG_PATH, JSON.stringify(DRY_CFG), 'utf8');
process.env.CARDNEWS_CONFIG_OVERRIDE = CFG_PATH;

const NOW = new Date('2026-08-01T02:00:00.000Z');        // KST 08-01 11:00 (슬롯 11)
writeFileSync(TOKEN_FILE, JSON.stringify({
  ig_user_id: '17841400000000000',
  access_token: 'stub-long-lived-token',
  issued_at: new Date(NOW.getTime() - 86400000).toISOString(),      // 1일 → refreshPlan noop
  expires_at: new Date(NOW.getTime() + 59 * 86400000).toISOString(),
}), 'utf8');

const lib = await import('../cardnews/lib.mjs');
const metaModule = await import('../cardnews/meta.mjs');
const { pick, pendingBacklog } = await import('../cardnews/pick.mjs');
const { judge, listSlides } = await import('../cardnews/gates.mjs');
const { loadBuffer } = await import('../cardnews/script.mjs');
const fcModule = await import('../cardnews/factcheck.mjs');
const { toRow: recordToRow } = await import('../cardnews/post-record.mjs');
const run = await import('../cardnews/run-cardnews.mjs');

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
const deepEq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want),
  `\n     got =${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`);

// ── 픽스처 ───────────────────────────────────────────────────────────────────

const SCRIPT = (() => {
  const s = JSON.parse(readFileSync(join(REPO, 'benchmark', 'cardnews', 'sample-script.json'), 'utf8'));
  delete s.post_id; delete s.note;      // 대본 생성기가 내놓는 모양 그대로
  // 🔴 버티컬 전환(2026-07-31): 대본 스키마에 인용 블록이 생겼다(`script.mjs:validateScript`).
  //    벤치마크 픽스처(`benchmark/cardnews/*`)는 인용 게이트 담당이 따로 소유하므로 여기서
  //    고치지 않고, **없을 때만** 최소 블록을 얹어 통합 경로가 계속 돌게 한다. 픽스처가 갱신되면
  //    이 보정은 자동으로 비활성이 된다(조건부).
  if (!s.quote) {
    s.quote = {
      text: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
      source: { title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813 },
    };
  }
  return s;
})();

/** 인용 원문 대조용 합성 코퍼스 — 픽스처 6건의 quote_original 을 모두 담는다. */
const FULLTEXT_URL = 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt';
const QUOTES = {
  jpdining01: 'I declare after all there is no enjoyment like reading',
  detime0001: 'Vanity and pride are different things though the words are often used synonymously',
  ustip00001: 'It is a truth universally acknowledged that a single man in possession of a good fortune',
  aeramad001: 'There are few people whom I really love and still fewer of whom I think well',
  frbread001: 'I could easily forgive his pride if he had not mortified mine',
  thhead0001: 'We are all fools in love and none of us can help it',
};
const FULLTEXT = `The Project Gutenberg eBook of Pride and Prejudice, by Jane Austen

${Object.values(QUOTES).map(q => `“${q.split(' ').map((w, i) => ((i + 1) % 6 === 0 ? `${w}\n` : w)).join(' ')}!”\n`).join('\n')}

${'Filler paragraph to clear the minimum corpus size guard. '.repeat(80)}
`;

const item = (id, problem, situation) => ({
  id,
  problem,
  subject: problem,                         // 엔진 호환 미러(run-cardnews.mjs 가 읽는 슬롯)
  situation,
  quote_original: QUOTES[id],
  quote_ko: '결국 독서만 한 즐거움은 없다고 나는 단언한다.',
  source: {
    title: '오만과 편견', author: '제인 오스틴', translator: null, year: 1813,
    fulltext_url: FULLTEXT_URL,
  },
  form: 'novel',
  interpretation: '그 시간은 도피가 아니라 회복이었다는 것을 오스틴은 농담처럼 말한다. 우리가 자기에게 돌려주는 유일한 몫이다.',
  shift: '자책하던 자리에서 한 걸음 옆으로',
  audience: '요즘 지쳐 보이는 사람에게',
  public_domain: true,
  created_at: NOW.toISOString(),
});

/** 백로그 시드 3건 → 임계(daily_target 1 × refill_buffer_days 5 = 5) 미만이라 보충이 돈다. */
const SEED = [
  item('jpdining01', '혼자 있고 싶은 게 도망 같을 때', '약속을 미루고 방에 있는 밤'),
  item('detime0001', '내가 너무 많이 준 것 같을 때', '답장을 기다리며 보낸 문장을 다시 읽는 밤'),
  item('ustip00001', '거절을 못 해서 나를 미룰 때', '이미 꽉 찬 주에 부탁을 또 받는 자리'),
];
/** 보충 스텁이 내놓을 3건. */
const REFILL = [
  item('aeramad001', '떠난 사람이 자꾸 생각날 때', '지나가는 노래 한 소절에 멈추는 순간'),
  item('frbread001', '일이 끝나도 쉬어지지 않을 때', '퇴근하고도 메신저를 켜 두는 밤'),
  item('thhead0001', '가족 앞에서만 말이 막힐 때', '명절 상 앞에서 삼키는 문장'),
];

// 🔴 원문 캐시 프리시드 — `run-cardnews.mjs` 는 factcheck 에 fetch 스텁을 주입하지 않는다(운영에서는
//    실제로 받아야 하므로 그게 맞다). 캐시가 깔려 있으면 대조는 네트워크 없이 돈다 → 이 테스트의
//    "네트워크 0" 계약이 유지된다.
mkdirSync(dirname(fcModule.corpusPath(FULLTEXT_URL)), { recursive: true });
writeFileSync(fcModule.corpusPath(FULLTEXT_URL), FULLTEXT, 'utf8');

const resetState = () => {
  for (const p of [lib.indexPath(), lib.runsPath(), lib.backlogPath(), lib.pickScoresPath(), lib.reviewQueuePath()]) {
    if (existsSync(p)) unlinkSync(p);
  }
  rmSync(lib.bufferDir(), { recursive: true, force: true });
  rmSync(join(lib.stateRoot(), 'work'), { recursive: true, force: true });
};

// ── claude 스텁 — 프롬프트로 단계를 식별한다 ────────────────────────────────

function makeClaude({ factcheck = () => ({ verdict: 'ok', note: '관광청 자료로 확인', source: 'https://example.org/guide', needs_correction: false, corrected_subject: '', corrected_contrast: '' }) } = {}) {
  const calls = [];
  const impl = (prompt, o = {}) => {
    // lib.callClaude 와 같은 원장을 쓴다 — 예산 계상이 스텁 때문에 사라지지 않게.
    lib.chargeClaudeCall({ exempt: Boolean(o.exempt), cfg: o.cfg });
    // ⚠ 판별 순서가 중요하다 — 프롬프트 선두에 에이전트 BRIEF(페르소나)가 붙는데, camel/albatross
    //    브리프가 "소재 후보" 같은 말을 공유한다. 본문에만 있는 문장부터 좁게 판별한다.
    if (prompt.includes('세 축으로 0.0~1.0 채점하라')) {
      calls.push('pick');
      const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(m => m[1]);
      // jpdining01 이 최고점 — 픽스처 대본과 소재를 일치시킨다.
      return JSON.stringify(ids.map((id, i) => ({
        id,
        surprise: id === 'jpdining01' ? 0.95 : Math.max(0.35, 0.8 - i * 0.05),
        savability: id === 'jpdining01' ? 0.92 : 0.7,
        clarity: id === 'jpdining01' ? 0.9 : 0.7,
      })));
    }
    if (prompt.includes('실재 여부는 다시 판정하지 말고')) {
      calls.push('factcheck');
      const m = /문제:\s*(.+)/.exec(prompt);
      return JSON.stringify(factcheck((m ? m[1] : '').trim(), calls));
    }
    if (prompt.includes('인스타 카드뉴스 대본을 만들어라')) { calls.push('script'); return JSON.stringify(SCRIPT); }
    if (prompt.includes('[각 원소 스키마]')) { calls.push('backlog'); return JSON.stringify(REFILL); }
    throw new Error(`드라이런 claude 스텁: 알 수 없는 프롬프트\n${prompt.slice(0, 200)}`);
  };
  return { impl, calls };
}

// ── 네트워크 스텁 — 유일한 스텁 경계 ────────────────────────────────────────

const res = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function makeFetch() {
  /** 발행 도메인 호출만 순서대로 — 스토리지는 seq 를 흐리므로 counts 로만 센다. */
  const seq = [];
  const calls = { limit: 0, child: 0, carousel: 0, publish: 0, getMedia: 0, put: 0, get: 0, recent: 0 };
  const impl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/storage/v1/object/public/')) {
      calls.get++;
      return res(200, {}, { 'content-type': 'image/jpeg', 'content-length': '480000' });
    }
    if (u.includes('/storage/v1/object/')) { calls.put++; return res(200, { Key: 'ok' }); }
    if (u.includes('content_publishing_limit')) {
      calls.limit++; seq.push('publishingLimit');
      return res(200, { data: [{ config: { quota_total: 25 }, quota_usage: 3 }] });
    }
    if (u.includes('/media_publish')) { calls.publish++; seq.push('mediaPublish'); return res(200, { id: 'media-dryrun-1' }); }
    if (u.includes('media_type=CAROUSEL')) { calls.carousel++; seq.push('createCarouselContainer'); return res(200, { id: 'carousel-dryrun-1' }); }
    if (u.includes('is_carousel_item=true')) { calls.child++; seq.push('createChildContainer'); return res(200, { id: `child-${calls.child}` }); }
    if (u.includes('fields=id,permalink')) { calls.getMedia++; seq.push('getMedia'); return res(200, { id: 'media-dryrun-1', permalink: 'https://www.instagram.com/p/dryrun/' }); }
    if (u.includes('fields=id,caption,timestamp')) { calls.recent++; seq.push('recentMedia'); return res(200, { data: [] }); }
    throw new Error(`드라이런: 예상 못한 네트워크 호출 ${(init.method || 'GET')} ${u}`);
  };
  return { impl, seq, calls };
}

/**
 * 기록용 meta 프록시 — `metaModule` 을 그대로 편다. `guardPublish` 만 감싸 진입을
 * `publishReadiness` 로 기록하고 **진짜** `guardPublish` 에 위임한다(가드 원장·1회용 토큰 유지).
 */
const recordingMeta = (seq) => ({
  ...metaModule,
  async guardPublish(cfg, token, mo) {
    seq.push('publishReadiness');
    return metaModule.guardPublish(cfg, token, mo);
  },
});

const stubBudget = () => ({ ok: true, calls_used: 0, tokens_used: 0, caps: { calls: 999, tokens: 9e9 }, remaining: { calls: 999, tokens: 9e9 } });

// ═══ 1. 통합 해피패스 — runDaily 전체 ════════════════════════════════════════
console.log('\n[1] runDaily 전체 실행 (네트워크만 스텁 · 렌더는 진짜 chromium)');

resetState();
lib.appendBacklog(SEED);

const claude = makeClaude();
const net = makeFetch();
const alerts = [];
const charges = [];
const siteRows = [];
const R = await run.runDaily({
  cfg: DRY_CFG,
  slot: '11',
  deps: {
    now: () => NOW,
    callClaude: claude.impl,
    fetchImpl: net.impl,
    meta: recordingMeta(net.seq),
    notifier: async (ev, p) => { alerts.push({ ev, p }); return { telegram: 'sent', discord: 'sent' }; },
    sleep: async () => {},
    checkBudget: stubBudget,
    charge: (t, c, label) => { charges.push(label); return { over_cap: false }; },
    imagenGenerate: async () => { throw new Error('imagen 이 꺼져 있는데 호출됐다'); },
    // 사이트 갤러리 기록 — 네트워크는 이미 스텁이지만, **무엇을 쓰려 했는지**를 잡아야
    // 갤러리에 실제로 쓸 만한 행이 만들어졌는지 확인할 수 있다.
    recordPublishedPost: async (postId) => {
      siteRows.push(recordToRow(lib.getPost(postId)));
      return { ok: true };
    },
  },
});

eq('runDaily ok', R.ok, true);
ok('post_id 발급', /^cn-2026-08-01-/.test(R.post_id || ''), R.post_id);
eq('media_id', R.media_id, 'media-dryrun-1');
eq('state', R.state, 'published');

const POST = lib.getPost(R.post_id);
const stepOf = (name) => R.steps.find(s => s.step === name);

console.log('\n  단계 흐름');
eq('백로그 보충이 돌았다(재고 3 < 임계 5)', stepOf('backlog').detail.added, 3);
eq('pick 이 jpdining01 을 뽑았다', stepOf('pick').detail.id, 'jpdining01');
eq('팩트체크 hold 0건', stepOf('factcheck').detail.holds.length, 0);
eq('일반화 게이트 TIER-1 0건', stepOf('gate').detail.tier1, 0);
eq('sweep 은 아무것도 못 찾았다(첫 런)', stepOf('sweep').detail.published, 0);
eq('claude 스텁 호출 단계', claude.calls.slice(0, 4).join('>'), 'backlog>pick>factcheck>script');
ok('예산 원장에 카드뉴스 라벨이 계상됐다',
  charges.filter(c => c.startsWith('cardnews-')).length >= 4, charges.join(','));

// ── 사이트 갤러리 기록 ───────────────────────────────────────────────────────
//
// 🔴 `web/supabase/cardnews_posts.sql` 은 "파이프라인이 발행 확정 시 upsert 한다"고 적어
// 두었지만, 그 문장은 이 호출이 실제로 일어나야만 사실이 된다. 스키마만 있고 쓰는 쪽이
// 없으면 갤러리는 배포 후 **영구히 빈 페이지**가 되고, 그 사실은 월요일 발행 전까지 아무도
// 모른다(발행이 0건이라 빈 게 정상으로 보인다).
console.log('\n  사이트 갤러리 기록');
eq('발행 1건당 정확히 1행', siteRows.length, 1);
{
  const row = siteRows[0];
  eq('post_id', row?.post_id, R.post_id);
  eq('media_id 가 채워졌다', row?.media_id, 'media-dryrun-1');
  ok('표지 이미지가 있다', typeof row?.cover_url === 'string' && row.cover_url.length > 0, String(row?.cover_url));
  eq('슬라이드 URL 7장', row?.slide_urls?.length, 7);
  eq('cover_url 은 첫 슬라이드', row?.cover_url, row?.slide_urls?.[0]);
  ok('출처(책·저자)가 채워졌다', Boolean(row?.book) && Boolean(row?.author), `${row?.book}/${row?.author}`);
  ok('캡션이 실렸다', typeof row?.caption === 'string' && row.caption.length > 0);
  eq('누가 썼는지 남는다', row?.generator, 'claude');
  // 🔴 퍼머링크는 **Graph 가 준 값 그대로**여야 한다. `media_id` 로 URL 을 조립하면
  //    그럴듯하지만 열리지 않는 링크가 갤러리에 박힌다(인스타 퍼머링크의 shortcode 는
  //    media_id 와 다른 값이다).
  eq('퍼머링크는 포스트 상태(Graph 응답)에서 온다', row?.permalink, POST.permalink);
  ok('🔴 media_id 로 조립한 흔적이 없다',
    !String(row?.permalink ?? '').includes(String(row?.media_id ?? ' ')), String(row?.permalink));
  ok('site_record 단계가 기록됐다', stepOf('site_record')?.ok === true, JSON.stringify(stepOf('site_record')));
}

// ── ① script.mjs → render.mjs → 7장 → gates.mjs ─────────────────────────────
console.log('\n  ① 대본 → 렌더 7장 → 이미지 게이트');
const workDir = lib.workDir(R.post_id, POST.attempt_id);
const slides = listSlides(workDir);
eq('슬라이드 7장', slides.length, 7);
eq('render 단계 ok', stepOf('render').ok, true);
eq('그라데이션 폴백(imagen off)', stepOf('render').detail.background, 'gradient');
const gateResult = judge(slides, DRY_CFG);
ok('🔴 gates.mjs 전건 통과', gateResult.ok === true, JSON.stringify(gateResult.checks));
deepEq('게이트 항목 4종', gateResult.checks.map(c => c.name), ['count', 'format', 'dimensions', 'filesize']);
ok('대본이 work/ 에 남았다(재개 자산)', existsSync(join(lib.workDir(R.post_id), 'script.json')));
eq('인덱스 slide_sha256 7개', POST.slide_sha256.length, 7);
eq('public_url 7개', POST.public_url.length, 7);
ok('URL↔sha 교차검증이 성립한다',
  POST.public_url.every((u, i) => u.includes(POST.slide_sha256[i].slice(0, 16))));

// ── ② buildCaption 불변식 ───────────────────────────────────────────────────
console.log('\n  ② 캡션 불변식');
const marker = lib.idemMarker(R.post_id);
ok('2200자 이하', POST.caption.length <= DRY_CFG.caption.max_chars, `${POST.caption.length}자`);
ok('해시태그 30개 이하', POST.hashtag_count <= DRY_CFG.caption.max_hashtags, `${POST.hashtag_count}개`);
ok('cta 보존', POST.caption.includes(SCRIPT.caption_sections.cta));
ok('🔴 멱등 마커가 최말미', POST.caption.trimEnd().endsWith(marker), POST.caption.slice(-40));
eq('저장된 idem_marker 가 마커와 동일', POST.idem_marker, marker);

// ── ③ AC-9 기록 시퀀스 ──────────────────────────────────────────────────────
console.log('\n  ③ AC-9 호출 시퀀스');
// sweep(§3.14.5)도 자기 step 0 에서 가드를 받는다 → 앞 2건은 sweep 몫이다.
// 이 두 줄이 "sweep 이 초크포인트를 우회하지 않는다"는 증거이기도 하다.
deepEq('sweep 이 먼저 자기 가드를 받는다', net.seq.slice(0, 2), ['publishReadiness', 'publishingLimit']);
const AC9 = ['publishReadiness', 'publishingLimit',
  ...Array(7).fill('createChildContainer'), 'createCarouselContainer', 'mediaPublish'];
deepEq('🔴 발행 경로 시퀀스 = AC-9', net.seq.slice(2, 2 + AC9.length), AC9);
deepEq('발행 뒤 노출 확인(liveness) 1회', net.seq.slice(2 + AC9.length), ['getMedia']);
eq('자식 컨테이너 정확히 7회', net.calls.child, 7);
eq('mediaPublish 정확히 1회', net.calls.publish, 1);
eq('스토리지 업로드 7회', net.calls.put, 7);
ok('스토리지 공개 GET ≥ 14회(업로드 검증 7 + resume 검증 7)', net.calls.get >= 14, String(net.calls.get));

// ── ④ history 9-state ───────────────────────────────────────────────────────
console.log('\n  ④ history 9-state 순서');
const transitions = POST.history.filter(h => 'to' in h);
eq('첫 전이의 from 은 null(post 없음)', transitions[0].from, null);
deepEq('🔴 9-state 순서', transitions.map(h => h.to), [
  'planned', 'scripted', 'rendered', 'hosted',
  'child_containers_partial', 'carousel_container_created', 'publish_unknown', 'published',
]);
ok('flush 도 기록됐다(같은 상태 영속화)', POST.history.some(h => h.kind === 'flush'));
eq('최종 상태', POST.status, 'published');
eq('published_media_id', POST.published_media_id, 'media-dryrun-1');
eq('liveness 확인됨', POST.liveness, 'confirmed');

// ── ⑤ guardPublish 가 createChildContainer 보다 먼저 ────────────────────────
console.log('\n  ⑤ 가드가 자식 컨테이너보다 먼저');
const firstChild = net.seq.indexOf('createChildContainer');
const guardBefore = net.seq.lastIndexOf('publishReadiness');
ok('🔴 publishReadiness < createChildContainer', guardBefore >= 0 && firstChild > guardBefore,
  `readiness@${guardBefore} child@${firstChild}`);
ok('limit 조회도 자식 생성보다 먼저', net.seq.lastIndexOf('publishingLimit') < firstChild);

// ── ⑥ runs.jsonl 1줄 ───────────────────────────────────────────────────────
console.log('\n  ⑥ runs.jsonl');
const runs = lib.loadRuns();
eq('🔴 정확히 1줄', runs.length, 1);
eq('outcome', runs[0].outcome, 'published');
eq('post_id 기록', runs[0].post_id, R.post_id);
eq('slot', runs[0].slot, '11');
eq('date(KST)', runs[0].date, '2026-08-01');
eq('실패 분류 없음', runs[0].failure_class, null);

// ── 보너스: buffer 적립(§3.16 step 10) ──────────────────────────────────────
console.log('\n  보너스 — 발행 뒤 예비 대본 적립');
const banked = loadBuffer();
eq('max_topup_per_run 만큼 적립', banked.length, DRY_CFG.buffer.max_topup_per_run);
ok('적립분은 오늘 쓴 소재가 아니다', banked.every(b => b.backlog_id !== 'jpdining01'),
  banked.map(b => b.backlog_id).join(','));

// ═══ 2. 폴트 (A) — 팩트체크 hold 는 다음날 다시 뽑히지 않는다 ═══════════════
console.log('\n[2] 폴트 (A) — 팩트체크 hold 가 pending 풀에서 빠진다');
{
  resetState();
  lib.appendBacklog([...SEED, ...REFILL]);           // 6건 ≥ 임계 5 → 보충 생략

  const net2 = makeFetch();
  // 전건 doubtful → 상위 3후보가 전부 hold → 오늘은 내지 않는다.
  const claude2 = makeClaude({ factcheck: () => ({ verdict: 'doubtful', note: '근거가 약하다', source: '' }) });
  const R2 = await run.runDaily({
    cfg: DRY_CFG,
    slot: '11',
    deps: {
      now: () => NOW, callClaude: claude2.impl, fetchImpl: net2.impl, meta: recordingMeta(net2.seq),
      notifier: async () => ({ telegram: 'sent' }), sleep: async () => {},
      checkBudget: stubBudget, charge: () => ({}),
      renderCards: async () => { throw new Error('팩트체크에서 막혔는데 렌더가 돌았다'); },
    },
  });

  eq('런 실패(발행 없음)', R2.ok, false);
  eq('사유', R2.reason, 'factcheck:all-held');
  eq('🔴 자식 컨테이너 0회 — Meta 발행 경로에 닿지 않았다', net2.calls.child, 0);
  eq('mediaPublish 0회', net2.calls.publish, 0);

  const idx = lib.loadIndex();
  const heldPosts = Object.values(idx).filter(p => p.status === 'held');
  eq('hold 3건이 인덱스에 남았다', heldPosts.length, 3);
  ok('전부 held_reason 이 factcheck: 접두', heldPosts.every(p => String(p.held_reason).startsWith('factcheck:')),
    heldPosts.map(p => p.held_reason).join(','));
  ok('🔴 전부 permanent — sweep 이 되살리지 않는다', heldPosts.every(p => p.held_class === 'permanent'),
    heldPosts.map(p => p.held_class).join(','));
  ok('held_diag 가 채워졌다(분류 없는 held 는 만들 수 없다)', heldPosts.every(p => p.held_diag && p.held_diag.stage === 'factcheck'));
  ok('backlog_id 가 채워졌다 — 이게 없으면 소비 판정이 성립하지 않는다',
    heldPosts.every(p => typeof p.backlog_id === 'string' && p.backlog_id.length > 0));

  // 🔴 핵심: 다음날 pending 풀에서 빠진다.
  const heldIds = new Set(heldPosts.map(p => p.backlog_id));
  const pending = pendingBacklog().map(x => x.id);
  ok('🔴 held 소재가 pending 에서 제외됐다', [...heldIds].every(id => !pending.includes(id)),
    `held=${[...heldIds].join(',')} pending=${pending.join(',')}`);
  // 개수를 상수로 박지 않는다 — 보충 임계는 `pick.daily_target × refill_buffer_days` 라서
  // 하루 발행 편수를 바꾸면(1→2) 보충이 돌지 말지가 뒤집히고, 상수 기대값은 그때 조용히
  // 무의미해진다. 실제 불변식은 "pending = 백로그 − held" 하나다.
  eq('남은 후보 = 백로그 − held', pending.length, lib.loadBacklog().length - heldIds.size);

  // 다음날(08-02) 선정 — 어제 막힌 것이 다시 최고점으로 올라오지 않는다.
  const claude3 = makeClaude();
  const nextDay = pick({ cfg: DRY_CFG, deps: { callClaude: claude3.impl }, logScores: false });
  ok('다음날 pick 이 held 소재를 고르지 않는다', !heldIds.has(nextDay.pick.id),
    `picked=${nextDay.pick.id}`);
  ok('breakdown 에도 held 소재가 없다', nextDay.breakdown.every(b => !heldIds.has(b.id)),
    nextDay.breakdown.map(b => b.id).join(','));

  const runs2 = lib.loadRuns();
  eq('runs.jsonl 1줄', runs2.length, 1);
  eq('outcome=held', runs2[0].outcome, 'held');
  eq('failure_stage=factcheck', runs2[0].failure_stage, 'factcheck');
  eq('failure_class=permanent', runs2[0].failure_class, 'permanent');
}

// ═══ 3. 폴트 (B) — 조기 종료 3경로가 전부 appendRun 을 지난다 ═══════════════
console.log('\n[3] 폴트 (B) — 0/0a/0b 조기 종료도 runs.jsonl 1줄 (1-B)');
{
  const boom = async () => { throw new Error('조기 종료 경로에서 네트워크가 열렸다'); };
  const nope = () => { throw new Error('조기 종료 경로에서 claude 가 호출됐다'); };

  // (0) 킬스위치
  resetState();
  const rDis = await run.runDaily({
    cfg: { ...DRY_CFG, enabled: false }, slot: '11',
    deps: { now: () => NOW, callClaude: nope, fetchImpl: boom },
  });
  deepEq('킬스위치 반환', { ok: rDis.ok, skipped: rDis.skipped }, { ok: true, skipped: 'disabled' });
  ok('index.json 미생성', !existsSync(lib.indexPath()));
  let rows = lib.loadRuns();
  eq('runs 1줄', rows.length, 1);
  eq('outcome', rows[0].outcome, 'skipped-disabled');

  // (0a) 토큰 halt — sweep 보다 먼저라 Meta 호출이 0회여야 한다(§7.3 시나리오 20)
  resetState();
  const rHalt = await run.runDaily({
    cfg: DRY_CFG, slot: '11',
    deps: {
      now: () => NOW, callClaude: nope, fetchImpl: boom,
      runTokenMaintenance: async () => ({ plan: { action: 'halt', severity: 'alert' }, refreshed: null, alerted: true, delivered: { telegram: 'sent' } }),
      checkBudget: () => { throw new Error('토큰 halt 뒤에 예산 검사가 돌았다'); },
    },
  });
  eq('토큰 halt 는 실패', rHalt.ok, false);
  eq('사유', rHalt.reason, 'token:halt');
  rows = lib.loadRuns();
  eq('runs 1줄', rows.length, 1);
  eq('outcome=halt', rows[0].outcome, 'halt');
  eq('failure_stage=token', rows[0].failure_stage, 'token');
  eq('🔴 external — 1-A 집계에서 빠진다', rows[0].failure_class, 'external');

  // (0b) 예산 halt — claude·Meta 호출 0회(§7.3 시나리오 22)
  resetState();
  const rBudget = await run.runDaily({
    cfg: DRY_CFG, slot: '11',
    deps: {
      now: () => NOW, callClaude: nope, fetchImpl: boom,
      runTokenMaintenance: async () => ({ plan: { action: 'noop', severity: null } }),
      checkBudget: () => ({ ok: false, calls_used: 999, caps: { calls: 999 } }),
    },
  });
  eq('예산 halt 는 실패', rBudget.ok, false);
  rows = lib.loadRuns();
  eq('runs 1줄', rows.length, 1);
  eq('outcome=halt', rows[0].outcome, 'halt');
  eq('failure_stage=budget', rows[0].failure_stage, 'budget');
  eq('failure_class=external', rows[0].failure_class, 'external');

  // (2) 후보 0건 → no-pick (post 가 생기기 전 종료 — 07-25/26 의 모양)
  resetState();
  const rNoPick = await run.runDaily({
    cfg: { ...DRY_CFG, backlog: { ...DRY_CFG.backlog, refill_buffer_days: 0 } }, slot: '11',
    deps: {
      now: () => NOW, callClaude: nope, fetchImpl: makeFetch().impl,
      meta: recordingMeta([]), checkBudget: stubBudget, charge: () => ({}),
      runTokenMaintenance: async () => ({ plan: { action: 'noop', severity: null } }),
    },
  });
  eq('no-pick 은 오류가 아니다', rNoPick.ok, true);
  eq('pick 없음', rNoPick.pick, null);
  rows = lib.loadRuns();
  eq('runs 1줄', rows.length, 1);
  eq('outcome=no-pick', rows[0].outcome, 'no-pick');
  eq('post_id 는 null(아직 post 가 없다)', rows[0].post_id, null);
  ok('인덱스는 비어 있다', !existsSync(lib.indexPath()) || Object.keys(lib.loadIndex()).length === 0);
}

// ═══ 4. 2차 방어 — 디스크 마스터 스위치는 여전히 닫혀 있다 ═══════════════════
console.log('\n[4] 2차 방어 — config/cardnews.json publish.enabled');
{
  eq('🔴 디스크 설정은 false 그대로', DISK_CFG.publish.enabled, false);
  const readiness = metaModule.publishReadiness(DISK_CFG, null);
  eq('readiness 차단', readiness.ready, false);
  ok('사유가 마스터 스위치를 지목', /publish\.enabled=false/.test(readiness.reason), readiness.reason);

  let netCalls = 0;
  const g = await metaModule.guardPublish(DISK_CFG, {
    ig_user_id: 'x', access_token: 'x', issued_at: 'x', expires_at: 'x',
  }, { fetchImpl: async () => { netCalls++; throw new Error('열리면 안 된다'); } });
  eq('가드가 readiness 에서 막힌다', g.gate, 'readiness');
  eq('🔴 네트워크 0회 — 한도 조회조차 하지 않는다', netCalls, 0);
}

// ═══ 5. 설정 정합성 가드 — 장수 두 출처가 어긋나면 즉시 세운다 ═══════════════
// 🔴 gates.expected_count 와 cards.body_count 는 독립된 두 출처다(게이트는 결정론이라
//    script.mjs 를 import 하지 않는다 — 그게 맞다). 어긋나면 이미지 게이트가 fail-closed 로
//    **매일** held(gate:image)를 내고 permanent 로 분류돼, 설정 오타가 "콘텐츠 품질 문제"로
//    위장한 영구 결방이 된다. 런 시작에 한 번 대조해 시끄럽게 세운다.
console.log('\n[5] 설정 정합성 — expected_count vs body_count');
{
  const bad = JSON.parse(JSON.stringify(DISK_CFG));
  bad.publish.enabled = true;
  bad.cards.body_count = 5;
  bad.gates.expected_count = 9;          // 5+2=7 이어야 하는데 9
  let netCalls = 0;
  const r = await run.runDaily({
    cfg: bad,
    deps: { fetchImpl: async () => { netCalls++; throw new Error('여기까지 오면 안 된다'); } },
  });
  eq('런이 멈춘다', r.ok, false);
  eq('사유가 설정 불일치', r.reason, 'config-mismatch');
  eq('🔴 네트워크 0회 — 게이트까지 가지도 않는다', netCalls, 0);
  const rows = lib.loadRuns();
  eq('runs 에 기록된다(원인 분류 가능 — 1-B)', rows.at(-1).failure_stage, 'config');
  eq('permanent 로 분류(사람이 고쳐야 함)', rows.at(-1).failure_class, 'permanent');
}

// ═══ 6. 버려진 중간 상태 회수 ═══════════════════════════════════════════════
// 🔴 pendingBacklog 는 "인덱스에 있으면 소비됨"으로 본다. runDaily 는 generateScript 앞에서
//    planned 를 만들므로, 대본 생성이 죽으면 그 소재는 planned 로 남아 영원히 다시 안 뽑힌다
//    — 장애 하루당 백로그 1건이 조용히 탄다. 게다가 planned 는 held 가 아니라 held_class 가
//    없어 1-B(원인 분류 가능)에서 아예 안 보인다.
console.log('\n[6] reapAbandoned — planned/scripted 방치분 회수');
{
  const now = new Date('2026-08-10T12:00:00+09:00');
  const old = new Date('2026-08-08T12:00:00+09:00');   // 2일 전
  const fresh = new Date('2026-08-10T09:00:00+09:00'); // 3시간 전

  lib.transition(lib.postIdFor('aaaaaaaaaa', old), 'planned', { backlog_id: 'aaaaaaaaaa' }, { now: old });
  lib.transition(lib.postIdFor('bbbbbbbbbb', fresh), 'planned', { backlog_id: 'bbbbbbbbbb' }, { now: fresh });

  const r = run.reapAbandoned({ now });
  eq('오래된 것만 회수', r.reaped, 1);
  const reapedId = lib.postIdFor('aaaaaaaaaa', old);
  const freshId = lib.postIdFor('bbbbbbbbbb', fresh);
  eq('회수분은 held', lib.getPost(reapedId).status, 'held');
  eq('사유가 남는다', lib.getPost(reapedId).held_reason, 'planned:abandoned');
  ok('🔴 held_class 가 붙는다 — 1-B 에서 보인다', Boolean(lib.getPost(reapedId).held_class),
    lib.getPost(reapedId).held_class);
  eq('최근 것은 건드리지 않는다', lib.getPost(freshId).status, 'planned');
  eq('재실행해도 중복 회수 없다(멱등)', run.reapAbandoned({ now }).reaped, 0);
}

// ═══ 7. 일일 상한 — 슬롯이 두 번 깨워도 하루 1건 ═══════════════════════════
// 🔴 cron 은 11시·19시 두 번 깨운다. 가드가 없으면 슬롯마다 한 건씩 나가 하루 2건이 되고,
//    인스타는 삭제 API 가 없어 되돌릴 수 없다. 계획은 이 가드를 slot.mjs(Step 6)에 뒀지만
//    그 파일이 생기기 전에 cron 이 먼저 걸리면 그날로 사고다 — 오케 자체가 막는다.
console.log('\n[7] 일일 상한 — slot.daily_cap 이 단일 출처');
{
  /**
   * 오늘 발행 완료된 포스트를 n건 심는다.
   *
   * ⚠ 시드 id 는 **앞쪽에서** 갈라져야 한다. `postIdFor` 는 백로그 id 를 10자로 잘라
   * post_id 를 만들기 때문에 `alreadydone0`/`alreadydone1` 같은 이름은 같은 post_id 로
   * 충돌해 두 번째 전이가 `published → planned` 로 터진다.
   */
  const seedPublished = (n) => {
    for (let i = 0; i < n; i++) {
      const p = lib.postIdFor(`d${i}one`, NOW);
      for (const st of ['planned', 'scripted', 'rendered', 'hosted', 'child_containers_partial',
        'carousel_container_created', 'publish_unknown', 'published']) {
        lib.transition(p, st, st === 'published'
          ? { published_media_id: `99${i}`, published_at: NOW.toISOString() } : {}, { now: NOW });
      }
    }
  };
  /**
   * 상한 가드만 보는 런.
   *
   * ⚠ `callClaude` 를 반드시 막는다. 상한을 **통과하는** 경우 런은 backlog·pick 으로 계속
   * 진행하고, 스텁이 없으면 테스트가 실제 claude CLI 를 붙잡아 5분 타임아웃까지 간다.
   * 여기서 알고 싶은 것은 "상한에서 멈췄는가" 하나뿐이므로 그 뒤는 즉시 끊는다.
   */
  const runBlocked = async (cfg) => {
    let net = 0, llm = 0;
    const r = await run.runDaily({
      cfg, slot: '19',
      deps: {
        now: () => NOW,
        fetchImpl: async () => { net++; throw new Error('상한에 걸렸어야 한다'); },
        callClaude: () => { llm++; throw new Error('상한 통과 후 진행 — 여기서 끊는다'); },
        checkBudget: stubBudget, charge: () => ({}),
      },
    });
    return { r, net, llm };
  };

  const mk = (cap) => {
    const c = JSON.parse(JSON.stringify(DRY_CFG));
    c.publish.enabled = true;
    c.slot = { ...(c.slot || {}), daily_cap: cap };
    return c;
  };

  // ── 하루 2편 체제: 1건 발행된 상태에서 두 번째 슬롯은 **가야 한다** ──────────
  // 이게 이중 생성의 전부다. 여기가 막히면 코덱스판은 영영 나가지 않는다.
  resetState();
  seedPublished(1);
  const { r: r1, llm: llm1 } = await runBlocked(mk(2));
  ok('cap=2 · 1건 발행됨 → 두 번째 슬롯은 건너뛰지 않는다', r1.skipped !== 'daily_cap',
    `skipped=${r1.skipped} reason=${r1.reason}`);
  ok('실제로 제작 단계까지 나아갔다(가드만 통과하고 멈춘 게 아니다)', llm1 > 0, `llm=${llm1}`);
  eq('daily_cap 단계는 통과로 기록', r1.steps.find(s => s.step === 'daily_cap')?.detail?.cap, 2);

  // ── 상한을 채우면 막는다 — 인스타는 삭제 API 가 없어 되돌릴 수 없다 ─────────
  resetState();
  seedPublished(2);
  const { r: r2, net: net2 } = await runBlocked(mk(2));
  eq('cap=2 · 2건 발행됨 → 세 번째 기상은 건너뛴다', r2.skipped, 'daily_cap');
  eq('ok 로 끝난다(실패가 아니다)', r2.ok, true);
  eq('🔴 네트워크 0회 — sweep 조차 안 돈다', net2, 0);

  const last = lib.loadRuns().at(-1);
  eq('runs 에 skipped-cap 으로 기록', last.outcome, 'skipped-cap');
  ok('🔴 error 로 clamp 되지 않는다 — 정상 스킵이 실패일로 집계되면 가용성 지표가 오염된다',
    last.outcome !== 'error', last.outcome);

  // ── 🔴 `slot.daily_cap` 이 실제로 읽히는가 ─────────────────────────────────
  // 예전 코드는 존재하지 않는 `publish.daily_cap` 을 먼저 봐서 `slot.daily_cap` 이 **죽은
  // 손잡이**였다. config 를 고쳐도 아무 일이 안 일어나는 상태였으므로, 값이 실제로 반영되는지를
  // 못박아 둔다. 하루 편수를 바꿀 때 이 테스트가 유일한 안전망이다.
  resetState();
  seedPublished(1);
  const { r: r3 } = await runBlocked(mk(1));
  eq('cap=1 로 내리면 1건에서 바로 막힌다(= slot.daily_cap 이 읽힌다)', r3.skipped, 'daily_cap');
}

// ═══ 8. 이중 생성 배선 — 오케 ↔ writer ══════════════════════════════════════
//
// 🔴 여기가 확인하는 것은 writer.mjs 단위테스트가 볼 수 없는 **배선**이다: 오케가 배정된
// 작가에게 실제로 대본을 맡기는가, 그리고 누가 썼는지가 포스트와 런 기록 양쪽에 남는가.
// 남지 않으면 "오늘 두 편이 왜 같은 문체인가"를 나중에 설명할 수 없고, 모델별 성과를
// 보려 해도 분모가 없다.
//
// 렌더부터는 이 절의 관심사가 아니므로 스텁으로 끊는다(chromium 을 두 번 더 돌리지 않는다).
console.log('\n[8] 이중 생성 — 오케가 배정된 작가에게 맡기고 그 사실을 남긴다');
{
  const runWithGenerator = async (generator, callCodex) => {
    resetState();
    lib.appendBacklog(SEED);
    const c = makeClaude();
    const n = makeFetch();
    const r = await run.runDaily({
      cfg: DRY_CFG, slot: '19',
      deps: {
        now: () => NOW, generator, callCodex,
        callClaude: c.impl, fetchImpl: n.impl, meta: recordingMeta(n.seq),
        notifier: async () => ({ telegram: 'sent' }), sleep: async () => {},
        checkBudget: stubBudget, charge: () => ({}),
        renderCards: async () => ({ ok: false, reason: 'stub-here' }),
      },
    });
    return { r, claudeStages: c.calls, post: r.post_id ? lib.getPost(r.post_id) : null, run: lib.loadRuns().at(-1) };
  };

  // ── 코덱스 배정 — 코덱스가 쓰고, 클로드는 대본을 쓰지 않는다 ────────────────
  let codexCalls = 0;
  const codexStub = (prompt) => { codexCalls++; return makeClaude().impl(prompt); };
  const a = await runWithGenerator('codex', codexStub);

  eq('렌더 스텁에서 멈췄다(그 앞은 다 지났다)', a.r.reason, 'render:stub-here');
  ok('코덱스가 대본을 썼다', codexCalls > 0, `codex=${codexCalls}`);
  ok('🔴 클로드는 대본을 쓰지 않았다', !a.claudeStages.includes('script'),
    a.claudeStages.join('>'));
  ok('클로드는 나머지 단계(pick·factcheck)는 그대로 맡는다',
    a.claudeStages.includes('pick') && a.claudeStages.includes('factcheck'),
    a.claudeStages.join('>'));
  eq('포스트에 generator 가 남는다', a.post?.generator, 'codex');
  eq('폴백이 없었으므로 실제 집필자도 codex', a.post?.generator_effective, 'codex');
  eq('런 기록에도 generator', a.run?.generator, 'codex');
  ok('런 기록에 코덱스 호출수', Number(a.run?.codex_calls) > 0, String(a.run?.codex_calls));
  eq('폴백 기록 없음', a.run?.generator_fallback, null);

  // ── 코덱스 실패 → 클로드가 대신 쓴다(사용자 결정: "매일 2편"이 우선) ────────
  const b = await runWithGenerator('codex', () => {
    const e = new Error('코덱스가 죽은 날'); e.diag = { kind: 'transient' }; throw e;
  });
  eq('폴백해도 런은 대본까지 갔다', b.r.reason, 'render:stub-here');
  ok('🔴 결방하지 않았다 — 클로드가 대본을 썼다', b.claudeStages.includes('script'),
    b.claudeStages.join('>'));
  eq('배정은 codex 로 남고', b.post?.generator, 'codex');
  eq('🔴 실제 집필자는 claude 로 구분된다', b.post?.generator_effective, 'claude');
  eq('런 기록에 폴백 1건', b.run?.generator_fallback?.length, 1);
  eq('폴백 사유가 남는다', b.run?.generator_fallback?.[0]?.reason, 'transient');

  // ── 클로드 배정 — 코덱스는 아예 불리지 않는다 ──────────────────────────────
  const c2 = await runWithGenerator('claude', () => {
    throw new Error('클로드 배정인데 코덱스가 불렸다');
  });
  eq('클로드 배정도 대본까지 간다', c2.r.reason, 'render:stub-here');
  eq('generator=claude', c2.post?.generator, 'claude');
  eq('코덱스 호출 0회', c2.run?.codex_calls, 0);

  // ── 🔴 같은 날 두 슬롯이 **다른 소재**를 집는가 ────────────────────────────
  //
  // 이중 생성의 전제 전체가 여기 걸려 있다. 두 슬롯이 같은 소재를 집으면 하루 피드에 같은
  // 책·같은 구절이 두 번 나가고, 그건 사용자가 명시적으로 거절한 형태다("다른 소재를 하나씩").
  //
  // 이 성질에는 전용 장치가 없다 — `pendingBacklog` 가 "인덱스에 있으면 소비됨"으로 보기
  // 때문에 **자동으로** 보장된다. 전용 코드가 없다는 것은 곧 리팩터링이 조용히 깨뜨릴 수
  // 있다는 뜻이므로, 추론이 아니라 실행으로 못박아 둔다.
  resetState();
  lib.appendBacklog(SEED);
  const slotRun = async (slot, generator) => {
    const c = makeClaude();
    const n = makeFetch();
    const r = await run.runDaily({
      cfg: DRY_CFG, slot, generator,
      deps: {
        now: () => NOW, generator, callCodex: (p) => makeClaude().impl(p),
        callClaude: c.impl, fetchImpl: n.impl, meta: recordingMeta(n.seq),
        notifier: async () => ({ telegram: 'sent' }), sleep: async () => {},
        checkBudget: stubBudget, charge: () => ({}),
        renderCards: async () => ({ ok: false, reason: 'stub-here' }),
      },
    });
    return lib.getPost(r.post_id)?.backlog_id ?? null;
  };

  const first = await slotRun('11', 'claude');
  const second = await slotRun('19', 'codex');
  ok('11시 슬롯이 소재를 하나 집었다', Boolean(first), String(first));
  ok('19시 슬롯도 소재를 하나 집었다', Boolean(second), String(second));
  ok('🔴 두 슬롯이 서로 다른 소재를 집는다', first !== second, `11시=${first} 19시=${second}`);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\ncardnews 통합 드라이런(Step 5.5): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
