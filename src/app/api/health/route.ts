import { NextResponse } from 'next/server';
import { getKb } from '@/lib/kb/store';

export async function GET() {
  const docs = await getKb();
  return NextResponse.json({ ok: true, docs: docs.length });
}
