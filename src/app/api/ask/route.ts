import { NextRequest } from 'next/server';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import { runAsk } from '@/lib/rag/pipeline';
import type { AskEvent, RagConfigPatch } from '@/lib/rag/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { question?: string; config?: RagConfigPatch };
  const question = (body.question ?? '').trim();
  if (!question) {
    return Response.json({ error: 'question 不能为空' }, { status: 400 });
  }
  const customHeaders = HeaderUtils.extractForwardHeaders(request.headers);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AskEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        for await (const event of runAsk(question, body.config ?? {}, customHeaders)) {
          send(event);
        }
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
