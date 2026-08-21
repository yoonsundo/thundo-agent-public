/**
 * AgentAvatar — 에이전트 아바타 (마스코트 마크 · lucide 역할 아이콘 · 모노그램 3층)
 *
 * 왜 이게 있나 (2026-08-21):
 * 아바타가 `name.slice(0, 1)` 이라 이름 첫 글자 한 자만 원에 찍혔다. 사용자 지적 그대로
 * "그냥 라, 팰, 돌" 이었고, 실제로 **6개 군 13명이 충돌**했다 —
 * 라(라이언·라이노·라쿤) · 비(비버·비) · 스(스완·스파이더) · 배(배저·배포담당) ·
 * 디(디자이너·디어) · 헤(헤론·헤지호그). 한 글자로는 구조적으로 구별되지 않는다.
 *
 * 렌더 우선순위 4층 — 부분 도입이 깨져 보이지 않게 하는 장치다.
 *   1) image_url 있음   → <img>                 (DB 로 지정한 개별 예외)
 *   2) 마스코트 초상     → public/agents/<id>.jpg (동물 34명)
 *   3) lucide 역할 아이콘 → 개발팀 9명 (동물이 아니라 초상 대상이 아니다, 자산 0장)
 *   4) 모노그램         → 그 외 (큐레이트 2글자, 충돌 없음)
 * 컨테이너(.avatar)가 같아서 네 층이 한 그리드에 섞여도 리듬이 유지된다.
 *
 * 계약: DESIGN.md §12.11(에이전트 초상은 원색 콘텐츠 사진 — 흑백 처리 금지)
 *      DESIGN.md §12.12(규칙 8 예외 — 마스코트는 아이콘이 아니라 브랜드 자산)
 * ⚠ lucide 아이콘 크기는 `size={}` 가 아니라 width/height 로 준다 — design-guard 가
 *   `size={n}` 을 16/18/20 으로 강제하고 lucide 여부를 가리지 않아서 size={56} 이면 깨진다.
 *
 * ⚠ 이모지는 쓰지 않는다. DB 에 `emoji` 필드가 있어도 렌더하지 않는다 — 규칙 8 위반인 데다
 *   시드에 중복이 4쌍이라(치타·팬서 🐆 / 팰컨·이글 🦅 / 폭스·페넥 🦊 / 맥파이·로빈 🐦)
 *   식별 문제를 풀지도 못한다. 되살리지 말 것.
 */
import {
  Target, ClipboardList, Compass, Palette, Code,
  FlaskConical, ShieldCheck, CircleCheck, Rocket,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AGENT_PORTRAITS } from './agent-portraits';

/**
 * lucide 역할 아이콘 치수(px) — 원 지름의 약 54%.
 * ⚠ `size={}` 가 아니라 width/height 로 준다(§12.12 ④) — design-guard 가 size={n} 을
 *   16/18/20 으로 강제하고 lucide 여부를 가리지 않아서 size={56} 이면 가드가 깨진다.
 * ⚠ 컨테이너 크기에 연동해야 한다. 흐름도는 `.avatar` 기본(30px)을 쓰는데 여기서 56px 을
 *   그리면 원 밖으로 넘친다.
 */
const GLYPH_BY_SIZE: Record<string, number> = { 'avatar-xl': 56, '': 16 };
const glyphFor = (sizeClass: string) => GLYPH_BY_SIZE[sizeClass] ?? 20;

/**
 * 개발팀 9인 — 동물이 아니므로 마스코트 대상이 아니다. lucide 역할 아이콘으로 끝난다(자산 0장).
 * ⚠ export 명은 lucide v1 기준이다(v0 의 CheckCircle 은 v1 에서 CircleCheck 로 개명됐다).
 */
const ROLE_ICONS: Record<string, LucideIcon> = {
  'dev-orchestrator': Target,
  'dev-planner': ClipboardList,
  'dev-architect': Compass,
  'dev-designer': Palette,
  'dev-coder': Code,
  'dev-tester': FlaskConical,
  'dev-security': ShieldCheck,
  'dev-verifier': CircleCheck,
  'dev-devops': Rocket,
};

