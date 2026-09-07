#!/usr/bin/env node
/**
 * run-lion.mjs — Lion 오케스트레이터 일일 런
 * §D2 알고리즘 구현 (mock 모드 완전 지원)
 *
 * 실행: RUN_MODE=mock node scripts/run-lion.mjs
 *
 * 단계:
 *   0. lock 획득 → killswitch 확인 → 예산 사전체크
 *   1. 수집: cheetah/owl/magpie 병렬 → charge budget
 *   2. 주제 3 선정 (dedup_key vs published-index.json, 부족시 seed backfill)
 *   3. 작가 배정(type→beaver/fox/wolf) → 초안 3 생성(mockDraft) → 파일 기록
 *   4. 각 초안 결정론 게이트 1차(run-all-gates, LLM 앞) → hard_fail은 5단계 스킵
 *   5. 생존 초안 검증 4(eagle/bee/swan/raven, mockReview) 병렬
 *      publishable = gate.all_pass AND 4명 무차단(authority advisory)
 *   6. publishable → 발행(published/ 파일 기록; live만 git commit)
 *      → verify(mock); 아니면 retry<2 재조사 루프(→4단계); 초과 폐기
 *   7. 감사로그 append + 알림(notify) + lock 해제
 *   8. 런 요약 runs/<date>/run.json 기록
 */

import {
  mkdirSync, writeFileSync, readFileSync,
  existsSync, appendFileSync, unlinkSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { execFile, execSync, execFileSync } from 'node:child_process';
import { promisify }              from 'node:util';
import { createHash }             from 'node:crypto';

import { isMock, paths, loadPipeline } from './lib/config.mjs';
import { mockResearch, mockDraft, mockReview } from './lib/mock-llm.mjs';
import { makeLogger }             from './lib/log.mjs';
import { fetchReddit }            from './reddit/fetch.mjs';
import { fetchHN }                from './reddit/hn.mjs';
import { normalizePosts, normalizeHnItems } from './reddit/normalize.mjs';
import { acquireLock, releaseLock } from './watchdog/lock.mjs';
import { isKilled }               from './watchdog/killswitch.mjs';
import { checkBudget, charge, checkImageBudget, chargeImage } from './watchdog/budget.mjs';
import { appendAudit, ACTIONS }   from './audit/append.mjs';
import { notify, EVENTS }         from './notify/index.mjs';
import { waitDeploy }             from './deploy/wait-deploy.mjs';
import { designClaude }           from './design/claude-designer.mjs';
import { designGemini }           from './design/gemini-designer.mjs';
import { judgeImages, judgeToRunJson } from './design/judge.mjs';
import { publishFileToDb, isBlogDbEnabled } from './hub/blog-db.mjs';
import { generateBriefing }        from './hub/briefing.mjs';
import { assertSafeSlug, isSafeSlug } from './lib/slug.mjs';

const execFileAsync = promisify(execFile);

// ─── 니치 가중 스코어링 ────────────────────────────────────────────────────────
/**
 * topic_targeting.niche_keywords 기반 가중 점수 계산.
 * topic.title + topic.keywords 배열을 소문자 변환 후 keyword 부분매칭 → weight 합산.
 */
function scoreTopicNiche(topic, nicheKeywords) {
  if (!nicheKeywords || nicheKeywords.length === 0) return 0;
  const haystack = [
    topic.title || '',
    ...(Array.isArray(topic.keywords) ? topic.keywords : []),
  ].join(' ').toLowerCase();
  return nicheKeywords.reduce((sum, { keyword, weight }) => {
    return sum + (haystack.includes((keyword || '').toLowerCase()) ? (weight || 1) : 0);
  }, 0);
}

// ─── 경로 헬퍼 ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = dirname(__filename);
const ROOT_DIR    = resolve(SCRIPTS_DIR, '../');

const log = makeLogger('lion');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function runDir(date) {
  return join(paths.runs, date);
}

function draftsDir(date) {
  return join(runDir(date), 'drafts');
}

// mock 격리: mock 발행물·상태가 실제 아카이브(published/)와 live state를 오염시키지 않도록
// .mock-out 아래로 분리. STATE_DIR_OVERRIDE 주입 테스트(edge.mjs)는 그대로 존중.
function mockIsolatedStatePath(filename) {
  if (isMock() && !process.env.STATE_DIR_OVERRIDE) {
    return join(paths.mockOut, 'state', filename);
  }
  return join(paths.state, filename);
}

function publishedDir() {
  return isMock() ? join(paths.mockOut, 'published') : join(ROOT_DIR, 'published');
}

// Astro 사이트가 렌더하는 콘텐츠 컬렉션 디렉터리.
// published/ 는 발행 원장(archive)이고, 실제 사이트 렌더 소스는 여기다.
function contentBlogDir() {
  return join(ROOT_DIR, 'site', 'src', 'content', 'blog');
}

function publishedIndexPath() {
  return mockIsolatedStatePath('published-index.json');
}

function topicHistoryPath() {
  return mockIsolatedStatePath('topic-history.jsonl');
}

// ─── 유틸 ─────────────────────────────────────────────────────────────────────

function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function uid() {
  return Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 6);
}

// ─── 발행 인덱스 로드/저장 ────────────────────────────────────────────────────

function loadPublishedIndex() {
  const p = publishedIndexPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    const idx = JSON.parse(raw);
    if (typeof idx !== 'object' || Array.isArray(idx)) {
      log.warn('published-index.json 구조 손상 — 빈 인덱스로 초기화');
      return {};
    }
    return idx;
  } catch (err) {
    log.warn('published-index.json 파싱 실패 — 빈 인덱스로 시작', err);
    return {};
  }
}

function savePublishedIndex(index) {
  const dir = dirname(publishedIndexPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(publishedIndexPath(), JSON.stringify(index, null, 2), 'utf8');
  } catch (err) {
    log.error('published-index.json 저장 실패', err);
  }
}

// ─── topic-history append (동기) ──────────────────────────────────────────────

