import SajuNav from '@/components/saju/Nav';
import Providers from './providers';

export const metadata = {
  title: 'THUNDO 사주',
  description: '만세력 기반 사주 풀이 서비스',
};

export default function SajuLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <SajuNav />
      {children}
    </Providers>
  );
}
