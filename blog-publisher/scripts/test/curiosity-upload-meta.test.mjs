#!/usr/bin/env node
/**
 * curiosity-upload-meta.test.mjs — 호기심채널 업로드 메타(US-004) 유닛테스트
 *
 * 검증: 제목 40자 컷(훅 살린 축약)·설명 내 thundo.kr 역링크·구독 CTA·훅,
 *      주제 고유 태그 8개 이상, whatif 앵글에 '설마진짜' 오라벨 없음(회귀 가드).
 * 순수 함수 테스트 — 크리덴셜/네트워크/업로드 불필요. exit 0 = 전체 통과 / 1 = 실패.
 */
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';

const { buildUploadMeta, buildProducedUploadMeta, producedMetaRecoveryGaps, shortenTitleBody, extractKeywords, buildTags, siteBaseUrl, nounStem, topicHashtags } =
  await import('../shorts-curiosity/run-curiosity.mjs');

// ⚠ 환경 독립성: 이 레포 .env 에는 CURIOSITY_SITE_BASE_URL(캐노니컬)과 SITE_BASE_URL(배포
//   폴링용 vercel 주소)이 둘 다 있고, config.mjs 가 이를 process.env 로 주입한다. 게다가
//   `node --env-file=.env` 로 돌리면 실행 전에 이미 주입돼 있다. 따라서 링크 관련 케이스는
//   앰비언트를 걷어낸 상태에서 시작하고, env 를 쓰는 케이스는 withEnv 로 자기 값을 설정·복원해
//   케이스 간 누수를 없앤다 → --env-file 유무와 무관하게 같은 결과.
const LINK_ENV_KEYS = ['CURIOSITY_SITE_BASE_URL', 'SITE_BASE_URL'];
for (const k of LINK_ENV_KEYS) delete process.env[k];

