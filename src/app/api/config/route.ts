import { NextRequest, NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/kb/store';
import type { RagConfig } from '@/lib/rag/types';

export async function GET() {
  const config = await getConfig();
  return NextResponse.json({ config });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json()) as Partial<RagConfig>;
  const config = await updateConfig(body);
  return NextResponse.json({ config });
}