function appendTopicHistorySync(topic, fate) {
  const dir = dirname(topicHistoryPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const entry = JSON.stringify({
    id:        topic.id,
    dedup_key: topic.dedup_key,
    title:     topic.title,
    fate,
    ts:        new Date().toISOString(),
  });
  try {
    appendFileSync(topicHistoryPath(), entry + '\n', 'utf8');
  } catch (err) {
    log.error('topic-history.jsonl 기록 실패', err);
  }
}

// ─── seed-topics.md 파싱 → 백필용 Topic[] ────────────────────────────────────

function loadSeedTopics() {
  const p = join(ROOT_DIR, 'seed-topics.md');
  if (!existsSync(p)) {
    log.warn('seed-topics.md 없음 — 백필 불가');
    return [];
  }
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch (err) {
    log.error('seed-topics.md 읽기 실패', err);
    return [];
  }
  const lines = text.split('\n').filter(l => /^\d+\./.test(l.trim()));
  return lines.map((l, i) => {
    const match    = l.match(/^\d+\.\s+\*\*(.+?)\*\*\s*(?:—\s*(.+))?$/);
    const title    = match ? match[1].trim() : l.replace(/^\d+\.\s*/, '').trim();
    const angle    = match ? (match[2] || '').trim() : '';
    const keywords = title.split(/\s+/).filter(w => w.length >= 2).slice(0, 4);
    const dedup_key = sha256hex(
      title.toLowerCase() + '|' + [...keywords].sort().join(',')
    ).slice(0, 16);
    return {
      id:          `topic-seed-${i + 1}`,
      source:      'depth',
      collector:   'owl',
      title,
      angle:       angle || '시드 주제 — 직접 분석 필요',
      keywords,
      source_refs: [],
      dedup_key,
      created_at:  new Date().toISOString(),
    };
  });
}

// ─── 작가 배정 & outline 생성 ────────────────────────────────────────────────

const WRITER_ROTATION = ['beaver', 'fox', 'wolf'];

function assignWriter(index) {
  return WRITER_ROTATION[index % WRITER_ROTATION.length];
}

function makeOutline(topic, writer) {
  return {
    id:              `outline-${uid()}`,
    topic_id:        topic.id,
    slug:            `post-${uid()}`,
    writer_assigned: writer,
    target_chars:    [1500, 2000],
    sections:        ['도입', '본문', '결론'],
    created_at:      new Date().toISOString(),
  };
}

// ─── 초안 파일 기록 (§A2 Draft frontmatter) ──────────────────────────────────

function saveDraft(draft, date) {
  const dir = draftsDir(date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filepath = join(dir, `${draft.id}.draft.md`);
  try {
    writeFileSync(filepath, draft.content, 'utf8');
  } catch (err) {
    throw new Error(`초안 파일 기록 실패 (${draft.id}): ${err.message}`);
  }
  return filepath;
}

// ─── 게이트 실행 (run-all-gates.mjs 자식 프로세스 호출) ─────────────────────

async function runGates(draftPath) {
  const gatesScript = join(SCRIPTS_DIR, 'gates', 'run-all-gates.mjs');

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execFileAsync(
      process.execPath,
      [gatesScript, draftPath],
      { timeout: 120_000 }
    );
    stdout   = result.stdout;
    stderr   = result.stderr;
    exitCode = 0;
  } catch (e) {
    stdout   = e.stdout ?? '';
    stderr   = e.stderr ?? '';
    exitCode = e.code ?? 2;
  }

  // 게이트 stderr는 진행 로그로 pass-through
  if (stderr) process.stderr.write(stderr);

  // stdout 첫 JSON 행 파싱
  const firstJson = stdout.split('\n').find(l => l.trim().startsWith('{'));
  if (!firstJson) {
    log.warn(`게이트 출력 파싱 실패 (exit ${exitCode}): ${stdout.slice(0, 100)}`);
    return { all_pass: false, gates: [], evidence: {}, _parse_error: true };
  }

  try {
    return JSON.parse(firstJson);
  } catch {
    log.warn('게이트 JSON 파싱 오류');
    return { all_pass: false, gates: [], evidence: {}, _parse_error: true };
  }
}

async function runValidators(draft) {
  const validators = ['eagle', 'bee', 'swan', 'raven'];
  return Promise.all(validators.map(v => Promise.resolve(mockReview(draft, v))));
}

// ─── 이미지 디자이너 듀얼 단계 (비차단·advisory) ─────────────────────────────
// 디자이너 2명(Claude SVG·Gemini 래스터) 병렬 후보 → judge 1장 선택.
// 발행 차단권 없음 — 실패/스킵 시 null 반환(이미지 없이 발행). 미어켓 가드: judge blind.

async function runImageStage(draft, topic) {
  const t = topic || { title: draft.title, id: draft.topic_id };

  // 1) 두 디자이너 병렬 후보 (각자 실패는 null로 흡수)
  const [claudeC, geminiC] = await Promise.all([
    designClaude(t, draft).catch(e => { log.warn(`[step5.5] claude-designer 실패: ${e.message}`); return null; }),
    designGemini(t, draft).catch(e => { log.warn(`[step5.5] gemini-designer 실패: ${e.message}`); return null; }),
  ]);
  let candidates = [claudeC, geminiC].filter(Boolean);

  // 2) 예산: 실제 래스터(Gemini API, mock 아님)만 image 축 점검·charge. 캡 초과 시 래스터 제외.
  const geminiReal = geminiC && geminiC.meta && geminiC.meta.mock !== true;
  if (geminiReal) {
    if (!checkImageBudget().ok) {
      log.warn('[step5.5] image 예산 캡 초과 — 래스터 후보 제외(글·SVG는 발행)');
      candidates = candidates.filter(c => c !== geminiC);
    } else {
      chargeImage(geminiC.meta.tokens || 1000, 1, 'gemini-raster');
    }
  }

  if (candidates.length === 0) { log.warn('[step5.5] 이미지 후보 0 — 이미지 없이 발행'); return null; }

  // 3) judge 선택 (D2: config image.judge_authority)
  const result = await judgeImages(candidates, draft);
  if (!result || !result.winner) { log.warn('[step5.5] judge winner 없음 — 이미지 없이 발행'); return null; }
  const winner = result.winner;
  log.info(`[step5.5] 이미지 선택: by=${winner.by} authority=${result.authority} reproducible=${result.reproducible} tiebreak=${result.tiebreak}`);

  // 4) 감사 기록 (actor='designer', action=IMAGE). 감사 실패가 이미지 선택을 버리지 않도록 가드.
  try {
    appendAudit({
      actor:      'designer',
      action:     ACTIONS.IMAGE,
      after_hash: sha256hex(String(winner.path || winner.by)).slice(0, 16),
      reason:     `이미지 선택 by=${winner.by} authority=${result.authority}`,
    });
  } catch (e) {
    log.warn(`[step5.5] 이미지 감사 기록 실패(무시): ${e.message}`);
  }

  return {
    cover_image:      (winner.meta && winner.meta.public) || null,
    image_alt:        winner.alt,
    image_by:         winner.by,
    image_candidates: result.scores,
    run_record:       { ...judgeToRunJson(result) },
    winner_path:      winner.path || null,                         // 승자(보존 대상)
    asset_paths:      candidates.map(c => c.path).filter(Boolean), // 전체(고아 정리 후보)
  };
}

// ─── 발행: published/<날짜>-<slug>.md 기록 (live=git commit, mock=파일만) ──────

async function publishDraft(draft, gateResult, date, image = null) {
  const pubDir = publishedDir();
  if (!existsSync(pubDir)) mkdirSync(pubDir, { recursive: true });

  // draft.slug 는 LLM 출력 → 경로 조립 전 검증(`../` 로 published/ 밖 쓰기 차단).
  const slug     = assertSafeSlug(draft.slug || `post-${uid()}`, '발행 slug');
  const filename = `${date}-${slug}.md`;
  const filepath = join(pubDir, filename);

  // 본문: frontmatter 제거 후 발행용 frontmatter 재부착 (§A2 Post 스키마)
  const bodyOnly = draft.content.replace(/^---[\s\S]*?---\n*/, '');
  const gateSha  = sha256hex(JSON.stringify(gateResult)).slice(0, 16);

  // 커버 이미지 frontmatter(이미지 단계 성공 시에만). 비차단: image=null이면 미부착.
  const imageLines = (image && image.cover_image) ? [
    `cover_image: "${image.cover_image}"`,
    `image_alt: "${String(image.image_alt || '').replace(/"/g, '\\"')}"`,
    `image_by: "${image.image_by || ''}"`,
    `image_candidates: ${JSON.stringify(image.image_candidates || [])}`,
  ] : [];

  const pubContent = [
    '---',
    `title: "${draft.title}"`,
    `date: "${date}"`,
    // 🔴 `ready` 다 — 사람 승인 전에는 공개되지 않는다(2026-09-07 관문 도입).
    `status: ready`,
    `slug: "${slug}"`,
    `writer: "${draft.writer}"`,
    `draft_id: "${draft.id}"`,
    `gate_sha: "${gateSha}"`,
    `tags: []`,
    `source_refs: ${JSON.stringify(draft.source_refs || [])}`,
    ...imageLines,
    '---',
    '',
    bodyOnly,
  ].join('\n');

  try {
    writeFileSync(filepath, pubContent, 'utf8');
  } catch (err) {
    throw new Error(`발행 파일 쓰기 실패 (${filepath}): ${err.message}`);
  }
  log.info(`발행 파일 기록: ${filepath}`);

  // 사이트 콘텐츠 컬렉션에도 동일 파일 기록 → Astro 빌드가 렌더(라이브 노출).
  // ⚠ live 모드에서만 동기화한다. mock 런은 mock-llm 더미 본문을 내므로
  // 사이트에 mock 더미가 새어 들어가면 안 된다(git commit을 mock에서 건너뛰는 것과 동일 원칙).
  if (!isMock()) {
    try {
      const blogDir = contentBlogDir();
      if (existsSync(dirname(blogDir)) || existsSync(blogDir)) {
        if (!existsSync(blogDir)) mkdirSync(blogDir, { recursive: true });
        const sitePath = join(blogDir, filename);
        writeFileSync(sitePath, pubContent, 'utf8');
        log.info(`사이트 콘텐츠 기록: ${sitePath}`);
      } else {
        log.warn(`site 콘텐츠 디렉터리 없음 — 사이트 동기화 스킵 (${blogDir})`);
      }
    } catch (err) {
      log.warn(`사이트 콘텐츠 기록 실패 (무시): ${err.message}`);
    }
  } else {
    log.info('mock 모드 — 사이트 콘텐츠 동기화 스킵 (더미 본문 유출 방지)');
  }

  // git add + commit: live 모드에서만 커밋 (mock은 워킹트리에만 파일을 남김)
  let gitSha = null;
  if (!isMock()) {
    try {
      // execFileSync(배열 인자) — 셸 미경유. filepath·slug 는 LLM 출력(draft.slug)에서 오므로
      // 셸 문자열로 조립하면 `$(...)`·백틱이 그대로 실행된다(따옴표로 감싸도 무력).
      execFileSync('git', ['add', '--', filepath], { cwd: ROOT_DIR, stdio: 'pipe' });
      execFileSync(
        'git',
        ['commit', '-m', `feat(publish): publish ${date} — ${slug}`],
        { cwd: ROOT_DIR, stdio: 'pipe' }
      );
      gitSha = execSync(
        'git rev-parse --short HEAD',
        { cwd: ROOT_DIR, encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      log.info(`git commit: ${gitSha}`);
    } catch (e) {
      log.warn(`git commit 실패 (무시): ${e.message}`);
    }
  } else {
    gitSha = 'mock';
    log.info('mock 모드 — git commit 스킵 (파일만 기록)');
  }

  return { filepath, slug, filename, git_sha: gitSha };
}

// ─── 발행 인덱스 갱신 ────────────────────────────────────────────────────────

function addToPublishedIndex(index, topic, draft, pubResult) {
  index[topic.dedup_key] = {
    draft_id:     draft.id,
    topic_id:     topic.id,
    title:        draft.title,
    slug:         draft.slug,
    filename:     pubResult.filename,
    published_at: new Date().toISOString(),
    git_sha:      pubResult.git_sha,
  };
}

// ─── 런 요약 기록 ─────────────────────────────────────────────────────────────

/**
 * 폐기 사유를 draftSummary 에 **요약**해 둔다.
 *
 * 판정 자체는 이미 `attempts[].gate_gates` / `attempts[].reviews` 에 통째로 들어간다.
 * 문제는 찾기다 — 발행 0건인 날 run.json 을 열면 `discarded: [id,id,id]` 만 보이고,
 * 왜 막혔는지 알려면 중첩된 attempts 를 파고들어야 했다. F-17 을 추적할 때 실제로
 * 여기서 시간을 썼다. 그래서 "무엇이 막았나" 한 줄을 초안 레벨에 올린다.
 *
 * 기존 키는 건드리지 않는다(스모크·리포트가 읽는다).
 */
function recordDiscardReason(draftSummary, stage, message) {
  const last = draftSummary.attempts?.[draftSummary.attempts.length - 1] ?? null;

  const blockingGates = (last?.gate_gates ?? [])
    .filter(g => g && g.pass === false)
    .map(g => ({ gate: g.gate ?? 'unknown', reason: g.reason ?? '' }));

  const blockingValidators = (last?.reviews ?? [])
    .filter(r => r && r.verdict !== 'pass')
    .map(r => ({ validator: r.validator ?? 'unknown', verdict: r.verdict ?? 'unknown',
                 reason: r.reasons?.[0] ?? '' }));

  draftSummary.discard_reason = {
    stage,                       // 'slug' | 'gate' | 'validator' | 'publish'
    message,
    attempts_used: draftSummary.attempts?.length ?? 0,
    blocking_gates: blockingGates,
    blocking_validators: blockingValidators,
  };
  return draftSummary.discard_reason;
}

function saveRunSummary(date, summary) {
  const dir = runDir(date);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const summaryPath = join(dir, 'run.json');

  // 최상위 롤업. `discarded` 는 ID 배열이라 그것만 보면 왜 막혔는지 알 수 없다.
  // 파생값이므로 drafts 에서 계산한다 — 기록 지점이 늘면 여기가 자동으로 따라온다.
  summary.discard_summary = (summary.drafts ?? [])
    .filter(d => d?.discard_reason)
    .map(d => ({
      draft_id: d.draft_id,
      title:    d.title,
      stage:    d.discard_reason.stage,
      blocked_by: [
        ...d.discard_reason.blocking_gates.map(g => `gate:${g.gate}`),
        ...d.discard_reason.blocking_validators.map(v => `validator:${v.validator}`),
      ],
      message: d.discard_reason.message,
    }));

  try {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    log.info(`런 요약 기록: ${summaryPath}`);
  } catch (err) {
    log.error('런 요약 저장 실패', err);
  }
}
/**
 * STEP 3 — 작가 배정 → 초안 생성 → 파일 기록(병렬).
 *
 * 예산 캡에 걸리면 이미 만든 초안을 전부 폐기로 기록하고 `{ ok: false }` 를 돌려준다.
 * (부분 진행분을 남겨두면 다음 런이 그걸 발행 후보로 오해한다.)
 *
 * @param {object[]} selectedTopics
 * @param {object} summary
 * @param {string} date
 * @returns {Promise<{ok:boolean, draftPairs?:object[]}>}
 */
async function buildDrafts(selectedTopics, summary, date) {
  log.info('STEP 3: 작가 배정 + 초안 생성 (병렬)');

  const draftPairs = await Promise.all(
    selectedTopics.map(async (topic, i) => {
      const writer    = assignWriter(i);
      const outline   = makeOutline(topic, writer);
      const draft     = mockDraft(topic, outline, writer);
      const draftPath = saveDraft(draft, date);
      log.info(`[${writer}] "${draft.title.slice(0, 45)}…" → ${draftPath}`);
      return { topic, draft, draftPath, writer };
    })
  );

  const chargeStep3 = charge(6000, selectedTopics.length, 'step3-drafts');
  if (chargeStep3.over_cap) {
    log.warn(`[abort] 예산 캡 도달 — step3 직후 중단 (tokens=${chargeStep3.tokens_used}/${chargeStep3.caps.tokens} calls=${chargeStep3.calls_used}/${chargeStep3.caps.calls})`);
    await notify(EVENTS.BUDGET_PREEMPT, {
      tokens_used: chargeStep3.tokens_used,
      calls_used:  chargeStep3.calls_used,
      stage: 'step3-drafts',
      partial_drafts: draftPairs.length,
    });
    appendAudit({ actor: 'lion', action: ACTIONS.BUDGET_STOP, reason: 'budget_preempt: step3-drafts' });
    summary.errors.push('budget_preempt');
    summary.status = 'budget_preempt';
    // 부분 진행된 초안들을 discarded로 기록
    for (const { draft, topic } of draftPairs) {
      summary.drafts.push({ draft_id: draft.id, title: draft.title, writer: draft.writer,
        slug: draft.slug, attempts: [], outcome: 'discarded_budget', published_file: null });
      summary.discarded.push(draft.id);
      appendTopicHistorySync(topic, 'discarded');
    }
    return;
  }
  log.info(`초안 ${draftPairs.length}개 생성 완료`);
  return { ok: true, draftPairs };
}

/**
 * STEP 7 — 런 결과 판정(발행0 여부) → 감사로그 → 알림.
 * main 에서 뽑아냈다(F-01). 여기서 정하는 `summary.status` 가 대시보드·브리핑의 기준이 된다.
 * @param {object} summary
 * @param {string} date
 */
async function announceOutcome(summary, date) {
  log.info('\nSTEP 7: 최종 감사로그 + 알림');
  const publishedCount = summary.published.length;
  const discardedCount = summary.discarded.length;

  if (publishedCount === 0) {
    log.warn(`[발행0] 모든 초안(${discardedCount}건)이 게이트/검증 실패로 폐기됨 — 발행 0건`);
    summary.status = 'zero_published';
  } else {
    summary.status = 'success';
  }

  appendAudit({
    actor:  'lion',
    action: ACTIONS.PUBLISH,
    reason: `런 완료 — 발행:${publishedCount} 폐기:${discardedCount} status:${summary.status}`,
  });

  if (publishedCount === 0) {
    // 발행0 전용 경고 알림
    await notify(EVENTS.PARTIAL, {
      details:        `[발행0] 모든 초안 폐기 — 발행:0 폐기:${discardedCount}`,
      published:      [],
      discarded:      summary.discarded,
      zero_published: true,
      date,
    });
  } else {
    await notify(EVENTS.SUCCESS, {
      details:   `발행:${publishedCount} 폐기:${discardedCount}`,
      published: summary.published,
      date,
    });
  }
}

/**
 * STEP 8~9 — 런 요약 기록 → lock 해제 → CEO 브리핑 적재.
 * `finally` 안에서 돌던 블록이다. 예외로 중단돼도 요약과 lock 해제는 반드시 일어나야 하므로
 * 호출부는 여전히 `finally` 에서 부른다 — 위치만 옮겼지 보장은 그대로다.
 * @param {object} summary
 * @param {string} date
 * @param {number} runStart
 */
async function finalizeRun(summary, date, runStart) {
  summary.finished_at = new Date().toISOString();
  summary.elapsed_ms  = Date.now() - runStart;
  saveRunSummary(date, summary);

  log.info('\nSTEP 8: lock 해제');
  releaseLock(date);

  // ─────────────────────────────────────────────────────────────────────
  // STEP 9: CEO 브리핑 생성 → Supabase hub_briefings 적재
  //   대시보드(web/) 개요·타임라인 패널이 이 레코드를 읽는다.
  //   blog_posts 적재와 동일 게이팅(isBlogDbEnabled) — mock 로컬 런이 prod 오염 안 하게. 비차단.
  // ─────────────────────────────────────────────────────────────────────
  if (isBlogDbEnabled()) {
    try {
      const briefing = await generateBriefing();
      log.info(`STEP 9: CEO 브리핑 적재 (briefing_id=${briefing?.id ?? '-'})`);
    } catch (e) {
      log.warn(`STEP 9: CEO 브리핑 적재 실패(무시): ${e.message}`);
    }
  }
}

/**
 * STEP 1 — 수집(cheetah/owl/magpie 병렬) 후 후보 주제 목록을 만든다.
 *
 * 예산 캡에 걸리면 `{ ok: false }` 를 돌려준다 — main 안에 있을 때는 `return` 한 줄로
 * 런을 끝냈지만, 함수로 뽑히면 그 신호를 값으로 넘겨야 한다(호출부가 판단한다).
 *
 * @param {object} summary 런 요약(예산 중단 시 status·errors 를 여기 기록한다)
 * @returns {Promise<{ok:boolean, allTopics?:object[]}>}
 */
async function collectCandidates(summary) {
  log.info('STEP 1: 수집 (cheetah/owl/magpie 병렬)');

  const [cheetahTopics, owlTopics, [redditPosts, hnItems]] = await Promise.all([
    Promise.resolve(mockResearch('trend')),
    Promise.resolve(mockResearch('depth')),
    // Reddit RSS + HN 순차 수집 (Reddit 간격 필요로 순차, HN은 이후)
    fetchReddit().then(async posts => {
      const hn = await fetchHN();
      return [posts, hn];
    }),
  ]);

  const magpieRedditTopics = normalizePosts(redditPosts, 10);
  const magpieHnTopics     = normalizeHnItems(hnItems, 10);
  const magpieTopics       = [...magpieRedditTopics, ...magpieHnTopics];

  const chargeStep1 = charge(3000, 3, 'step1-collect');
  if (chargeStep1.over_cap) {
    log.warn(`[abort] 예산 캡 도달 — step1 직후 중단 (tokens=${chargeStep1.tokens_used}/${chargeStep1.caps.tokens} calls=${chargeStep1.calls_used}/${chargeStep1.caps.calls})`);
    await notify(EVENTS.BUDGET_PREEMPT, {
      tokens_used: chargeStep1.tokens_used,
      calls_used:  chargeStep1.calls_used,
      stage: 'step1-collect',
    });
    appendAudit({ actor: 'lion', action: ACTIONS.BUDGET_STOP, reason: 'budget_preempt: step1-collect' });
    summary.errors.push('budget_preempt');
    summary.status = 'budget_preempt';
    return;
  }

  const magpieCount = magpieTopics.length;
  log.info(`수집 완료 — cheetah:${cheetahTopics.length} owl:${owlTopics.length} magpie:${magpieCount} (reddit:${magpieRedditTopics.length} hn:${magpieHnTopics.length})`);

  if (magpieCount === 0) {
    log.warn('magpie(Reddit+HN) 결과 없음 — cheetah/owl 결과만으로 계속');
  }

  const allTopics = [...cheetahTopics, ...owlTopics, ...magpieTopics];
  log.info(`전체 후보: ${allTopics.length}개`);
  return { ok: true, allTopics };
}

/**
 * 초안 1편의 STEP 4~6 — 게이트 → 검증자 → 발행/재시도/폐기.
 *
 * main() 에서 뽑아낸 것이다(F-01). 이 블록이 main 의 210줄과 중첩 4단계를 차지하고 있었다.
 * 초안끼리는 서로 영향이 없으므로(편별 루프) 통째로 함수 하나가 된다.
 *
 * @param {object} pair  {topic, draft, draftPath, writer}
 * @param {object} ctx   런 전체가 공유하는 것 — summary·재시도 상한·날짜
 * @param {object} ctx.summary     런 요약(여기에 결과를 push 한다)
 * @param {number} ctx.retryLimit
 * @param {string} ctx.date
 * @param {object} ctx.publishedIndex 발행 인덱스(발행 성공 시 갱신·저장)
 */
async function processDraft(pair, { summary, retryLimit, date, publishedIndex }) {
  const { topic, draft, draftPath, writer } = pair;
  log.info(`\n--- 초안: "${draft.title.slice(0, 50)}" [${writer}] ---`);


  // slug 형식은 게이트·검증자 **앞에서** 본다(2026-08-19 리뷰 F4). 발행 직전에만 검사하면
  // 같은 초안이 재시도 횟수만큼 게이트·검증자 5명을 다시 돌고 나서야 폐기된다 — LLM 호출 낭비.
  // 여기서 걸러도 다른 초안 처리에는 영향이 없다(편별 루프).
  if (draft.slug && !isSafeSlug(draft.slug)) {
    log.warn(`[skip] slug 형식 위반 — 경로 이탈 차단, 이 초안 폐기: ${String(draft.slug).slice(0, 60)}`);
    const slugSummary = { draft_id: draft.id, title: draft.title, writer,
      slug: draft.slug, attempts: [], outcome: 'discarded_slug', published_file: null };
    recordDiscardReason(slugSummary, 'slug',
      `slug 형식 위반: ${String(draft.slug).slice(0, 60)}`);
    summary.drafts.push(slugSummary);
    summary.discarded.push(draft.id);   // 기존 항목과 동일하게 draft.id 문자열로
    appendTopicHistorySync(topic, 'discarded');
    return;   // 이 초안은 여기서 끝 — 함수로 뽑히기 전엔 for 루프의 continue 였다
  }

  let attempt      = 0;
  let finalOutcome = null; // 'published' | 'discarded'

  const draftSummary = {
    draft_id:       draft.id,
    title:          draft.title,
    writer,
    slug:           draft.slug,
    attempts:       [],
    outcome:        null,
    published_file: null,
  };

  while (attempt <= retryLimit && finalOutcome === null) {
    log.info(`[attempt ${attempt}]`);

    // ── STEP 4: 결정론 게이트 (LLM 앞) ──────────────────────────────
    log.info('[step4] 게이트 실행');
    const gateResult = await runGates(draftPath);
    charge(0, 1, `step4-gate-a${attempt}`);

    log.info(`[step4] 결과: ${gateResult.all_pass ? 'PASS' : 'FAIL'}`);
    (gateResult.gates || []).forEach(g =>
      log.info(`  [${g.gate || 'unknown'}] ${g.pass ? 'PASS' : 'FAIL'} ${g.reason || ''}`)
    );

    const attemptRec = {
      attempt,
      gate_pass:   gateResult.all_pass,
      gate_gates:  gateResult.gates,
      reviews:     null,
      publishable: false,
    };

    if (!gateResult.all_pass) {
      // hard_fail → LLM 스킵, retry 또는 폐기
      log.info('[step4] FAIL → LLM 스킵 (예산 절약)');
      attemptRec.skip_reason = 'gate_fail';
      draftSummary.attempts.push(attemptRec);

      if (attempt < retryLimit) {
        appendAudit({ actor: 'lion', action: ACTIONS.RETRY,
          reason: `게이트 FAIL attempt=${attempt}`, after_hash: draft.id });
        attempt++;
        continue;
      } else {
        log.info('[폐기] 게이트 FAIL 최대재시도 초과');
        appendAudit({ actor: 'lion', action: ACTIONS.DISCARD,
          reason: '게이트 FAIL 최대재시도 초과', after_hash: draft.id });
        await notify(EVENTS.DISCARD_MAXRETRY,
          { draft_id: draft.id, title: draft.title, reason: 'gate_fail_max_retry' });
        finalOutcome = 'discarded';
        draftSummary.outcome = 'discarded';
        const gr = recordDiscardReason(draftSummary, 'gate', '게이트 FAIL 최대재시도 초과');
        log.warn(`[폐기사유] ${gr.blocking_gates.map(g => `${g.gate}(${g.reason})`).join(' / ') || '기록 없음'}`);
        appendTopicHistorySync(topic, 'discarded');
        break;
      }
    }

    // ── STEP 5: 검증자 4명 병렬 ──────────────────────────────────────
    log.info('[step5] 검증자 병렬 실행 (eagle/bee/swan/raven)');
    const reviews    = await runValidators(draft);
    charge(4000, 4, `step5-reviews-a${attempt}`);

    const all4pass    = reviews.every(r => r.verdict === 'pass');
    const publishable = gateResult.all_pass && all4pass;

    reviews.forEach(r =>
      log.info(`  [${r.validator}] ${r.verdict} — ${r.reasons?.[0] || ''}`)
    );
    log.info(`[step5] publishable=${publishable} (gate=true, all4=${all4pass})`);

    attemptRec.reviews     = reviews;
    attemptRec.publishable = publishable;
    draftSummary.attempts.push(attemptRec);

    // ── STEP 6: 발행 / 재시도 / 폐기 ────────────────────────────────
    if (publishable) {
      log.info('[step6] 발행');
      // STEP 5.5: 이미지 디자이너 듀얼 (비차단 — 실패해도 발행 진행)
      let imageMeta = null;
      try {
        imageMeta = await runImageStage(draft, topic);
      } catch (e) {
        log.warn(`[step5.5] 이미지 단계 실패(무시): ${e.message}`);
      }
      try {
        const pubResult = await publishDraft(draft, gateResult, date, imageMeta);

        // verify (mock: 즉시 ok)
        const deployResult = await waitDeploy(null, { slug: draft.slug });
        log.info(`[step6] verify: ok=${deployResult.ok} skipped=${deployResult.skipped}`);

        // 인덱스 갱신
        addToPublishedIndex(publishedIndex, topic, draft, pubResult);
        savePublishedIndex(publishedIndex);

        appendAudit({
          actor:      'lion',
          action:     ACTIONS.PUBLISH,
          after_hash: pubResult.git_sha || sha256hex(draft.id).slice(0, 16),
          reason:     `발행 성공: ${pubResult.filename}`,
        });
        await notify(EVENTS.SUCCESS, {
          url:     pubResult.filepath,
          sha:     pubResult.git_sha,
          status:  200,
          details: draft.title,
        });

        // 발행 성공 — 비당선 후보 자산 정리(승자만 사이트로). 실패해도 발행엔 무영향.
        if (imageMeta && Array.isArray(imageMeta.asset_paths)) {
          for (const ap of imageMeta.asset_paths) {
            if (ap && ap !== imageMeta.winner_path) {
              try { if (existsSync(ap)) unlinkSync(ap); } catch { /* 무시 */ }
            }
          }
        }

        // 홈페이지 DB(blog_posts) 적재 — 비차단(이미지 단계와 동일). 실패해도 파일 발행 불변.
        let dbResult = null;
        try {
          dbResult = await publishFileToDb(pubResult.filepath);
          log.info(`[step6] blog_posts 적재: ok=${dbResult.ok} mode=${dbResult.mode || '-'} slug=${dbResult.slug || '-'}`);
        } catch (e) {
          log.warn(`[step6] blog_posts 적재 실패(무시): ${e.message}`);
        }

        finalOutcome = 'published';
        draftSummary.outcome       = 'published';
        draftSummary.published_file = pubResult.filepath;
        draftSummary.image         = imageMeta ? imageMeta.run_record : null;
        draftSummary.db_published  = dbResult ? { ok: dbResult.ok, slug: dbResult.slug } : null;
        appendTopicHistorySync(topic, 'published');
        summary.published.push(pubResult.filename);

      } catch (err) {
        log.error(`[step6] 발행 오류: ${err.message}`);
        summary.errors.push(`publish_error: ${err.message}`);
        // 고아 자산 정리: 발행 실패 시 이미지 단계가 기록한 후보 파일 삭제
        if (imageMeta && Array.isArray(imageMeta.asset_paths)) {
          for (const ap of imageMeta.asset_paths) {
            try { if (ap && existsSync(ap)) unlinkSync(ap); } catch { /* 무시 */ }
          }
        }
        if (attempt < retryLimit) {
          attempt++;
          appendAudit({ actor: 'lion', action: ACTIONS.RETRY,
            reason: `발행 오류 attempt=${attempt - 1}` });
          continue;
        } else {
          finalOutcome = 'discarded';
          draftSummary.outcome = 'discarded';
          recordDiscardReason(draftSummary, 'publish', `발행 오류 최대재시도: ${err.message}`);
          appendAudit({ actor: 'lion', action: ACTIONS.DISCARD,
            reason: `발행 오류 최대재시도: ${err.message}` });
          await notify(EVENTS.PUBLISH_FAIL,
            { reason: err.message, draft_id: draft.id });
        }
      }

    } else {
      // 검증 미통과
      if (attempt < retryLimit) {
        log.info(`[step6] 검증 미통과 → retry ${attempt + 1}/${retryLimit}`);
        appendAudit({ actor: 'lion', action: ACTIONS.RETRY,
          reason: `검증 미통과 attempt=${attempt}` });
        attempt++;
        continue;
      } else {
        log.info('[step6] 검증 미통과 최대재시도 초과 → 폐기');
        appendAudit({ actor: 'lion', action: ACTIONS.DISCARD,
          reason: '검증 미통과 최대재시도 초과', after_hash: draft.id });
        await notify(EVENTS.DISCARD_MAXRETRY,
          { draft_id: draft.id, title: draft.title, reason: 'review_fail_max_retry' });
        finalOutcome = 'discarded';
        draftSummary.outcome = 'discarded';
        const vr = recordDiscardReason(draftSummary, 'validator', '검증 미통과 최대재시도 초과');
        log.warn(`[폐기사유] ${vr.blocking_validators.map(v => `${v.validator}(${v.reason})`).join(' / ') || '기록 없음'}`);
        appendTopicHistorySync(topic, 'discarded');
      }
    }
  } // while

  summary.drafts.push(draftSummary);
  if (draftSummary.outcome === 'discarded') {
    summary.discarded.push(draft.id);
  }
}


// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  const date     = todayStr();
  const pipeline = loadPipeline();
  const mode     = isMock() ? 'mock' : 'live';
  const runStart = Date.now();

  log.info(`=== LION 일일 런 시작 (${date}, mode=${mode}) ===`);

  // 런 디렉터리 준비
  const rDir = runDir(date);
  if (!existsSync(rDir)) mkdirSync(rDir, { recursive: true });

  // 런 요약 초기화
  const summary = {
    date,
    mode,
    status:          'running',   // running → success | zero_published | budget_preempt | aborted
    started_at:      new Date().toISOString(),
    finished_at:     null,
    elapsed_ms:      null,
    topics_selected: [],
    drafts:          [],
    published:       [],
    discarded:       [],
    errors:          [],
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 0: lock 획득 → killswitch 확인 → 예산 사전체크
  // ─────────────────────────────────────────────────────────────────────────
  log.info('STEP 0: lock 획득');
  const lockResult = acquireLock(date);
  if (!lockResult.acquired) {
    log.warn(`[abort] 이미 실행 중 (PID ${lockResult.pid})`);
    await notify(EVENTS.RUN_START, { reason: '중복 실행 차단', pid: lockResult.pid });
    process.exit(1);
  }
  log.info(`lock 획득: ${lockResult.lockPath}`);

  // lock을 항상 해제하기 위해 try/finally
  try {
    log.info('STEP 0: killswitch 확인');
    const killStatus = await isKilled();
    if (killStatus.active) {
      log.warn(`[abort] killswitch 활성 — ${killStatus.reason}`);
      await notify(EVENTS.KILL_ACTIVE, { reason: killStatus.reason, source: killStatus.source });
      appendAudit({ actor: 'lion', action: ACTIONS.KILL, reason: killStatus.reason });
      summary.errors.push('killswitch_active');
      summary.status = 'aborted';
      return;
    }
    log.info('killswitch 비활성 — 계속');

    log.info('STEP 0: 예산 사전체크');
    const budgetCheck = checkBudget();
    if (!budgetCheck.ok) {
      log.warn(`[abort] 예산 초과 — tokens=${budgetCheck.tokens_used}/${budgetCheck.caps.tokens}`);
      await notify(EVENTS.BUDGET_PREEMPT, {
        tokens_used: budgetCheck.tokens_used,
        calls_used:  budgetCheck.calls_used,
      });
      appendAudit({ actor: 'lion', action: ACTIONS.BUDGET_STOP, reason: '예산 사전체크 실패' });
      summary.errors.push('budget_preempt');
      summary.status = 'budget_preempt';
      return;
    }
    log.info(`예산 OK — tokens=${budgetCheck.tokens_used}/${budgetCheck.caps.tokens} calls=${budgetCheck.calls_used}/${budgetCheck.caps.calls}`);

    await notify(EVENTS.RUN_START, { date, mode });

    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: 수집 — cheetah/owl/magpie 병렬
    // ─────────────────────────────────────────────────────────────────────
    const collected = await collectCandidates(summary);
    if (!collected.ok) return;
    const allTopics = collected.allTopics;

    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: 주제 3 선정 (dedup_key 중복 회피 + seed backfill)
    // ─────────────────────────────────────────────────────────────────────
    log.info('STEP 2: 주제 선정 (중복 제거)');
    const publishedIndex = loadPublishedIndex();
    const publishedKeys  = new Set(Object.keys(publishedIndex));

    const freshTopics = allTopics.filter(t => !publishedKeys.has(t.dedup_key));
    log.info(`중복 제거 후: ${freshTopics.length}/${allTopics.length}개`);

    const targetCount = pipeline.drafts_per_day || 3;

    // 가중 스코어링 — topic_targeting.niche_keywords 매칭 점수로 stable sort
    const nicheKeywords = pipeline.topic_targeting?.niche_keywords ?? [];
    const scoredFresh = freshTopics.map((t, i) => ({
      topic: t,
      score: scoreTopicNiche(t, nicheKeywords),
      idx: i,  // 원래 인덱스 보존 → 동점 시 수집 가중 순위 유지
    }));
    if (nicheKeywords.length > 0) {
      scoredFresh.sort((a, b) => b.score - a.score || a.idx - b.idx);
      log.info('니치 스코어링 적용 (상위 후보):');
      scoredFresh.slice(0, Math.min(targetCount + 3, scoredFresh.length)).forEach(
        ({ topic: t, score }) => log.info(`  niche_score=${score} "${t.title}"`)
      );
    }
    let selectedTopics = scoredFresh.slice(0, targetCount).map(s => s.topic);

    if (selectedTopics.length < targetCount) {
      log.info(`후보 부족 (${selectedTopics.length}개) — seed-topics.md 백필`);
      const seedTopics = loadSeedTopics();
      const usedKeys   = new Set(selectedTopics.map(t => t.dedup_key));
      const freshSeeds = seedTopics.filter(
        t => !publishedKeys.has(t.dedup_key) && !usedKeys.has(t.dedup_key)
      );
      const needed = targetCount - selectedTopics.length;
      selectedTopics = [...selectedTopics, ...freshSeeds.slice(0, needed)];
      log.info(`백필 후: ${selectedTopics.length}개`);
    }

    if (selectedTopics.length === 0) {
      log.warn('[abort] 선정 가능한 주제 없음 — 모든 후보가 이미 발행됨');
      summary.errors.push('no_topics');
      summary.status = 'zero_published';
      await notify(EVENTS.PARTIAL, {
        details:        '[발행0] 선정 주제 없음 — 모든 후보 이미 발행됨',
        zero_published: true,
        date,
      });
      return;
    }

    summary.topics_selected = selectedTopics.map(t => ({
      id: t.id, title: t.title, dedup_key: t.dedup_key,
    }));
    log.info(`선정 주제 ${selectedTopics.length}개:`);
    selectedTopics.forEach((t, i) => log.info(`  [${i + 1}] ${t.title}`));

    selectedTopics.forEach(t => appendTopicHistorySync(t, 'selected'));

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: 작가 배정 + 초안 생성 + 파일 기록 (병렬)
    // ─────────────────────────────────────────────────────────────────────
    const drafted = await buildDrafts(selectedTopics, summary, date);
    if (!drafted.ok) return;
    const draftPairs = drafted.draftPairs;

    // ─────────────────────────────────────────────────────────────────────
    // STEP 4→5→6: 각 초안 게이트 → 검증 → 발행/재시도/폐기
    // ─────────────────────────────────────────────────────────────────────
    log.info('STEP 4~6: 게이트 → 검증 → 발행 루프');
    const retryLimit = pipeline.retry_limit ?? 2;

    for (const pair of draftPairs) {
      await processDraft(pair, { summary, retryLimit, date, publishedIndex });
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 7: 최종 감사로그 + 알림
    // ─────────────────────────────────────────────────────────────────────
    await announceOutcome(summary, date);

  } finally {
    // ─────────────────────────────────────────────────────────────────────
    // STEP 8: 런 요약 기록 + lock 해제
    // ─────────────────────────────────────────────────────────────────────
    await finalizeRun(summary, date, runStart);

    const pub = summary.published.length;
    const dis = summary.discarded.length;
    log.info(`=== LION 런 완료 (${summary.elapsed_ms}ms) — 발행:${pub} 폐기:${dis} 오류:${summary.errors.length} ===`);
  }
}

main().catch(err => {
  console.error('[lion] 치명적 오류:', err.message);
  process.exit(1);
});
