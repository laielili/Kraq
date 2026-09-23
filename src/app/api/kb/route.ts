import { NextRequest, NextResponse } from 'next/server';
import { addDoc, deleteDoc, listDocs } from '@/lib/kb/store';

export async function GET() {
  const docs = await listDocs();
  return NextResponse.json({ docs });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { title?: string; content?: string };
  const title = (body.title ?? '').trim();
  const content = (body.content ?? '').trim();
  if (!title || !content) {
    return NextResponse.json({ error: 'title 与 content 均不能为空' }, { status: 400 });
  }
  const doc = await addDoc(title, content);
  return NextResponse.json({ doc });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id');
  if (!id) {
    return NextResponse.json({ error: '缺少 id 参数' }, { status: 400 });
  }
  const removed = await deleteDoc(id);
  if (!removed) {
    return NextResponse.json({ error: '文档不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
