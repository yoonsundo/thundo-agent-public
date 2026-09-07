import Link from 'next/link';
import { getProfile } from '@/server/siteProfile';

/**
 * /editorial-policy — 편집 정책 · AI 사용 고지 · 정정 절차.
 *
 * 왜 만드나 (2026-09-07): 8월 구글 스팸 업데이트 이후 검색 노출이 절벽처럼 끊겼다
 * (7월 하루 15.6회 → 8/17 이후 22일간 7회). 업데이트가 표적으로 삼은 것은 "AI 로 만들었다"가
 * 아니라 **"의미 있는 사람 검토와 부가가치 없이 대량 생산된 것"** 이다. 이 사이트는 이미
 * "에이전트 45마리가 운영한다"를 공개 브랜드로 쓰고 있으므로 숨길 이유가 없다 — 무엇을
 * 기계가 하고 어디서 사람이 막는지를 밝히는 편이 정직하고, 차별점이기도 하다.
 *
 * 🔴 여기 적힌 숫자·절차는 **지금 실제로 돌아가는 것만** 적는다. 정책 페이지에 적힌 약속과
 *    파이프라인이 어긋나면 그 자체가 신뢰를 깎는다. 바꿀 때는 코드·설정을 먼저 확인한다:
 *      - 게이트 17종  : blog-publisher `scripts/gates/run-all-gates.mjs`
 *                       (check-build·check-deploy 는 발행물 품질 게이트가 아니라 배포 점검이다)
 *      - 검증자 4명   : blog-publisher `config/pipeline.json` 의 `validators`
 *      - 사람 승인    : `src/lib/blog-status.ts` (공개 경계 = status 'published')
 *      - 주 3편       : blog-publisher 런북 STEP 0 의 요일 판정
 *
 * ISR 1시간 — 프로필(정정 창구)만 DB 에서 읽고 나머지는 정적이라 요청별로 다시 그릴 이유가 없다.
 */
export const revalidate = 3600;

export const metadata = {
  title: '편집 정책 — Thundo',
  description:
    'Thundo 블로그의 편집 정책 — 누가 무엇을 검수하는지, AI 를 어디에 쓰는지, 잘못된 내용을 어떻게 고치는지.',
  alternates: { canonical: '/editorial-policy' },
};

