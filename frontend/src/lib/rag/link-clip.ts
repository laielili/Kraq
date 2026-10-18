/**
 * 链接转存任务队列的前端状态层。
 *
 * 状态归 page.tsx 单例持有：KbPanel 同时渲染在桌面 aside 与 Sheet 抽屉两处
 * （窄屏开抽屉时存在 2 个实例），hook 放进 KbPanel 会变成双份轮询 + 空白弹窗。
 * 见 plan/link-clip-progress.md §5.0。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ClipStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ClipStage =
  | 'queued'
  | 'fetching'
  | 'parsing'
  | 'chunking'
  | 'indexing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ClipResult {
  doc_ids?: string[];
  title?: string | null;
  content_chars?: number;
  image_count?: number;
  platform?: string;
}

/** 后端 LinkClipTask.to_dict() 原样（snake_case 不翻译，少一层映射漂移） */
export interface ClipTask {
  task_id: string;
  kb_id: string;
  url: string;
  status: ClipStatus;
  progress: number;
  stage: ClipStage;
  detail: string | null;
  page_title: string | null;
  error: string | null;
  result: ClipResult | null;
  created_at: string;
  updated_at: string;
  cancel_requested: boolean;
}

export const STAGE_LABEL: Record<ClipStage, string> = {
  queued: '排队中',
  fetching: '抓取网页',
  parsing: '解析正文',
  chunking: '切分片段',
  indexing: '写入档案',
  completed: '转存完成',
  failed: '转存失败',
  cancelled: '已取消',
};

const ACTIVE_STATUSES: ReadonlySet<ClipStatus> = new Set(['pending', 'running']);

export function isActive(task: ClipTask): boolean {
  return ACTIVE_STATUSES.has(task.status);
}

export function stageLabel(task: ClipTask): string {
  // 历史 tasks.json 里可能留着旧阶段名（如 extracting），映射表兜底原样显示
  return STAGE_LABEL[task.stage] ?? task.stage;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

async function readError(res: Response, fallback: string): Promise<never> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(data?.error ?? `${fallback}（HTTP ${res.status}）`);
}

export async function submitLinkClip(url: string, kbId: string): Promise<{ taskId: string; url: string }> {
  const res = await fetch('/api/link-clip/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, kbId }),
  });
  if (!res.ok) await readError(res, '提交任务失败');
  const data = (await res.json()) as { task_id?: string; url?: string; error?: string };
  if (!data.task_id) throw new Error(data.error ?? '提交任务失败');
  // 后端会把分享文案归一化成真实笔记链接，行名以归一化后的为准
  return { taskId: data.task_id, url: data.url ?? url };
}

