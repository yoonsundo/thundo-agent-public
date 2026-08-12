'use client';

import { Fragment, useEffect, useState } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Loading from '@/components/state/Loading';
import Empty from '@/components/state/Empty';

// 사주 조회 레코드
interface Reading {
  id: string;
  name: string;
  birth_date: string;
  birth_time: string | null;
  gender: string | null;
  fortune_types: string[];
  result: string;
  created_at: string;
}

// 꿈해몽 조회 레코드
interface DreamReading {
  id: string;
  dream_text: string;
  mood: string | null;
  verdict: string | null;
  lucky_numbers: number[] | null;
  symbol_tags: string[] | null;
  result: string;
  created_at: string;
}

// 타로 카드 한 장
interface TarotCard {
  name: string;
  reversed?: boolean;
}

// 타로 조회 레코드
interface TarotReading {
  id: string;
  topic: string | null;
  cards: TarotCard[] | null;
  result: string;
  created_at: string;
}

type Tab = 'saju' | 'dream' | 'tarot';

/**
 * 판독 본문 — 저장된 결과는 마크다운 원문이다.
 *
 * 이전엔 <pre> 로 그대로 뿌려서 `## 원국`·`**굵게**`·`---` 이 기호째 보였다.
 * 결과 화면(`/saju/result`)과 같은 `.article` + react-markdown 조합을 그대로 쓴다
 * — 두 화면이 같은 글을 다르게 보여줄 이유가 없다.
 *
 * 표 안 전체폭 행(colSpan)에 그대로 두는 이유: 운영자는 목록을 훑다가 한 건만 펼쳐
 * 본다. 행 바로 아래에 붙어야 "어느 건의 판독인지"가 유지된다. 표 밖 패널로 빼면
 * 표 전체를 지나 스크롤해야 하고, 셀 안 `.accordion` 으로 접으면 한 열 폭(4.5rem
 * 하한)에 갇혀 오히려 더 좁아진다. 대신 폭은 `.reading-detail` 이 화면 폭으로
 * 묶는다 — 그러지 않으면 본문 길이가 그대로 표 폭이 된다(`.table` 은 auto layout).
 *
 * `<details className="accordion">` 을 덧씌우지 않는다. 이 행은 `expanded === r.id`
 * 일 때만 렌더된다 — 즉 **기본이 이미 접힌 상태**이고 열리는 행도 한 번에 하나다.
 * accordion 을 얹으면 같은 결과를 두 번 눌러야 얻는 이중 접기가 될 뿐이다.
 *
 * `.article` 이 펼친 행을 키우는 건 맞다(line-height 1.85 → 한 줄 29.6px, h2 는 위
 * 여백 32 + 아래 12 + 밑줄 여백 8 이 붙어 한 덩이 ~82px, hr 은 위아래 32px). 그래도
 * 훑는 화면이 길어지진 않는다 — 커진 건 **운영자가 직접 연 그 한 행**뿐이고 목록
 * 행 높이는 그대로다(목록 행 높이는 운 항목 셀의 줄바꿈이 정한다). 세로 상한을 걸어
 * 안쪽 스크롤로 만드는 쪽은 일부러 피했다: 펼친 목적이 그 글을 읽는 것인데 표 안에
 * 또 스크롤 영역을 만들면 터치에서 스크롤이 엉킨다.
 */
function ReadingBody({ text }: { text: string }) {
  return (
    <div className="reading-detail">
      <div className="article">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text || '결과 없음'}</ReactMarkdown>
      </div>
    </div>
  );
}

