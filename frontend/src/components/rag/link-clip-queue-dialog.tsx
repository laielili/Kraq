'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  docCount,
  hostOf,
  isActive,
  stageLabel,
  type ClipTask,
} from '@/lib/rag/link-clip';

interface QueueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: ClipTask[];
  /** 轮询自身失败：保留最后已知进度，另加一条横幅说明 */
  degraded: boolean;
  kbName: string;
  isRetried: (taskId: string) => boolean;
  onCancel: (taskId: string) => void;
  onRetry: (task: ClipTask) => void;
  onDismiss: (taskId: string) => void;
}

function ProgressBar({ task }: { task: ClipTask }) {
  const stopped = task.status === 'failed' || task.status === 'cancelled';
  const pct = task.status === 'completed' ? 100 : Math.max(0, Math.min(100, task.progress));
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${hostOf(task.url)} 转存进度`}
      className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${
          stopped ? 'bg-accent/50' : 'bg-primary'
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function statusLine(task: ClipTask): { text: string; tone: string; pulse: boolean } {
  if (task.status === 'completed') {
    return {
      // 不写"已向量化"：入库只写 kb.json，向量靠懒回填
      text: `已存为 ${docCount(task)} 条片段 · 向量化稍后补齐`,
      tone: 'text-primary',
      pulse: false,
    };
  }
  if (task.status === 'failed') {
    return { text: task.error ?? '转存失败', tone: 'text-accent', pulse: false };
  }
  if (task.status === 'cancelled') {
    return {
      text: `已取消 · 停在「${stageLabel(task)} ${Math.min(100, task.progress)}%」`,
      tone: 'text-muted-foreground',
      pulse: false,
    };
  }
  return {
    text: `${stageLabel(task)}${task.detail ? ` · ${task.detail}` : ''}`,
    tone: 'text-muted-foreground',
    pulse: true,
  };
}

function ClipRow({
  task,
  retried,
  onCancel,
  onRetry,
  onDismiss,
}: {
  task: ClipTask;
  retried: boolean;
  onCancel: (taskId: string) => void;
  onRetry: (task: ClipTask) => void;
  onDismiss: (taskId: string) => void;
}) {
  const line = statusLine(task);
  const name = task.page_title || hostOf(task.url);
  const active = isActive(task);

  return (
    <li className="border-b px-4 py-2.5 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs font-medium" title={task.url}>
          {name}
        </p>
        <span className="flex shrink-0 items-center gap-2 text-[11px]">
          {active ? (
            <button
              type="button"
              onClick={() => onCancel(task.task_id)}
              disabled={task.cancel_requested}
              aria-label={`取消转存 ${hostOf(task.url)}`}
              className="text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              {task.cancel_requested ? '取消中…' : '取消'}
            </button>
          ) : (
            <>
              {retried && <span className="text-muted-foreground">已重试</span>}
              {(task.status === 'failed' || task.status === 'cancelled') && (
                <button
                  type="button"
                  onClick={() => onRetry(task)}
                  aria-label={`重试转存 ${hostOf(task.url)}`}
                  className="text-primary hover:underline"
                >
                  重试
                </button>
              )}
              <button
                type="button"
                onClick={() => onDismiss(task.task_id)}
                aria-label={`从列表移除 ${hostOf(task.url)}`}
                className="text-muted-foreground hover:text-foreground"
              >
                清除
              </button>
            </>
          )}
        </span>
      </div>
      <p
        className={`mt-0.5 font-mono text-[10px] leading-4 ${line.tone} ${
          line.pulse ? 'animate-pulse' : ''
        }`}
      >
        {line.text}
      </p>
      {active && (
        <div className="mt-0.5 text-right font-mono text-[10px] text-muted-foreground">
          {Math.min(100, task.progress)}%
        </div>
      )}
      <ProgressBar task={task} />
    </li>
  );
}

const FINISHED_PREVIEW = 10;

export function LinkClipQueueDialog({
  open,
  onOpenChange,
  tasks,
  degraded,
  kbName,
  isRetried,
  onCancel,
  onRetry,
  onDismiss,
}: QueueDialogProps) {
  const [showAllFinished, setShowAllFinished] = useState(false);
  const running = tasks.filter(isActive);
  const finished = tasks.filter((t) => !isActive(t));
  const shownFinished = showAllFinished ? finished : finished.slice(0, FINISHED_PREVIEW);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] w-[min(620px,92vw)] flex-col gap-0 rounded-lg p-0 sm:max-w-none">
        <div className="shrink-0 space-y-1 border-b px-4 py-3">
          <DialogTitle className="font-serif text-sm">转存队列</DialogTitle>
          <DialogDescription className="font-mono text-[10px]">
            {kbName} · 进行中 {running.length} · 已结束 {finished.length}
          </DialogDescription>
        </div>

        {degraded && (
          <div className="shrink-0 border-b border-accent/40 bg-accent/10 px-4 py-1.5 text-[11px] text-accent">
            进度更新中断 · 重连中（下方为最后已知状态，任务未必失败）
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1">
          {tasks.length === 0 ? (
            <p className="px-4 py-10 text-center text-xs text-muted-foreground">
              暂无转存任务
            </p>
          ) : (
            <div role="status" aria-live="polite" className="contents">
              {running.length > 0 && (
                <ul>
                  <li className="border-b bg-muted/30 px-4 py-1 font-serif text-[10px] text-muted-foreground">
                    进行中
                  </li>
                  {running.map((t) => (
                    <ClipRow
                      key={t.task_id}
                      task={t}
                      retried={isRetried(t.task_id)}
                      onCancel={onCancel}
                      onRetry={onRetry}
                      onDismiss={onDismiss}
                    />
                  ))}
                </ul>
              )}
              {finished.length > 0 && (
                <ul>
                  <li className="border-b border-t bg-muted/30 px-4 py-1 font-serif text-[10px] text-muted-foreground">
                    已结束
                  </li>
                  {shownFinished.map((t) => (
                    <ClipRow
                      key={t.task_id}
                      task={t}
                      retried={isRetried(t.task_id)}
                      onCancel={onCancel}
                      onRetry={onRetry}
                      onDismiss={onDismiss}
                    />
                  ))}
                </ul>
              )}
              {finished.length > FINISHED_PREVIEW && (
                <button
                  type="button"
                  onClick={() => setShowAllFinished((v) => !v)}
                  className="w-full px-4 py-2 text-left font-mono text-[10px] text-primary hover:underline"
                >
                  {showAllFinished ? '收起' : `展开其余 ${finished.length - FINISHED_PREVIEW} 条`}
                </button>
              )}
            </div>
          )}
        </ScrollArea>

        <div className="shrink-0 border-t px-4 py-2 font-mono text-[10px] text-muted-foreground">
          关闭不影响后台转存 · 向量在下次检索或启动时补齐
        </div>
      </DialogContent>
    </Dialog>
  );
}