/**
 * 모노그램 — 초상도 역할 아이콘도 없는 에이전트의 최종 폴백.
 *
 * ⚠ **알고리즘으로 만들지 않는다.** `id.slice(0, 2)` 는 개발팀 9명이 전부 "DE" 가 되고
 *   beaver/bee=BE · peacock/penguin=PE · panther/parrot=PA · raven/raccoon=RA ·
 *   heron/hedgehog=HE 로 충돌을 라틴에서 그대로 재현한다(관리자 화면이 지금 그 상태다).
 *   그래서 손으로 고른 값을 쓰고, 고유성을 단위 테스트로 고정한다.
 * ⚠ 한글이 아니라 라틴을 쓰는 이유: name 이 이미 '라이언 (Lion)' 형태라 라틴 약자가 이름과
 *   이어져 읽히고, 한 글자 한글의 근접군(팰/팬/패, 펭/페, 피/파) 문제가 원천 소멸한다.
 */
export const AGENT_MONOGRAMS: Record<string, string> = {
  lion: 'LI', falcon: 'FC', dolphin: 'DP', rhino: 'RH', panther: 'PN', cheetah: 'CH',
  owl: 'OW', magpie: 'MG', beaver: 'BV', fox: 'FX', wolf: 'WF', eagle: 'EG',
  bee: 'BE', swan: 'SW', raven: 'RV', peacock: 'PC', penguin: 'PG', elephant: 'EP',
  crane: 'CR', meerkat: 'MK', hummingbird: 'HB', parrot: 'PR', spider: 'SP', raccoon: 'RC',
  lynx: 'LX', badger: 'BD', nightingale: 'NG', fennec: 'FN', mole: 'ML', heron: 'HR',
  deer: 'DR', hedgehog: 'HH', robin: 'RB', firefly: 'FF',
  goose: 'GS', woodpecker: 'WP', sheepdog: 'SD',
  'dev-orchestrator': 'OR', 'dev-planner': 'PL', 'dev-architect': 'AR', 'dev-designer': 'DS',
  'dev-coder': 'CD', 'dev-tester': 'TS', 'dev-security': 'SC', 'dev-verifier': 'VF',
  'dev-devops': 'DO',
};

/** 맵에 없는 id 가 들어와도 화면이 비지 않게 — 최후 폴백. */
function monogram(id: string, name: string): string {
  return AGENT_MONOGRAMS[id] ?? (id ? id.slice(0, 2).toUpperCase() : name.slice(0, 1));
}

export type AgentAvatarProps = {
  id: string;
  name: string;
  imageUrl?: string | null;
  /** 컨테이너 크기 클래스. 기본은 프로필 카드용 104px. */
  sizeClass?: string;
};

export default function AgentAvatar({ id, name, imageUrl, sizeClass = 'avatar-xl' }: AgentAvatarProps) {
  const glyph = glyphFor(sizeClass);
  // ⚠ avatar-neutral 은 **모든 분기에** 붙어야 한다. .avatar 기본 배경이 --color-accent(빨강)라
  //   빠뜨리면 이미지가 늦거나 깨질 때 빨간 원이 뜬다 — 43장이 동시에 그러면 규칙 5 정면 위반이다.
  //   (이미지 분기에서 실제로 빠져 있던 결함, 2026-08-21 수정)
  const cls = ['avatar', sizeClass, 'avatar-neutral'].filter(Boolean).join(' ');

  if (imageUrl) {
    return (
      <span className={cls} style={{ overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt=""
          width={104}
          height={104}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </span>
    );
  }

  // 마스코트 초상 — 사용자 소유 자산(punchgrow 크리처)을 208px JPEG 로 두고 원을 꽉 채운다.
  // ⚠ 경로가 `/agent-portraits/` 인 이유: `public/agents/` 에 두면 **미들웨어의 로그인 게이트에
  //    잡힌다**(middleware.ts 가 `/agents/` 전체를 requireLogin 으로 보낸다). 실제로 배포 후
  //    `/agents/lion.jpg` 가 307 로 튕겼다. 게이트 규칙을 느슨하게 푸는 대신 경로를 옮겼다 —
  //    보안 경계를 정적 자산 사정으로 흔들지 않는다.
  // 배경이 구워진 래스터지만 컨테이너가 원이라 **자체 완결된 메달리온**으로 읽혀 두 테마에서
  // 모두 성립한다. §12.11 이 "에이전트 초상"을 원색 콘텐츠 사진으로 명시 허용한다.
  if (AGENT_PORTRAITS.has(id)) {
    return (
      <span className={cls} style={{ overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/agent-portraits/${id}.jpg`}
          alt=""
          width={104}
          height={104}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </span>
    );
  }

  const RoleIcon = ROLE_ICONS[id];
  if (RoleIcon) {
    return (
      <span className={cls} aria-hidden="true">
        <RoleIcon width={glyph} height={glyph} strokeWidth={1.5} />
      </span>
    );
  }

  return (
    <span className={cls} aria-hidden="true">
      {monogram(id, name)}
    </span>
  );
}