export default function AmondPage() {
  const { status } = useSession();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<Tab>('saju');

  // 사주
  const [readings, setReadings] = useState<Reading[]>([]);
  const [sajuTotal, setSajuTotal] = useState(0);
  const [sajuLoading, setSajuLoading] = useState(true);

  // 꿈해몽
  const [dreamReadings, setDreamReadings] = useState<DreamReading[]>([]);
  const [dreamTotal, setDreamTotal] = useState(0);
  const [dreamLoading, setDreamLoading] = useState(false);
  const [dreamFetched, setDreamFetched] = useState(false);

  // 타로
  const [tarotReadings, setTarotReadings] = useState<TarotReading[]>([]);
  const [tarotTotal, setTarotTotal] = useState(0);
  const [tarotLoading, setTarotLoading] = useState(false);
  const [tarotFetched, setTarotFetched] = useState(false);

  const [expanded, setExpanded] = useState<string | null>(null);

  // 인증 확인 + 사주 데이터 초기 로드
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/saju/amond/login');
      return;
    }
    if (status === 'authenticated') {
      fetch('/api/admin/readings')
        .then((r) => r.json())
        .then((data) => {
          setReadings(data.items ?? []);
          setSajuTotal(data.total ?? 0);
        })
        .finally(() => setSajuLoading(false));
    }
  }, [status, router]);

  // 꿈해몽 탭 전환 시 한 번만 fetch
  useEffect(() => {
    if (activeTab !== 'dream' || dreamFetched || status !== 'authenticated') return;
    setDreamLoading(true);
    fetch('/api/admin/dream-readings')
      .then((r) => r.json())
      .then((data) => {
        setDreamReadings(data.items ?? []);
        setDreamTotal(data.total ?? 0);
      })
      .finally(() => {
        setDreamLoading(false);
        setDreamFetched(true);
      });
  }, [activeTab, dreamFetched, status]);

  // 타로 탭 전환 시 한 번만 fetch
  useEffect(() => {
    if (activeTab !== 'tarot' || tarotFetched || status !== 'authenticated') return;
    setTarotLoading(true);
    fetch('/api/admin/tarot-readings')
      .then((r) => r.json())
      .then((data) => {
        setTarotReadings(data.items ?? []);
        setTarotTotal(data.total ?? 0);
      })
      .finally(() => {
        setTarotLoading(false);
        setTarotFetched(true);
      });
  }, [activeTab, tarotFetched, status]);

  if (status === 'loading') {
    return (
      <div className="page">
        <Loading />
      </div>
    );
  }

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setExpanded(null);
  };

  const TAB_LABEL: Record<Tab, string> = { saju: '사주', dream: '꿈해몽', tarot: '타로' };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">대시보드</h1>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => signOut({ callbackUrl: '/saju/amond/login' })}
          >
            <LogOut size={16} aria-hidden />
            로그아웃
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(['saju', 'dream', 'tarot'] as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className="tab"
            onClick={() => handleTabChange(tab)}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      {/* 사주 탭 */}
      {activeTab === 'saju' && (
        sajuLoading ? (
          <Loading />
        ) : readings.length === 0 ? (
          <Empty title="조회 이력이 없습니다" />
        ) : (
          <>
            <p className="text-muted" style={{ margin: 'var(--space-4) 0' }}>총 조회 수: {sajuTotal}건</p>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>생년월일</th>
                    <th>시간</th>
                    <th>성별</th>
                    <th>운 항목</th>
                    <th>조회일</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {readings.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td>{r.name}</td>
                        <td className="text-mono">{r.birth_date}</td>
                        <td className="text-mono">{r.birth_time ?? '-'}</td>
                        <td>{r.gender === 'male' ? '남' : r.gender === 'female' ? '여' : '-'}</td>
                        {/* 운 항목은 9개까지 이어 붙는다 — 폭 상한이 없으면 이 열의
                            max-content 가 표 폭을 밀어내 셀이 표 밖으로 넘쳐 보였다. */}
                        <td><div className="cell-wrap">{r.fortune_types.join(', ')}</div></td>
                        <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          >
                            {expanded === r.id ? '닫기' : '보기'}
                          </button>
                        </td>
                      </tr>
                      {expanded === r.id && (
                        <tr>
                          <td colSpan={7}>
                            <ReadingBody text={r.result} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {/* 꿈해몽 탭 */}
      {activeTab === 'dream' && (
        dreamLoading ? (
          <Loading />
        ) : dreamReadings.length === 0 ? (
          <Empty title="조회 이력이 없습니다" />
        ) : (
          <>
            <p className="text-muted" style={{ margin: 'var(--space-4) 0' }}>총 조회 수: {dreamTotal}건</p>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>꿈 내용</th>
                    <th>분위기</th>
                    <th>길흉</th>
                    <th>행운번호</th>
                    <th>조회일</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {dreamReadings.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td>
                          <div className="cell-wrap">
                            {r.dream_text.length > 40 ? r.dream_text.slice(0, 40) + '…' : r.dream_text}
                          </div>
                        </td>
                        <td>{r.mood ?? '-'}</td>
                        <td>{r.verdict ?? '-'}</td>
                        <td>{r.lucky_numbers ? r.lucky_numbers.join(', ') : '-'}</td>
                        <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          >
                            {expanded === r.id ? '닫기' : '보기'}
                          </button>
                        </td>
                      </tr>
                      {expanded === r.id && (
                        <tr>
                          <td colSpan={6}>
                            <ReadingBody text={r.result} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {/* 타로 탭 */}
      {activeTab === 'tarot' && (
        tarotLoading ? (
          <Loading />
        ) : tarotReadings.length === 0 ? (
          <Empty title="조회 이력이 없습니다" />
        ) : (
          <>
            <p className="text-muted" style={{ margin: 'var(--space-4) 0' }}>총 조회 수: {tarotTotal}건</p>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>주제</th>
                    <th>카드</th>
                    <th>조회일</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tarotReadings.map((r) => (
                    <Fragment key={r.id}>
                      <tr>
                        <td>{r.topic ?? '-'}</td>
                        <td>
                          <div className="cell-wrap">
                            {r.cards
                              ? r.cards.map((c) => `${c.name}${c.reversed ? '(역)' : ''}`).join(' / ')
                              : '-'}
                          </div>
                        </td>
                        <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                          >
                            {expanded === r.id ? '닫기' : '보기'}
                          </button>
                        </td>
                      </tr>
                      {expanded === r.id && (
                        <tr>
                          <td colSpan={4}>
                            <ReadingBody text={r.result} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </div>
  );
}
