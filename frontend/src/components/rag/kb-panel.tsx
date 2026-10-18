'use client';

import { useRef, useState } from 'react';
import { ArrowDownToLine, FileText, FolderOpen, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import type { KbDocMeta } from '@/lib/rag/types';

interface KbPanelProps {
  docs: KbDocMeta[];
  /** 当前知识库 id，所有档案接口均带上 */
  currentKbId: string;
  onMutated: () => Promise<void>;
  /** 进行中的转存任务数：决定 [队列] 按钮是否出现（任务状态由 page.tsx 单例持有） */
  clipActive: number;
  onSubmitClip: (url: string) => void;
  onOpenQueue: () => void;
}

export function KbPanel({
  docs,
  currentKbId,
  onMutated,
  clipActive,
  onSubmitClip,
  onOpenQueue,
}: KbPanelProps) {
  const [busy, setBusy] = useState(false);
  // 点击卡片弹出的「A4 纸阅读窗」：该条笔记的标题 + 全文
  const [viewing, setViewing] = useState<KbDocMeta | null>(null);
  // 删除确认弹窗：记录待删除的文档
  const [deleting, setDeleting] = useState<KbDocMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function submitLink() {
    const target = linkUrl.trim();
    if (!target) return;
    // 原样交给后端归一化：粘贴的常是 App 分享文案（开头还混着 `https://75` 这种假链接），
    // 在前端猜 scheme 或取第一条 http 串都会挑错
    onSubmitClip(target);
    setLinkUrl('');
    setLinkOpen(false);
    setError(null);
  }

  async function uploadFile() {
    const file = fileInputRef.current?.files?.[0];
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      // 二进制档案（PDF/Office）不能按文本读，交给后端解析：整个文件走 multipart
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kbId', currentKbId);
      const res = await fetch('/api/kb/upload', {
        method: 'POST',
        body: fd,
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? '上传失败');
      if (fileInputRef.current) fileInputRef.current.value = '';
      await onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/kb?id=${encodeURIComponent(id)}&kbId=${encodeURIComponent(currentKbId)}`,
        {
          method: 'DELETE',
        },
      );
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
    <>
      <div className="flex h-full min-h-0 flex-col">
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
                            className="group w-full max-w-full flex cursor-pointer items-start gap-2 rounded-md border bg-card px-2.5 py-2 transition-colors hover:border-primary/40"
                            onClick={() => setViewing(doc)}
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
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleting(doc);
                              }}
                              disabled={busy}
                              aria-label={`删除 ${doc.title}`}
                              className="rounded-sm p-1 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          </li>
                        ))}
          </ul>
        </ScrollArea>
        <div className="shrink-0 border-t bg-background/60 p-3">
          {linkOpen && (
            <form
              className="mb-2 flex items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                submitLink();
              }}
            >
              <Input
                autoFocus
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setLinkOpen(false);
                    setLinkUrl('');
                  }
                }}
                placeholder="粘贴链接（小红书图文 / 网页 / PDF，可省 https://）"
                aria-label="要转存的链接"
                className="h-8 min-w-0 flex-1 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="h-8 w-8 shrink-0 p-0"
                disabled={!linkUrl.trim()}
                aria-label="存入档案柜"
                title="存入档案柜"
              >
                <ArrowDownToLine className="size-4" />
              </Button>
            </form>
          )}
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.pdf,.docx,.pptx,.xlsx,.epub,.html,.htm,.csv,.json,.xml"
              className="hidden"
              onChange={() => void uploadFile()}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-10 flex-1 gap-2 text-sm font-medium"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              <FolderOpen className="size-4" />
              上传档案
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-10 w-14 gap-1 text-xs"
              onClick={() => setLinkOpen((v) => !v)}
              disabled={busy}
              aria-label="链接转存"
              aria-expanded={linkOpen}
            >
              <span className="font-mono">+🔗</span>
            </Button>
            {clipActive > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-10 w-14 gap-1 text-[11px]"
                onClick={onOpenQueue}
                aria-label={`打开转存队列，${clipActive} 个进行中`}
              >
                队列
                <span className="font-mono text-accent">{clipActive}</span>
              </Button>
            )}
          </div>
          {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
        </div>
      </div>

      {/* 笔记阅读窗：A4 竖向比例，标题 + 全文 */}
      <Dialog open={viewing != null} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="flex max-h-[82vh] w-[min(560px,92vw)] flex-col rounded-lg p-6 sm:max-w-none">
          <div className="shrink-0 space-y-1 border-b pb-3">
            <DialogTitle className="pr-6 font-serif text-base leading-snug">
              {viewing?.title || '（无标题）'}
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px]">
              {viewing
                ? viewing.createdAt.slice(0, 16).replace('T', ' ')
                : ''}
              {viewing?.embedded ? ' · 已向量化' : ' · 待向量化'}
            </DialogDescription>
          </div>
          <ScrollArea className="min-h-0 flex-1 pr-2">
            <p className="whitespace-pre-wrap text-xs leading-6 text-foreground/90">
              {viewing?.content}
            </p>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* 删除确认：确认为绿色（执行删除），取消为红色（放弃） */}
      <AlertDialog
        open={deleting != null}
        onOpenChange={(v) => !v && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-base">
              删除笔记「{deleting?.title || '（无标题）'}」？
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-5">
              该笔记将从当前知识库的档案柜中移除，向量记录一并删除；此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="h-8 bg-destructive text-xs text-destructive-foreground hover:bg-destructive/90"
              onClick={() => setDeleting(null)}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-8 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
              onClick={(e) => {
                e.preventDefault();
                const id = deleting?.id;
                setDeleting(null);
                if (id) void remove(id);
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}


