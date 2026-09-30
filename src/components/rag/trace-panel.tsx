'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ListOrdered,
  Loader2,
  MessagesSquare,
  Search,
  ShieldCheck,
  Target,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import type {
  IntentLabel,
  SourceDoc,
  StageName,
  TraceState,
} from '@/lib/rag/types';

const INTENT_LABELS: Record<IntentLabel, string> = {
  FAQ: '知识问答',
  OUT_OF_SCOPE: '超出范围',
};

const FINAL_BY_LABELS: Record<string, string> = {
  llm: '端点 LLM 判定',
  rule: '规则兜底',
};

const STAGES: Array<{ name: StageName; label: string; icon: typeof Target }> = [
  { name: 'intent', label: '意图识别', icon: Target },
  { name: 'retrieve', label: '混合检索', icon: Search },
  { name: 'rerank', label: '重排序', icon: ListOrdered },
  { name: 'generate', label: '引用生成', icon: MessagesSquare },
  { name: 'validate', label: '幻觉校验', icon: ShieldCheck },
];

function DocScoreList({
  items,
  titles,
  empty,
}: {
  items: Array<{ id: string; score: number }>;
  titles: Record<string, string>;
  empty: string;
}) {
  if (!items.length) {
    return <p className="text-[11px] text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex items-baseline justify-between gap-2 text-[11px]"
        >
          <span className="truncate text-foreground/85">
            {titles[item.id] ?? item.id}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {item.score.toFixed(4)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StageCard({
  stage,
  label,
  icon: Icon,
  current,
  done,
  children,
}: {
  stage: StageName;
  label: string;
  icon: typeof Target;
  current: StageName | 'done' | null;
  done: boolean;
  children: React.ReactNode;
}) {
  const stageOrder = STAGES.findIndex((s) => s.name === stage);
  const currentOrder =
    current && current !== 'done'
      ? STAGES.findIndex((s) => s.name === current)
      : -1;
  const dimmed = currentOrder >= 0 && stageOrder > currentOrder && !done;
  const isCurrent = current === stage;
  return (
    <div
      className={`rounded-md border bg-card p-3 transition-opacity ${
        dimmed ? 'opacity-40' : 'opacity-100'
      } ${isCurrent ? 'border-primary/60' : ''}`}
    >
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5 text-primary" />
        {label}
        {isCurrent && <Loader2 className="size-3 animate-spin text-primary" />}
      </p>
      {children}
    </div>
  );
}

interface TracePanelProps {
  trace: TraceState | null;
  sources: SourceDoc[];
  streaming: boolean;
  validationEnabled: boolean;
}

export function TracePanel({
  trace,
  sources,
  streaming,
  validationEnabled,
}: TracePanelProps) {
  const active = trace?.current ?? null;
  const retrieval = trace?.retrieval ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3">
        <h2 className="font-serif text-sm font-semibold">流程追溯</h2>
        <p className="text-[11px] text-muted-foreground">
          每一次回答的检索与校验过程
        </p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2.5 p-3">
          {!trace && (
            <p className="px-2 py-8 text-center text-xs leading-5 text-muted-foreground">
              提问后，这里会展示
              <br />
              意图识别 → 检索 → 重排 → 生成 → 校验
              <br />
              的完整过程与引用资料。
            </p>
          )}

          {trace && (
            <>
              <StageCard
                stage="intent"
                label="意图识别"
                icon={Target}
                current={active}
                done={!!trace.intent}
              >
                <Badge
                  variant="outline"
                  className={`font-mono text-[10px] ${
                    trace.intent === 'OUT_OF_SCOPE'
                      ? 'border-accent/50 text-accent'
                      : 'text-foreground/80'
                  }`}
                >
                  {trace.intent ? INTENT_LABELS[trace.intent] : '—'}
                </Badge>
                {trace.intentDetail?.clarify && (
                  <p className="mt-1.5 text-[11px] text-accent">
                    检索置信不足（最高分{' '}
                    {trace.intentDetail.top1Score?.toFixed(4)} &lt; 阈值{' '}
                    {trace.intentDetail.threshold?.toFixed(2)}）→ 澄清分支：
                    跳过 BM25 / 重排 / 校验，生成转为澄清
                  </p>
                )}
                {trace.intentDetail?.finalBy && (
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    最终：{FINAL_BY_LABELS[trace.intentDetail.finalBy] ?? trace.intentDetail.finalBy}
                  </p>
                )}
              </StageCard>

              <StageCard
                stage="retrieve"
                label="混合检索"
                icon={Search}
                current={active}
                done={!!retrieval}
              >
                {retrieval ? (
                  <div className="space-y-2">
                    {retrieval.top1Score != null && retrieval.threshold != null && (
                      <p className="font-mono text-[10px] text-muted-foreground">
                        top-1 余弦 {retrieval.top1Score.toFixed(4)} ≥ 阈值{' '}
                        {retrieval.threshold.toFixed(2)} → 进入混合检索
                      </p>
                    )}
                    <div>
                      <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                        BM25
                      </p>
                      <DocScoreList
                        items={retrieval.bm25.slice(0, 3)}
                        titles={retrieval.titles}
                        empty="无命中"
                      />
                    </div>
                    <div>
                      <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                        向量
                      </p>
                      {retrieval.vectorAvailable ? (
                        <DocScoreList
                          items={retrieval.vector.slice(0, 3)}
                          titles={retrieval.titles}
                          empty="无命中"
                        />
                      ) : (
                        <p className="text-[11px] text-accent">
                          向量服务不可用，本轮仅使用 BM25 检索
                        </p>
                      )}
                    </div>
                    <Separator />
                    <p className="text-[11px] text-muted-foreground">
                      RRF 融合后候选 {retrieval.fused.length} 条
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">等待检索…</p>
                )}
              </StageCard>

              <StageCard
                stage="rerank"
                label="重排序"
                icon={ListOrdered}
                current={active}
                done={!!trace.reranked}
              >
                {trace.reranked?.length ? (
                  <ol className="space-y-1">
                    {trace.reranked.map((r, i) => (
                      <li
                        key={r.id}
                        className="flex items-baseline gap-1.5 text-[11px]"
                      >
                        <span className="font-mono text-[10px] text-accent">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {trace.titles?.[r.id] ?? r.id}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          命中{r.matches} · {r.score.toFixed(4)}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-[11px] text-muted-foreground">等待重排…</p>
                )}
              </StageCard>

              <StageCard
                stage="generate"
                label="引用生成"
                icon={MessagesSquare}
                current={active}
                done={active === 'validate' || active === 'done'}
              >
                {trace.current === 'generate' || streaming ? (
                  <p className="text-[11px] text-muted-foreground">
                    正在根据命中的资料生成回答…
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    回答已生成，引用编号见正文
                  </p>
                )}
              </StageCard>

              <StageCard
                stage="validate"
                label="幻觉校验"
                icon={ShieldCheck}
                current={active}
                done={!!trace.validation}
              >
                {!validationEnabled && !trace.validation ? (
                  <p className="text-[11px] text-muted-foreground">
                    本轮未开启校验（可在右上角参数中开启）
                  </p>
                ) : trace.validation ? (
                  <div className="space-y-1.5">
                    <p className="flex items-center gap-1.5 text-[11px]">
                      {trace.validation.valid ? (
                        <CheckCircle2 className="size-3.5 text-primary" />
                      ) : (
                        <AlertTriangle className="size-3.5 text-accent" />
                      )}
                      <span
                        className={
                          trace.validation.valid
                            ? 'font-medium text-primary'
                            : 'font-medium text-accent'
                        }
                      >
                        {trace.validation.valid ? '校验通过' : '校验未通过'}
                      </span>
                    </p>
                    <p className="text-[11px] leading-4 text-muted-foreground">
                      {trace.validation.reason}
                    </p>
                    {trace.validation.citations.length > 0 && (
                      <p className="font-mono text-[10px] text-muted-foreground">
                        引用：[
                        {trace.validation.citations.join('] [')}
                        ]
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">等待校验…</p>
                )}
              </StageCard>

              {sources.length > 0 && (
                <div className="space-y-2 pt-1">
                  <p className="px-1 text-xs font-medium">命中的资料</p>
                  {sources.map((s, i) => (
                    <div
                      key={s.id}
                      className="rounded-md border bg-card p-3"
                    >
                      <p className="flex items-baseline gap-1.5 text-[11px] font-medium">
                        <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[3px] bg-accent px-1 font-mono text-[10px] text-accent-foreground">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1">{s.title}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {s.score.toFixed(4)}
                        </span>
                      </p>
                      <p className="mt-1.5 whitespace-pre-wrap text-[11px] leading-5 text-muted-foreground">
                        {s.content}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
