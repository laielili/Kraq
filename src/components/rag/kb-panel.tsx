'use client';

import { useState } from 'react';
import { FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import type { KbDocMeta } from '@/lib/rag/types';

interface KbPanelProps {
  docs: KbDocMeta[];
  onMutated: () => Promise<void>;
}

export function KbPanel({ docs, onMutated }: KbPanelProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!content.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), content: content.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? '添加失败');
      setTitle('');
      setContent('');
      await onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/kb?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? '删除失败');
      await onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="font-serif text-sm font-semibold">档案柜</h2>
          <p className="text-[11px] text-muted-foreground">
            知识库 · {docs.length} 份资料
          </p>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="space-y-1.5 p-3">
          {docs.length === 0 && (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              暂无资料，请在下方添加
            </li>
          )}
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="group flex items-start gap-2 rounded-md border bg-card px-2.5 py-2"
            >
              <FileText className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{doc.title}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="font-mono">{doc.content.length} 字</span>
                  {doc.embedded ? (
                    <Badge
                      variant="outline"
                      className="h-3.5 px-1 font-mono text-[9px]"
                    >
                      已向量化
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="h-3.5 border-accent/40 px-1 font-mono text-[9px] text-accent"
                    >
                      待向量化
                    </Badge>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove(doc.id)}
                disabled={busy}
                aria-label={`删除 ${doc.title}`}
                className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="space-y-2 border-t bg-background/60 p-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（可选）"
          className="h-8 bg-card text-xs"
        />
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="粘贴一段知识内容，作为一条资料加入档案柜…"
          className="min-h-20 resize-none bg-card text-xs"
        />
        {error && <p className="text-[11px] text-destructive">{error}</p>}
        <Button
          size="sm"
          className="w-full"
          onClick={add}
          disabled={busy || !content.trim()}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          加入档案柜
        </Button>
        <p className="text-[10px] leading-4 text-muted-foreground">
          保存后将自动调用向量化服务，供语义检索使用
        </p>
      </div>
    </div>
  );
}
