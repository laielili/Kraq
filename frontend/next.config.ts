import type { NextConfig } from 'next';

const isStaticBuild = process.env.NODE_ENV === 'production' || process.env.CI === 'true' || process.env.BUILD_STATIC === 'true';

const nextConfig: NextConfig = {
  // 静态导出配置：输出到 frontend/dist/，供打包脚本使用（仅构建时启用，开发模式下禁用，避免与 force-dynamic 冲突）
  output: isStaticBuild ? 'export' : undefined,
  distDir: 'dist',
  // 设置 Turbopack 根目录为 frontend/，消除多 lockfile 警告
  turbopack: {
    root: __dirname,
  },
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
