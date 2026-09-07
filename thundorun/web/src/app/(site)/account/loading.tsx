/**
 * /account 로딩 골격. 이 세그먼트 아래에는 notFound() 를 부르는 라우트가 없어서
 * Suspense 경계를 둬도 응답 상태가 200 으로 굳지 않는다(SiteLoading 주석 참고).
 */
export { default } from '@/components/state/SiteLoading';