/** 지정 env 만 세팅해 fn 실행 후 원래 상태로 복원(케이스 간 env 누수 방지). */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of LINK_ENV_KEYS) saved[k] = process.env[k];
  for (const k of LINK_ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  try { return fn(); }
  finally {
    for (const k of LINK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

let passN = 0, failN = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`  [PASS] ${label}`); passN++; }
  else { console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); failN++; }
};
const eq = (label, got, want) => ok(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

const SHORTS = ' #shorts';
const bodyOf = (title) => title.replace(/\s*#shorts\s*$/, '');

// 실제 07-28 업로드분(46자) — 피드에서 절삭돼 CTR 을 깎던 사례.
const INSECT = '만약 지구에서 곤충이 내일 전부 사라진다면, 인류를 먼저 덮치는 재앙은 굶주림일까?';
const insectItem = {
  id: 'w-insect', angle: 'whatif', domain: '과학', subject: INSECT,
  reveal: '곤충이 사라지면 굶주림보다 수분(受粉) 붕괴로 인한 생태계 연쇄 붕괴가 먼저 닥친다',
};
const revealItem = {
  id: 'r-blank', angle: 'reveal', domain: '역사', subject: '총알 없는 총으로 자기 머리를 쐈던 배우',
  reveal: '공포탄도 화약 가스와 파편이 총구에서 그대로 나가 근접 사격은 치명적이다',
};
const script = { hook: '곤충이 전부 사라진 다음 날, 가장 먼저 무너지는 건 밥상이 아닙니다.' };

// ── 1. 제목 길이·형식 ────────────────────────────────────────────────────────
console.log('\n[1] 제목 40자 컷');
const insectMeta = buildUploadMeta(insectItem, script);
ok('#shorts 포함', insectMeta.title.endsWith(SHORTS), insectMeta.title);
ok(`본문 40자 이내 (${bodyOf(insectMeta.title).length}자)`, bodyOf(insectMeta.title).length <= 40, insectMeta.title);
ok('전체 100자 이내(YouTube 한도)', insectMeta.title.length <= 100);
console.log(`        → ${insectMeta.title}`);

console.log('\n[2] 긴 가정형 축약 — 짧아지고 의미 유지');
const insectBody = shortenTitleBody(INSECT);
ok('원문보다 짧아짐', insectBody.length < INSECT.length, `${INSECT.length} → ${insectBody.length}`);
for (const core of ['곤충', '사라진다면', '재앙', '굶주림']) {
  ok(`핵심어 '${core}' 유지`, insectBody.includes(core), insectBody);
}
ok('결과절 물음표 유지', /\?$/.test(insectBody), insectBody);
ok('단순 말줄임 절삭 아님', !insectBody.includes('…'), insectBody);

// 전제가 길어도 전제를 통째로 버리지 않는다(조건절 핵심은 남긴다).
const sleep = shortenTitleBody('만약 인간이 100년 동안 한숨도 자지 않는다면, 몸에서 가장 먼저 무너지는 건 어디일까?');
ok(`장문 전제도 40자 이내 (${sleep.length}자)`, sleep.length <= 40, sleep);
ok('조건절 유지(자지 않는다면)', sleep.includes('자지 않는다면'), sleep);
ok('결과절 유지', sleep.includes('무너지는'), sleep);

// 40자 이내 원문은 손대지 않는다(회귀 가드).
const short = '호랑이는 주황색이 아니다';
eq('40자 이내는 원문 그대로', shortenTitleBody(short), short);
eq('짧은 주제 제목', buildUploadMeta({ ...revealItem, subject: short }, script).title, `${short}${SHORTS}`);
eq('빈 주제 안전', shortenTitleBody(''), '');

// ── 3. 설명 — 훅·반전·역링크·구독 CTA ────────────────────────────────────────
// 링크 env 를 명시적으로 비운 상태에서 만든 설명으로 검증(앰비언트 .env 와 무관).
console.log('\n[3] 설명(유입 경로)');
const d = withEnv({}, () => buildUploadMeta(insectItem, script).description);
ok('훅이 맨 앞(상단 2줄 노출)', d.startsWith(script.hook), d.slice(0, 40));
ok('반전(reveal) 포함', d.includes(insectItem.reveal));
ok('기본 역링크는 캐노니컬 thundo.kr', d.includes('https://www.thundo.kr'), d);
ok('구독 CTA 포함', /구독/.test(d), d);
ok('해시태그 포함', /#/.test(d));
ok('YouTube 설명 한도(5000자) 이내', d.length <= 5000);

// env 우선순위: CURIOSITY_SITE_BASE_URL > SITE_BASE_URL > 캐노니컬 기본값.
eq('env 없으면 운영 도메인', withEnv({}, () => siteBaseUrl()), 'https://www.thundo.kr');
eq('SITE_BASE_URL env 우선(꼬리 슬래시 제거)',
  withEnv({ SITE_BASE_URL: 'https://staging.thundo.kr/' }, () => siteBaseUrl()), 'https://staging.thundo.kr');
ok('env 링크가 설명에 반영',
  withEnv({ SITE_BASE_URL: 'https://staging.thundo.kr' },
    () => buildUploadMeta(insectItem, script).description.includes('https://staging.thundo.kr')));
eq('채널 전용 env 가 SITE_BASE_URL 을 이김',
  withEnv({ SITE_BASE_URL: 'https://thundorun.vercel.app', CURIOSITY_SITE_BASE_URL: 'https://www.thundo.kr' },
    () => siteBaseUrl()), 'https://www.thundo.kr');
ok('withEnv 가 env 를 누수시키지 않음',
  process.env.SITE_BASE_URL === undefined && process.env.CURIOSITY_SITE_BASE_URL === undefined,
  `SITE_BASE_URL=${process.env.SITE_BASE_URL} CURIOSITY=${process.env.CURIOSITY_SITE_BASE_URL}`);

// ── 4. 태그 — 8개 이상 + 주제 고유 키워드 ────────────────────────────────────
console.log('\n[4] 태그');
const t = insectMeta.tags;
ok(`8개 이상 (${t.length}개)`, t.length >= 8, JSON.stringify(t));
ok('15개 이하(upload.mjs 절삭 한도)', t.length <= 15);
ok('30자 초과 태그 없음', t.every(x => x.length <= 30), JSON.stringify(t));
eq('중복 없음', new Set(t.map(x => x.toLowerCase())).size, t.length);
ok("주제 고유 키워드 '곤충' 포함", t.includes('곤충'), JSON.stringify(t));
ok('도메인 태그 포함', t.includes('과학'), JSON.stringify(t));
ok('서술어·활용형 태그 없음(명사성만)',
  !t.some(x => /(다면|일까|는다|하는|치는|지면|인한)$/.test(x)), JSON.stringify(t));
console.log(`        → ${t.join(', ')}`);

const rTags = buildUploadMeta(revealItem, script).tags;
ok(`reveal 태그도 8개 이상 (${rTags.length}개)`, rTags.length >= 8, JSON.stringify(rTags));
ok("reveal 고유 키워드 '공포탄' 포함", rTags.includes('공포탄'), JSON.stringify(rTags));
ok('기능어(만약/무슨) 태그 제외', !rTags.includes('만약') && !rTags.includes('무슨'), JSON.stringify(rTags));
ok('키워드 추출은 조사 절단', extractKeywords('머리를 쐈던 배우가').includes('머리'), JSON.stringify(extractKeywords('머리를 쐈던 배우가')));
ok('키워드 없는 주제도 8개 보충', buildTags(['지식', 'shorts'], { subject: '', reveal: '' }).length >= 8);

// ── 4-b. 태그 품질 — 조각 대신 검색되는 말 ───────────────────────────────────
// 실측(2026-07-30 12시 슬롯): "직접·그려·자기·작품임·증명한·세계적" 이 태그로 나가 15개 중
// 6개가 무용이었고, reveal 의 고유명사(마거릿 킨·명예훼손)는 하나도 못 들어갔다.
console.log('\n[4-b] 태그 품질(조각 제거·고유명사 확보)');
const KANE = {
  id: 'kane', angle: 'reveal', domain: '역사',
  subject: '법정에서 그림을 직접 그려 자기 작품임을 증명한 화가',
  reveal: "1960년대 세계적 인기를 끈 '큰 눈' 그림의 진짜 작가는 아내 마거릿 킨이었고, 남편 월터 킨이 자기 작품이라 주장하다 1986년 명예훼손 재판에서 즉석 그림 대결로 판결이 갈렸다",
};
const kaneTags = buildUploadMeta(KANE, script).tags;
console.log(`        → ${kaneTags.join(', ')}`);
for (const junk of ['직접', '그려', '자기', '작품임', '증명한', '세계적', '주장하다', '갈렸다', '그대']) {
  ok(`조각 '${junk}' 제외`, !kaneTags.includes(junk), JSON.stringify(kaneTags));
}
for (const must of ['마거릿', '킨', '1986', '명예훼손']) {
  ok(`핵심 키워드 '${must}' 확보`, kaneTags.some(t => t.includes(must)), JSON.stringify(kaneTags));
}
ok('reveal 본문에서도 키워드 추출(연도 포함)', kaneTags.some(t => t.includes('1960')), JSON.stringify(kaneTags));
ok('태그 15개 상한 유지', kaneTags.length <= 15);
eq('중복 없음', new Set(kaneTags.map(t => t.toLowerCase())).size, kaneTags.length);

// 두 어절 고유명사가 결합 형태로 보존된다.
ok("'마거릿 킨' 결합 보존", kaneTags.includes('마거릿 킨'), JSON.stringify(kaneTags));
ok("'월터 킨' 결합 보존", kaneTags.includes('월터 킨'), JSON.stringify(kaneTags));
ok('역할명사가 이름 앞에 붙지 않음(아내/남편)',
  !kaneTags.some(t => t.startsWith('아내') || t.startsWith('남편')), JSON.stringify(kaneTags));

// 어간 추출 — 조사·명사형 어미·서술격 조사 결합형이 어간만 남는다.
eq("'법정에서' → 법정", nounStem('법정에서'), '법정');
eq("'작품임을' → 작품", nounStem('작품임을'), '작품');
eq("'킨이었고' → 킨", nounStem('킨이었고'), '킨');
eq("'그림을' → 그림", nounStem('그림을'), '그림');
eq("'총으로' → 총", nounStem('총으로'), '총');
eq("'눈에는' → 눈", nounStem('눈에는'), '눈');
eq("'명예훼손' 불변", nounStem('명예훼손'), '명예훼손');
// 활용형·수식어는 키워드에서 아예 빠진다.
for (const bad of ['그려', '증명한', '갈렸다', '세계적', '직접', '자기', '쐈던', '사라진다면', '닥친다']) {
  ok(`활용형/수식어 '${bad}' 미채택`, !extractKeywords(`${bad} 테스트문장`).includes(bad));
}
// 2자 명사는 보호된다(과잉 제거 방지).
for (const good of ['판다', '목적', '오해', '피해', '파워']) {
  eq(`2자 명사 '${good}' 보존`, nounStem(good), good);
}

// 실 백로그 14건으로 잡아낸 조각 유형들 — 명사 증거 방식으로 막혔는지 고정한다.
// (금지어미 목록만으로는 한국어 활용 롱테일을 못 막아 '요동쳐 수·뒤바뀌고·제멋대'가 새어나왔다)
const REAL_JUNK = [
  ['달이 두 개였다면 밤은 어떻게 달라졌을까', ['달이', '달라졌', '개였']],           // 1자 명사+조사, 과거형
  ['지구 자전이 요동쳐 수십 년간 뒤바뀌고 제멋대로 흘렀다', ['요동쳐', '뒤바뀌고', '제멋대', '수십']],
  ['맹장이 부서졌을 때 통증이 멈출 줄을 몰랐다', ['부서졌', '멈출', '멈출 줄']],
  ['현대의료가 전제 위에서 문을 닫는 순간', ['전제 위', '문을', '닫는']],
  ['부러진 다리를 24시간짜리 수술로 지금쯤 전환할 계획', ['부러진', '시간짜리', '지금쯤', '전환할']],
  ['몸속에는 어떤 순서로 감각일 가능성이 남는다', ['몸속에', '어떤', '감각일', '어떤 순서']],
];
for (const [sentence, junks] of REAL_JUNK) {
  const kws = extractKeywords(sentence, 12);
  for (const j of junks) ok(`실측 조각 '${j}' 미채택`, !kws.includes(j), JSON.stringify(kws));
}
// 같은 문장들에서 진짜 명사는 살아남는다(과잉 차단 아님).
ok("'통증' 은 채택됨", extractKeywords('맹장이 부서졌을 때 통증이 멈출 줄을 몰랐다').includes('통증'));
ok("'몸속' 은 채택됨", extractKeywords('몸속에는 어떤 순서로 감각일 가능성이 남는다').includes('몸속'));
ok("'현대의료' 는 채택됨", extractKeywords('현대의료가 전제 위에서 문을 닫는 순간').includes('현대의료'));
ok("반복 등장하는 1자 성씨는 이름구로 보존", extractKeywords('아내 마거릿 킨이었고 남편 월터 킨이 주장했다').includes('마거릿 킨'));
ok("한 번만 나오는 1자 절단은 이름구로 안 만듦",
  !extractKeywords('절단 논의는 계속됐다').some(k => k.includes(' 논')), JSON.stringify(extractKeywords('절단 논의는 계속됐다')));

// 짧은 주제도 8개 이상이고, 보충분이 조각이 아니다.
const thinTags = buildUploadMeta({ angle: 'reveal', domain: '일상', subject: '유리는 액체다', reveal: '아니다' }, script).tags;
ok(`짧은 주제도 8개 이상 (${thinTags.length}개)`, thinTags.length >= 8, JSON.stringify(thinTags));
ok('보충분은 채널 공통 태그(조각 아님)',
  thinTags.every(t => t.length >= 2 && !/(다면|일까|한|된|려|적)$/.test(t) || ['설마진짜', '지식', '호기심', 'shorts'].includes(t)),
  JSON.stringify(thinTags));
ok('보충에도 1자 조각 없음', thinTags.every(t => t.replace(/\s/g, '').length >= 2), JSON.stringify(thinTags));

// 해시태그 — 브랜드 유지 + 주제 태그 추가(전 영상 동일 문제 해소).
console.log('\n[4-c] 해시태그(주제별 진입점)');
const kaneHash = buildUploadMeta(KANE, script).description.split('\n').pop();
console.log(`        → ${kaneHash}`);
for (const brand of ['#설마진짜', '#지식', '#호기심', '#shorts']) {
  ok(`브랜드 해시태그 '${brand}' 유지`, kaneHash.includes(brand), kaneHash);
}
ok('주제 해시태그 추가됨', /#마거릿킨|#월터킨|#명예훼손/.test(kaneHash), kaneHash);
ok('해시태그에 공백 없는 형태', topicHashtags(KANE, 2).every(h => !/\s/.test(h)), JSON.stringify(topicHashtags(KANE, 2)));
eq('주제 해시태그 개수 제한', topicHashtags(KANE, 2).length, 2);
ok('키워드 없으면 주제 해시태그 없음(억지 생성 X)', topicHashtags({ subject: '', reveal: '' }).length === 0);

// ── 5. 회귀 가드 — whatif 에 '설마진짜' 오라벨 금지 ──────────────────────────
console.log('\n[5] 회귀 가드(앵글 라벨)');
const whatifBlob = JSON.stringify(insectMeta);
ok("whatif 태그에 '설마진짜' 없음", !insectMeta.tags.includes('설마진짜'), JSON.stringify(insectMeta.tags));
ok("whatif 메타 전체에 '설마진짜' 문구 없음", !/설마\s*진짜/.test(whatifBlob), whatifBlob.slice(0, 200));
ok("whatif 해시태그는 '#만약에'", insectMeta.description.includes('#만약에'), insectMeta.description);
ok("reveal 은 기존대로 '설마진짜' 라벨 유지", rTags.includes('설마진짜'), JSON.stringify(rTags));

// ── 6. 재고 폴백도 정상 발행과 같은 메타 사용 ────────────────────────────────
console.log('\n[6] 재고 폴백 메타 일원화');
const storedMeta = buildUploadMeta(revealItem, { hook: '공포탄은 빈 총알이 아닙니다.' });
eq('신규 재고는 제작 시 저장한 메타를 그대로 재사용',
  JSON.stringify(buildProducedUploadMeta(revealItem.id, { upload_meta: storedMeta }, [], null)),
  JSON.stringify(storedMeta));

const legacyFallback = buildProducedUploadMeta(
  revealItem.id,
  { subject: revealItem.subject, angle: revealItem.angle, domain: revealItem.domain },
  [revealItem],
  { hook: '공포탄은 빈 총알이 아닙니다.' },
);
ok('기존 재고도 작업 대본 훅 포함', legacyFallback.description.startsWith('공포탄은 빈 총알이 아닙니다.'), legacyFallback.description);
ok('기존 재고도 반전 포함', legacyFallback.description.includes(revealItem.reveal), legacyFallback.description);
ok('기존 재고도 역링크 포함', legacyFallback.description.includes('https://www.thundo.kr'), legacyFallback.description);
ok('기존 재고도 구독 CTA 포함', /구독/.test(legacyFallback.description), legacyFallback.description);
ok('기존 재고도 주제 태그 8개 이상', legacyFallback.tags.length >= 8, JSON.stringify(legacyFallback.tags));
ok('기존 재고 제목도 40자 규칙 적용', bodyOf(legacyFallback.title).length <= 40, legacyFallback.title);
const legacyWhatif = buildProducedUploadMeta(insectItem.id, {
  subject: insectItem.subject, angle: 'whatif', domain: insectItem.domain,
}, [insectItem], script);
ok("기존 whatif 재고도 '#만약에' 유지", legacyWhatif.description.includes('#만약에'), legacyWhatif.description);
ok("기존 whatif 재고에 '설마진짜' 오라벨 없음", !/설마\s*진짜/.test(JSON.stringify(legacyWhatif)), JSON.stringify(legacyWhatif));

eq('백로그 reveal+script hook이 있으면 구형 재고 복원 누락 없음',
  JSON.stringify(producedMetaRecoveryGaps(revealItem.id, { subject: revealItem.subject }, [revealItem], { hook: script.hook })),
  '[]');
eq('hook만 없으면 hook 누락을 구조화해 노출',
  JSON.stringify(producedMetaRecoveryGaps(revealItem.id, { subject: revealItem.subject }, [revealItem], null)),
  '["hook"]');
eq('백로그와 대본이 모두 없으면 reveal·hook 누락을 구조화해 노출',
  JSON.stringify(producedMetaRecoveryGaps('orphan', { subject: '고아 재고' }, [], null)),
  '["reveal","hook"]');
const orphanFallback = buildProducedUploadMeta('orphan', { subject: '고아 재고' }, [], null);
ok('완전 누락 구형 재고도 링크·CTA를 보존하는 안전 메타 생성',
  orphanFallback.description.includes('https://www.thundo.kr') && /구독/.test(orphanFallback.description),
  orphanFallback.description);

console.log(`\n호기심 업로드 메타(US-004): ${passN} pass / ${failN} fail`);
process.exit(failN === 0 ? 0 : 1);
