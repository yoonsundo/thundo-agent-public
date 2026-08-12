// selfheal-e2e-1783322908277 — selfheal 파이프 E2E 검증용 무해 주석 (제거해도 무방)
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        module: false,
        crypto: false,
      };
      config.resolve.alias = {
        ...config.resolve.alias,
        'onnxruntime-node': false,
        sharp: false,
      };
    }
    // onnxruntime: webpack의 new URL() 변환 비활성화 (url.replace 에러 방지)
    config.module.rules.push({
      test: /onnxruntime.*\.(mjs|js)$/,
      resolve: { fullySpecified: false },
      type: 'javascript/auto',
      parser: { url: false },
    });
    return config;
  },
  serverExternalPackages: ['@imgly/background-removal', 'onnxruntime-web', 'onnxruntime-node'],
  productionBrowserSourceMaps: false,
  output: 'standalone',
};

export default nextConfig;