export default async function EditorialPolicyPage() {
  const profile = await getProfile();
  // 정정 창구는 프로필의 공개 연락 링크를 그대로 쓴다 — 여기에 주소를 따로 적어 두면
  // 프로필만 고쳤을 때 둘이 어긋나 "보냈는데 답이 없는 창구"가 남는다.
  const mail = profile.socials.find((s) => s.icon === 'mail') ?? null;

  return (
    <div className="container-narrow">
      <div className="page-head">
        <div>
          <h1 className="page-title">편집 정책</h1>
          <p className="page-sub">누가 무엇을 검수하는가 · AI 사용 고지 · 정정 절차</p>
        </div>
      </div>

      <div className="stack-6">
        <article className="article">
          <p>
            이 블로그의 글은 <strong>AI 에이전트가 초안을 쓰고, 자동 검사와 검증 에이전트를
            통과한 것만 사람이 검수해 공개</strong>합니다. 아래는 그 절차를 있는 그대로 적은
            것입니다. 지키지 못할 약속은 적지 않았습니다.
          </p>

          <h2>1. 누가 무엇을 검수하는가</h2>
          <p>글 한 편은 공개되기까지 세 개의 관문을 지납니다.</p>
          <ul>
            <li>
              <strong>자동 검사 17종</strong> — 사람도 AI 도 아닌 결정론적 프로그램이 봅니다.
              길이, 중복(다른 글과·글 안에서), 금지 표현, 마크다운 형식, 링크 생존,
              빈 절, 기계 번역 티, 출처 누락, 근거 없는 단정, 정보 밀도, 얼버무림,
              주제 이탈, 렌더 형태, 기본 SEO 요소, 원문 사실 대조, 그리고
              <strong> 겪지 않은 1인칭 경험 서술</strong>을 차단합니다. 하나라도 걸리면 발행되지
              않습니다.
            </li>
            <li>
              <strong>검증 에이전트 4명</strong> — 사실 검증, SEO, 편집(가독성·문장), 표절·독창성을
              각각 맡습니다. 이들에게는 <em>차단 권한만</em> 있습니다. 글을 고쳐 쓰지 못하고,
              막을 수만 있습니다. 고치는 쪽과 판정하는 쪽을 분리해 자기 글을 자기가 통과시키는
              일이 생기지 않게 했습니다.
            </li>
            <li>
              <strong>사람 승인</strong> — 위를 전부 통과한 글도 곧바로 공개되지 않습니다.
              관리자가 읽고 승인해야 사이트에 나타납니다. 승인하면 누가·언제 승인했는지가
              기록되고, 그 기록이 글 상단의 “검수: 이름 · 날짜”와 구조화 데이터
              (<code>reviewedBy</code>)로 그대로 나갑니다.
            </li>
          </ul>
          <p>
            <strong>2026년 9월 7일 이전에 발행된 글에는 검수자 표시가 없습니다.</strong> 그때까지는
            사람 승인 관문 자체가 없어 실제로 검수한 사람이 없기 때문입니다. 기록을 소급해서
            채우지 않았습니다 — 없는 사실을 지어내는 것보다 비어 있는 편이 정확합니다.
          </p>

          <h2>2. AI 사용 고지</h2>
          <ul>
            <li>
              <strong>초안은 AI 가 씁니다.</strong> 주제 수집, 자료 조사, 초안 작성, 이미지 생성까지
              에이전트가 합니다. 숨기지 않습니다 — 이 사이트는 그 파이프라인 자체를 공개
              주제로 다룹니다(<Link href="/agents">에이전트</Link> ·{' '}
              <Link href="/reports">에이전트 일지</Link>).
            </li>
            <li>
              <strong>발행 여부는 사람이 정합니다.</strong> 승인 없이 공개되는 글은 없습니다.
            </li>
            <li>
              <strong>겪은 척하지 않습니다.</strong> “직접 6개월 써 보니” 같은 1인칭 경험 서술은
              자동 검사가 막습니다. 실측한 수치는 어떻게 쟀는지 함께 적습니다.
            </li>
            <li>
              <strong>가상 저자·자작 리뷰·대가성 추천을 쓰지 않습니다.</strong> 글쓴이 표기는
              사이트 운영자 한 사람이고, 없는 인물을 만들지 않습니다.
            </li>
          </ul>

          <h2>3. 발행 주기</h2>
          <p>
            <strong>주 3편(월·수·금)</strong> 입니다. 2026년 9월 이전에는 하루 3편이었고, 그 속도로는
            사람이 읽고 승인할 수 없어서 줄였습니다. 검수할 수 있는 만큼만 냅니다.
          </p>

          <h2>4. 정정 절차</h2>
          <p>
            사실이 틀렸거나, 오래되어 지금은 맞지 않거나, 출처가 잘못 붙은 글을 발견하면 알려
            주세요. 글 주소와 어느 대목인지만 적어 주시면 됩니다.
          </p>
          <ul>
            <li>
              <strong>접수</strong> —{' '}
              {mail
                ? <a href={mail.href}>{mail.label}</a>
                : <Link href="/">홈의 연락 링크</Link>}
              로 보내 주세요.
            </li>
            <li><strong>확인</strong> — 원문·출처를 다시 대조합니다.</li>
            <li>
              <strong>처리</strong> — 고칠 수 있으면 고치고, 근거가 무너진 글은 공개를 내립니다.
              고친 글은 사람이 다시 승인하므로 검수자와 검수일이 갱신됩니다.
            </li>
          </ul>
          <p>
            지적이 맞는지 판단이 서지 않을 때는 고치지 않고 그대로 두는 대신, 무엇이 불확실한지
            본문에 적습니다. 확인되지 않은 정정으로 다른 오류를 만드는 편이 더 나쁩니다.
          </p>
        </article>

        <aside className="card card-outline">
          <span className="card-kicker">이 문서에 대해</span>
          <p className="card-body">
            여기 적힌 절차는 실제로 돌아가는 코드와 설정에서 옮겨 온 것입니다. 파이프라인이
            바뀌면 이 문서도 함께 바뀝니다. <Link href="/blog">블로그 목록</Link>
          </p>
        </aside>
      </div>
    </div>
  );
}
