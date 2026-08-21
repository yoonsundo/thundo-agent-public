#!/usr/bin/env node
/**
 * released-videos.mjs — 업로드 완료 영상 정리(releaseUploadedVideo) 계약 검증.
 *
 * 배경(2026-08-19 실측): 업로드는 정상인데 원본 mp4 를 아무도 지우지 않아
 * `state/shorts-queue/pending/` 에 111개·1.8GB 가 쌓였다(7월 13일부터).
 * 하루 2~3편 × 평균 16MB 라 **한 달에 약 1GB씩** 무한히 늘어난다.
 *
 * 이 검증이 지키는 것은 "지우는 것"이 아니라 **"함부로 지우지 않는 것"** 이다.
 * 삭제는 되돌릴 수 없으므로 조건이 하나라도 모자라면 파일이 살아남아야 한다.
 *
 * 실행: node scripts/test/released-videos.mjs   (exit 0=통과, 1=실패)
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseUploadedVideo } from '../shorts-curiosity/lib.mjs';
import { pendingDir } from '../shorts/lib.mjs';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  (기대 ${expected}, 실제 ${actual})`}`);
}

/** 대기 폴더 안에 임시 파일을 만들고 경로를 돌려준다. */
function makePending(name) {
  mkdirSync(pendingDir(), { recursive: true });
  const p = join(pendingDir(), name);
  writeFileSync(p, 'test');
  return p;
}

console.log('released-videos — 업로드 완료 영상 정리 계약\n');

console.log('[안 지워야 하는 경우]');
{
  const p = makePending('__t_no_id.mp4');
  check('youtube_id 없으면 반환 false', releaseUploadedVideo({ video: p, uploaded_at: 't' }), false);
  check('  파일이 남아 있다', existsSync(p), true);
  rmSync(p, { force: true });
}
{
  const p = makePending('__t_no_at.mp4');
  check('uploaded_at 없으면 반환 false', releaseUploadedVideo({ video: p, youtube_id: 'a' }), false);
  check('  파일이 남아 있다', existsSync(p), true);
  rmSync(p, { force: true });
}
check('entry 자체가 없으면 false', releaseUploadedVideo(null), false);
check('video 경로가 없으면 false', releaseUploadedVideo({ youtube_id: 'a', uploaded_at: 't' }), false);

{
  // 대기 폴더 **밖**의 파일은 절대 건드리지 않는다 — 아카이브·수동 이동본을 지우면 안 된다.
  const outside = join(tmpdir(), '__t_outside.mp4');
  writeFileSync(outside, 'test');
  check('대기 폴더 밖이면 false', releaseUploadedVideo({ video: outside, youtube_id: 'a', uploaded_at: 't' }), false);
  check('  바깥 파일이 남아 있다', existsSync(outside), true);
  rmSync(outside, { force: true });
}
{
  // 접두사만 같은 형제 디렉터리를 대기 폴더로 오인하면 안 된다(`pending` vs `pending-archive`).
  const sibling = pendingDir() + '-archive';
  mkdirSync(sibling, { recursive: true });
  const p = join(sibling, '__t_sibling.mp4');
  writeFileSync(p, 'test');
  check('형제 폴더(pending-archive)는 대상 아님', releaseUploadedVideo({ video: p, youtube_id: 'a', uploaded_at: 't' }), false);
  check('  형제 폴더 파일이 남아 있다', existsSync(p), true);
  rmSync(sibling, { recursive: true, force: true });
}

console.log('\n[지워야 하는 경우]');
{
  const p = makePending('__t_ok.mp4');
  check('조건 충족 시 반환 true', releaseUploadedVideo({ video: p, youtube_id: 'a', uploaded_at: 't' }), true);
  check('  파일이 삭제됐다', existsSync(p), false);
}
{
  // 이미 없는 파일에 대해 조용히 false — 재실행이 안전해야 한다(멱등).
  const p = join(pendingDir(), '__t_gone.mp4');
  check('이미 없는 파일이면 false (멱등)', releaseUploadedVideo({ video: p, youtube_id: 'a', uploaded_at: 't' }), false);
}

console.log(`\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
