import { defineConfig } from 'vitest/config';
import path from 'node:path';

// @vitejs/plugin-react 는 쓰지 않는다(vitest 가 물고 오는 vite 버전과 peer 충돌).
// esbuild 의 automatic JSX 변환만으로 React 19 컴포넌트 테스트가 충분히 돈다.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
});
