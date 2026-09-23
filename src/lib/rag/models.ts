import type { ModelInfo } from '@/lib/rag/types';

export const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'doubao-seed-2-0-pro-260215', label: '豆包 Seed 2.0 Pro', note: '旗舰推理，复杂任务' },
  { id: 'doubao-seed-2-0-lite-260215', label: '豆包 Seed 2.0 Lite', note: '均衡效果与成本' },
  { id: 'doubao-seed-2-0-mini-260215', label: '豆包 Seed 2.0 Mini', note: '低延迟高并发' },
  { id: 'glm-5-0-260211', label: 'GLM-5', note: '智谱旗舰基座' },
  { id: 'glm-5-turbo-260316', label: 'GLM-5 Turbo', note: '快速响应' },
  { id: 'glm-4-7-251222', label: 'GLM-4.7', note: '对话自然' },
  { id: 'minimax-m2-5-260212', label: 'MiniMax M2.5', note: '编码与智能体' },
  { id: 'minimax-m2-7-260318', label: 'MiniMax M2.7', note: '复杂 Agent 任务' },
  { id: 'qwen-3-5-plus-260215', label: 'Qwen3.5 Plus', note: '多模态视觉' },
];
