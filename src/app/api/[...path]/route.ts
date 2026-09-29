// 开发拓扑：页面/HMR 直连 Next(:3000)，API 由本 catch-all 以流式方式
// 透传给 Python 后端(:8000)。SSE（/api/ask）必须流式转发——Next 的
// rewrites 会缓冲响应体，实测会卡死流式问答，故不用 rewrites。
import type { NextRequest } from 'next/server';

const TARGET = 'http://127.0.0.1:8000';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

async function proxy(req: NextRequest) {
  const upstreamUrl = `${TARGET}${req.nextUrl.pathname}${req.nextUrl.search}`;
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'host') {
      headers.set(key, value);
    }
  });

  const method = req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await req.arrayBuffer() : undefined;

  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    // undici 会自动解压并去掉 content-encoding，此处跟随上游即可
    redirect: 'manual',
  });

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'content-encoding' || lower === 'content-length') {
      return;
    }
    respHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const PATCH = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
