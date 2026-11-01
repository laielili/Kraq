'use client';

import { ChevronDown } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import type {
  ChunkFieldSchema,
  ChunkParamValue,
  ChunkingCfg,
  ChunkingSchemaResp,
  ChunkStrategy,
} from '@/lib/rag/types';

/**
 * 切块策略与参数控件。选项与参数形状来自 `GET /api/chunking/schema`
 * （后端 `splitters.UI_SCHEMA` 是唯一事实源），前端不写死策略清单。
 */
export function ChunkingFields({
  schema,
  value,
  onChange,
  showSliders = true,
  disabled = false,
}: {
  schema: ChunkingSchemaResp | null;
  value: ChunkingCfg;
  onChange: (next: ChunkingCfg) => void;
  showSliders?: boolean;
  disabled?: boolean;
}) {
  const strategies = schema?.strategies ?? [];
  const strategy: ChunkStrategy = value.strategy;
  const current = strategies.find((s) => s.id === strategy) ?? null;
  const params = value.params;

  const setParam = (key: string, v: ChunkParamValue) =>
    onChange({ ...value, params: { ...params, [key]: v } });

  const pickStrategy = (next: ChunkStrategy) => {
    const def = strategies.find((s) => s.id === next);
    // 换策略时把参数重置为该策略的默认值，避免把上一个策略的脏键带过去
    onChange({
      ...value,
      strategy: next,
      params: Object.fromEntries(
        (def?.fields ?? []).map((f) => [f.key, f.default] as [string, ChunkParamValue]),
      ),
    });
  };

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <Label className="text-[10px]">切块策略</Label>
        <Select
          value={strategy}
          onValueChange={(v) => pickStrategy(v as ChunkStrategy)}
          disabled={disabled}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="选择切块策略" />
          </SelectTrigger>
          <SelectContent>
            {strategies.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current?.hint && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{current.hint}</p>
        )}
      </div>

      {(current?.fields ?? []).map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          value={params[field.key]}
          disabled={disabled}
          onChange={(v) => setParam(field.key, v)}
        />
      ))}

      {showSliders && (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span>{strategy === 'json' ? '块结构尺寸' : '块最大字符'}</span>
              <span className="font-mono">{value.maxChars}</span>
            </div>
            <Slider
              value={[value.maxChars]}
              min={200}
              max={2000}
              step={50}
              disabled={disabled}
              onValueChange={(v) => onChange({ ...value, maxChars: v[0] ?? 600 })}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span>相邻重叠</span>
              <span className="font-mono">{value.overlap}</span>
            </div>
            <Slider
              value={[value.overlap]}
              min={0}
              max={200}
              step={10}
              disabled={disabled || strategy === 'json'}
              onValueChange={(v) => onChange({ ...value, overlap: v[0] ?? 50 })}
            />
            {strategy === 'json' && (
              <p className="text-[11px] text-muted-foreground">
                JSON 结构切分按路径成块，重叠参数不参与切分。
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ChunkFieldSchema;
  value: ChunkParamValue | undefined;
  onChange: (v: ChunkParamValue) => void;
  disabled: boolean;
}) {
  if (field.type === 'bool') {
    return (
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[10px]">{field.label}</Label>
        <Switch
          checked={Boolean(value ?? field.default)}
          disabled={disabled}
          onCheckedChange={(v) => onChange(v)}
        />
      </div>
    );
  }

  if (field.type === 'text') {
    return (
      <div className="space-y-1.5">
        <Label className="text-[10px]">{field.label}</Label>
        <Input
          className="h-8 font-mono text-xs"
          value={String(value ?? field.default ?? '')}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? (value as string[]) : (field.default as string[]);
    const toggle = (v: string) => {
      const base = new Set(selected);
      if (base.has(v)) base.delete(v);
      else base.add(v);
      onChange(field.options.map((o) => o.value).filter((o) => base.has(o)));
    };
    return (
      <div className="space-y-1.5">
        <Label className="text-[10px]">{field.label}</Label>
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                disabled={disabled}
                onClick={() => toggle(o.value)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  on
                    ? 'border-ink bg-ink text-paper'
                    : 'border-line text-muted-foreground hover:border-ink/50'
                }`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px]">{field.label}</Label>
      <Select
        value={String(value ?? field.default ?? '')}
        disabled={disabled}
        onValueChange={(v) => onChange(v)}
      >
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
          <ChevronDown className="size-3 opacity-60" />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
