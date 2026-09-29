import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // outputFileTracingRoot: path.resolve(__dirname, '../../'),  // Uncomment and add 'import path from "path"' if needed
  /* config options here */
  serverExternalPackages: ['coze-coding-dev-sdk'],
  allowedDevOrigins: ['*.dev.coze.site'],
  // 关闭 dev 模式右下角的开发者工具悬浮球：它 fixed 压在三栏底边之上，
  // 视觉上像页面超高，且遮挡左栏底部输入区（用户要求移除）。
  devIndicators: false,
  // API 转发由 src/app/api/[...path]/route.ts 流式透传到 :8000——
  // 不用 rewrites：rewrites 会缓冲 SSE，实测 /api/ask 卡在 generate 阶段。
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
};

export default nextConfig;
