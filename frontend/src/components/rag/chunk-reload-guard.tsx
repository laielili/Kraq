'use client';

import { useEffect } from 'react';

/**
 * Dev 兜底：dev server 重启/重编译后 chunk 内容哈希换代，长期开着的旧标签页
 * 会报 ChunkLoadError（拿旧哈希地址 import 已被裁掉的 chunk）。此时自动整页
 * 刷新一次让浏览器拿到新哈希世界。刷新本身带 sessionStorage 节流（15s 内只滚
 * 一次），避免服务器连续重启时陷入刷新循环。生产构建不会产生此错位，本组件
 * 仍保持挂载但逻辑无副作用。
 */
export function ChunkReloadGuard() {
  useEffect(() => {
    const THROTTLE_MS = 15_000;
    const KEY = 'kraq.chunkReloadAt';

    const reloadOnce = (reason: string) => {
      try {
        const last = Number(window.sessionStorage.getItem(KEY) ?? 0);
        if (Date.now() - last < THROTTLE_MS) {
          console.warn(
            `[ChunkReloadGuard] 15s 内已自动刷新过一次，跳过本次（${reason}）。` +
              '若持续出现请手动刷新并检查 dev server 状态。',
          );
          return;
        }
        window.sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        // 隐私模式等拿不到 sessionStorage 时直接刷新（无节流但不至于循环）：
        // ChunkLoadError 本身罕见，风险可接受。
      }
      console.info(`[ChunkReloadGuard] dev chunk 失效（${reason}），自动刷新页面。`);
      window.location.reload();
    };

    const onChunkError = (e: ErrorEvent) => {
      const msg = e.message ?? '';
      const fromChunk =
        (e.filename && e.filename.includes('/_next/static/chunks/')) ||
        msg.includes('ChunkLoadError') ||
        msg.includes('Failed to load chunk');
      if (fromChunk) {
        e.preventDefault?.();
        reloadOnce('ChunkLoadError');
      }
    };

    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const text =
        (reason instanceof Error && reason.message) ||
        (typeof reason === 'string' ? reason : '');
      if (
        text.includes('ChunkLoadError') ||
        text.includes('Failed to load chunk') ||
        text.includes('_next/static/chunks')
      ) {
        e.preventDefault();
        reloadOnce('unhandled chunk rejection');
      }
    };

    window.addEventListener('error', onChunkError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onChunkError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
