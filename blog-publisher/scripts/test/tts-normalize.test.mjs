#!/usr/bin/env node
/**
 * tts-normalize.test.mjs — normalizeForTTS 결정론 발음 정규화 유닛테스트
 *
 * 검증: 약어 사전/폴백·기호·숫자단위 치환, 한글 불변, 빈/비문자열 안전.
 * 순수 함수 테스트라 크리덴셜·RUN_MODE 불필요. exit 0 = 전체 통과 / 1 = 실패.
 */
import { normalizeForTTS } from '../shorts/tts/normalize.mjs';

let passN = 0, failN = 0;
const eq = (label, got, want) => {
  if (got === want) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); failN++; }
};

// 사전 약어
eq('FDA 승인', normalizeForTTS('FDA 승인'), '에프디에이 승인');
eq('AI 사전', normalizeForTTS('AI 시대'), '에이아이 시대');
// 미등록 약어 → letter-by-letter
eq('XYZ 폴백', normalizeForTTS('XYZ'), '엑스와이제트');
// 기호
eq('50%', normalizeForTTS('50%'), '50퍼센트');
eq('$50', normalizeForTTS('$50'), '50달러');
eq('30℃', normalizeForTTS('30℃'), '30도');
// 숫자 단위
eq('8km', normalizeForTTS('8km'), '8킬로미터');
eq('5kg', normalizeForTTS('5kg'), '5킬로그램');
eq('공백 단위 3 cm', normalizeForTTS('3 cm'), '3센티미터');
// 한글만 → 불변
eq('한글 불변', normalizeForTTS('오늘도 좋은 하루입니다.'), '오늘도 좋은 하루입니다.');
// 소문자 라틴 단어 미변형(오탐 방지)
eq('소문자 라틴 불변', normalizeForTTS('테플론 teflon 코팅'), '테플론 teflon 코팅');
// 단일 대문자 미변형(2자 미만)
eq('단일 대문자 불변', normalizeForTTS('비타민 C 좋다'), '비타민 C 좋다');
// 빈/비문자열 안전
eq('빈 문자열', normalizeForTTS(''), '');
eq('null 안전', normalizeForTTS(null), null);
eq('undefined 안전', normalizeForTTS(undefined), undefined);
eq('숫자 입력 안전', normalizeForTTS(42), 42);
// 복합
eq('복합 문장', normalizeForTTS('NASA 는 FDA 승인 후 8km 를 50% 단축했다'),
  '나사 는 에프디에이 승인 후 8킬로미터 를 50퍼센트 단축했다');

console.log(`\nTTS normalize 유닛: ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
