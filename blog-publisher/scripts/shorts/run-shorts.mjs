#!/usr/bin/env node
/**
 * shorts/run-shorts.mjs — 블로그 글 1편 → 쇼츠 파이프라인 (선별→대본→더빙→영상→게이트→큐/업로드)
 *
 * 사용:
 *   node scripts/shorts/run-shorts.mjs                 # 오늘 best-pick 자동 선별
 *   node scripts/shorts/run-shorts.mjs published/….md  # 특정 글 지정(샘플 검수용)
 *
 * v1: 업로드는 staged(config upload.enabled=false) → 게이트 통과분을 pending 큐에 적재.
 * 계약: stdout JSON 1줄 결과. exit 0=성공(queue/upload) / 1=게이트fail·업로드skip / 2=오류
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { makeLogger } from '../lib/log.mjs';
import { listPublishedSlugs } from '../lib/published-doc.mjs';
import { loadShortsConfig, loadIndex, ensureDirs, pendingDir, markQueued, markUploaded, isMainModule } from './lib.mjs';
import { pickBestCandidate } from './select.mjs';
import { generateScript } from './script.mjs';
import { produceFromScript } from './produce.mjs';
import { uploadVideo } from './upload.mjs';

const log = makeLogger('shorts/run');

export async function runOne(srcPath, { cfg } = {}) {
  cfg = cfg || loadShortsConfig();
  ensureDirs();

  // 1) 대본
  log.info(`대본 생성 중… (${basename(srcPath)})`);
  const { script } = await generateScript(srcPath, { cfg });
  const slug = script.slug;

  // 2~5) 공용 제작 코어 (AI배경→시각→더빙→조립→게이트)
  const prod = await produceFromScript(script, { cfg });
  if (!prod.ok) {
    if (prod.stage === 'gate') log.warn(`게이트 실패: ${prod.gate.checks.filter(c => !c.pass).map(c => c.name).join(',')}`);
    return { ok: false, slug, stage: prod.stage, video: prod.videoFile, gate: prod.gate, reason: prod.reason, steps: prod.steps };
  }
  log.info('게이트 통과 ✅');
  const videoFile = prod.videoFile;
  const gate = prod.gate;
  const steps = { script: { cards: script.cards.length }, ...prod.steps };

  // 6) pending 큐 적재
  mkdirSync(pendingDir(), { recursive: true });
  const queued = join(pendingDir(), `${slug}.mp4`);
  copyFileSync(videoFile, queued);
  markQueued(slug, { sourceFile: srcPath, videoFile: queued });

  // 7) 업로드 (staged — enabled 아니면 skip)
  const meta = {
    title: script.title,
    description: `${script.hook}\n\n전체 글 보기 → ${script.backlink}\n\n#쇼츠 #AI #자동화`,
    tags: ['AI', '자동화', 'Claude', '쇼츠'],
  };
  const up = await uploadVideo(queued, meta, cfg);
  steps.upload = up;
  if (up.ok) {
    markUploaded(slug, { youtubeId: up.youtubeId, youtubeUrl: up.youtubeUrl, pendingFile: `${slug}.mp4` });
    log.info(`업로드 완료: ${up.youtubeUrl}`);
    return { ok: true, slug, video: queued, youtube: up.youtubeUrl, steps };
  }
  log.info(`업로드 skip: ${up.reason} → pending 큐 보존`);
  return { ok: true, slug, video: queued, queued: true, upload_skipped: up.reason, steps };
}

async function main() {
  let cfg;
  try { cfg = loadShortsConfig(); }
  catch (e) { log.error(`설정 로드 실패: ${e.message}`); process.exit(2); }
  if (!cfg.enabled) { process.stdout.write(JSON.stringify({ ok: true, skipped: 'disabled' }) + '\n'); return; }

  // 대상 결정: 인자 지정 or best-pick 자동 선별
  let srcPath = process.argv[2] ? resolve(process.argv[2]) : null;
  if (srcPath && !existsSync(srcPath)) { log.error(`파일 없음: ${srcPath}`); process.exit(2); }
  if (!srcPath) {
    const { candidate, reason } = pickBestCandidate({ publishedList: listPublishedSlugs(), cfg, index: loadIndex() });
    if (!candidate) { log.info(`선정 없음: ${reason}`); process.stdout.write(JSON.stringify({ ok: true, candidate: null, reason }) + '\n'); return; }
    srcPath = candidate.file;
    log.info(`best-pick: ${candidate.slug} (적합도 ${candidate.score})`);
  }

  try {
    const r = await runOne(srcPath, { cfg });
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    log.error(`파이프라인 오류: ${e.message}`);
    process.stdout.write(JSON.stringify({ ok: false, reason: e.message }) + '\n');
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