export async function cancelLinkClipTask(taskId: string): Promise<void> {
  const res = await fetch(`/api/link-clip/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) await readError(res, '取消失败');
}

async function fetchClipTasks(kbId: string, signal: AbortSignal): Promise<ClipTask[]> {
  const res = await fetch(`/api/link-clip/tasks?kbId=${encodeURIComponent(kbId)}`, {
    signal,
  });
  if (!res.ok) await readError(res, '查询任务失败');
  const data = (await res.json()) as { tasks?: ClipTask[] };
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export function sortClipTasks(tasks: ClipTask[]): ClipTask[] {
  return [...tasks].sort((a, b) => {
    const av = isActive(a) ? 0 : 1;
    const bv = isActive(b) ? 0 : 1;
    if (av !== bv) return av - bv;
    // 进行中按提交先后（与排队位次一致）；已结束按最近更新，好让刚失败的一条先看得到
    return av === 0
      ? a.created_at.localeCompare(b.created_at)
      : b.updated_at.localeCompare(a.updated_at);
  });
}

export function docCount(task: ClipTask): number {
  return task.result?.doc_ids?.length ?? 0;
}

export interface ClipQueue {
  tasks: ClipTask[];
  activeCount: number;
  /** 轮询请求本身失败（后端或代理挂了）：保留最后已知进度，不判任务失败 */
  degraded: boolean;
  submit: (url: string) => Promise<void>;
  cancel: (taskId: string) => Promise<void>;
  retry: (task: ClipTask) => Promise<void>;
  dismiss: (taskId: string) => void;
  isRetried: (taskId: string) => boolean;
}

const POLL_MS = 1500;

export function useLinkClipTasks(
  kbId: string,
  onCompleted: () => void | Promise<void>,
): ClipQueue {
  const [tasks, setTasks] = useState<ClipTask[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [retried, setRetried] = useState<ReadonlySet<string>>(new Set());
  const [degraded, setDegraded] = useState(false);

  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 上一轮各任务的状态：用来识别"活跃 → completed"这一次跃迁，而不是每次刷新都触发 */
  const lastStatusRef = useRef<Map<string, ClipStatus>>(new Map());
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const merge = useCallback((incoming: ClipTask[]) => {
    const incomingIds = new Set(incoming.map((t) => t.task_id));
    setTasks((prev) => {
      const byId = new Map(prev.map((t) => [t.task_id, t]));
      for (const t of incoming) {
        const old = byId.get(t.task_id);
        // 过期响应（乱序返回）不能覆盖更新的进度
        if (old && old.updated_at > t.updated_at) continue;
        byId.set(t.task_id, t);
      }
      // 服务端不再返回的终态行＝已被 50 条裁剪，丢掉；活跃行必须留着继续跟
      const kept = [...byId.values()].filter(
        (t) => isActive(t) || incomingIds.has(t.task_id) || t.task_id.startsWith('local:'),
      );
      return sortClipTasks(kept);
    });
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const incoming = await fetchClipTasks(kbId, ctrl.signal);
      if (seq !== seqRef.current) return;
      setDegraded(false);
      merge(incoming);
    } catch {
      if (!ctrl.signal.aborted && seq === seqRef.current) setDegraded(true);
    }
  }, [kbId, merge]);

  const activeCount = useMemo(
    () => tasks.filter((t) => isActive(t) && !hidden.has(t.task_id)).length,
    [tasks, hidden],
  );

  // 只在有活跃任务时轮询：提交即启动，归零即停
  useEffect(() => {
    if (activeCount === 0 || timerRef.current !== null) return;
    timerRef.current = setInterval(() => void refresh(), POLL_MS);
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeCount, refresh]);

  // 切库 / 首次挂载：重来一遍
  useEffect(() => {
    seqRef.current += 1;
    abortRef.current?.abort();
    lastStatusRef.current = new Map();
    setTasks([]);
    setHidden(new Set());
    setRetried(new Set());
    setDegraded(false);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // 活跃 → completed 的跃迁才刷档案柜，并发完成去抖合并成一次
  useEffect(() => {
    const last = lastStatusRef.current;
    let freshCompleted = false;
    for (const t of tasks) {
      const before = last.get(t.task_id);
      if (before !== undefined && before !== 'completed' && t.status === 'completed') {
        freshCompleted = true;
      }
      last.set(t.task_id, t.status);
    }
    if (!freshCompleted || flushRef.current !== null) return;
    flushRef.current = setTimeout(() => {
      flushRef.current = null;
      void onCompletedRef.current();
    }, 300);
  }, [tasks]);

  useEffect(
    () => () => {
      if (flushRef.current !== null) clearTimeout(flushRef.current);
    },
    [],
  );

  const submit = useCallback(
    async (url: string) => {
      const localId = `local:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      const optimistic: ClipTask = {
        task_id: localId,
        kb_id: kbId,
        url,
        status: 'running',
        progress: 0,
        stage: 'queued',
        detail: '提交中…',
        page_title: null,
        error: null,
        result: null,
        created_at: now,
        updated_at: now,
        cancel_requested: false,
      };
      setTasks((prev) => sortClipTasks([...prev, optimistic]));
      try {
        const { taskId, url: normalized } = await submitLinkClip(url, kbId);
        setTasks((prev) =>
          sortClipTasks([
            ...prev.filter((t) => t.task_id !== localId),
            { ...optimistic, task_id: taskId, url: normalized, detail: '排队中' },
          ]),
        );
        void refresh();
      } catch (e) {
        setTasks((prev) =>
          sortClipTasks(
            prev.map((t) =>
              t.task_id === localId
                ? {
                    ...t,
                    status: 'failed' as ClipStatus,
                    stage: 'failed' as ClipStage,
                    error: e instanceof Error ? e.message : '提交任务失败',
                  }
                : t,
            ),
          ),
        );
      }
    },
    [kbId, refresh],
  );

  const cancel = useCallback(
    async (taskId: string) => {
      try {
        await cancelLinkClipTask(taskId);
        void refresh();
      } catch (e) {
        setTasks((prev) =>
          prev.map((t) =>
            t.task_id === taskId
              ? { ...t, error: e instanceof Error ? e.message : '取消失败' }
              : t,
          ),
        );
      }
    },
    [refresh],
  );

  const retry = useCallback(
    async (task: ClipTask) => {
      setRetried((prev) => new Set(prev).add(task.task_id));
      await submit(task.url);
    },
    [submit],
  );

  const dismiss = useCallback((taskId: string) => {
    setHidden((prev) => new Set(prev).add(taskId));
  }, []);

  const visibleTasks = useMemo(
    () => tasks.filter((t) => !hidden.has(t.task_id)),
    [tasks, hidden],
  );

  const isRetried = useCallback((taskId: string) => retried.has(taskId), [retried]);

  return {
    tasks: visibleTasks,
    activeCount,
    degraded,
    submit,
    cancel,
    retry,
    dismiss,
    isRetried,
  };
}
