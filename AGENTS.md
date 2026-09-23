# 项目上下文

## 项目概述

**DataAgent · 知识库智能问答系统**（Next.js 全栈 Web 应用）。基于 RAG 全链路的问答工作台：意图识别 → BM25 + 向量混合检索 → 重排序 → 引用生成 → 引用/幻觉校验，全过程在前端可视化（右侧"流程追溯"面板），回答带 [n] 引用编号可悬停溯源。

工作区内的 `DataAgent/` 目录是用户上传的 **Python 原型（仅作流程与架构参考，不参与构建运行）**，其 `src/agent/*.py` 是本实现的算法参考（意图规则、RRF 融合、重排启发式、校验规则）；参考实现的 BM25 是占位，本实现补了真实 BM25。

## 技术栈

- Next.js 16 (App Router) + React 19 + TypeScript 5（strict）
- Tailwind CSS 4 + shadcn/ui（组件在 `src/components/ui/`）
- 模型能力：`coze-coding-dev-sdk`（LLM 流式 `LLMClient` + 向量 `EmbeddingClient`，签名均为 `(config, customHeaders)`）
- 包管理器：**仅 pnpm**

## 目录结构（关键部分）

```
├── scripts/dev.sh|build.sh|start.sh|prepare.sh   # 预览/构建脚本（平台 [dev]/[deploy] 调用）
├── src/
│   ├── app/page.tsx                # 主工作台（三栏：档案柜/对话/流程追溯，'use client'）
│   ├── app/api/
│   │   ├── ask/route.ts            # POST SSE 流式问答（trace/delta/done/error 事件）
│   │   ├── kb/route.ts             # 知识库 GET/POST/DELETE（query 参数 id）
│   │   ├── config/route.ts         # 模型与检索参数 GET/PUT
│   │   ├── models/route.ts         # 可用模型清单（静态，来源 llm skill）
│   │   └── health/route.ts         # 探活 {ok, docs}
│   ├── lib/rag/                    # pipeline.ts 编排；intent/bm25/vector/reranker/validator/tokenizer
│   ├── lib/kb/store.ts             # 知识库+配置 JSON 存储（data/kb.json、data/config.json，互斥锁+原子写）
│   ├── lib/kb/seed.ts              # 12 条中文种子知识
│   └── components/rag/             # chat-panel / kb-panel / trace-panel / citation-text
└── data/                           # 运行时状态（已 gitignore），首次访问自动播种
```

## 运行与预览

- `.coze`（根，平台唯一入口）：`project_type="web"`、`sub_id=1775fba6`（不可改）、`[dev]`/`[deploy]` 由 Next.js 模板预置；端口统一走 `.preview`（expose_port=5000），绑定 0.0.0.0。
- 验收协议：web 项目**只认 `test_run`**（静态检查 + 探活 + 全接口 curl 冒烟）；改代码后必须重跑。
- SSE 解析：按 `\n\n` 分帧、`data: ` 前缀取 JSON；ask 事件顺序 intent→retrieve→rerank→generate→(delta…)→validate→done，异常发 `{type:"error"}`。

## 用户偏好与长期约束

- 先前方向已确认：**从 0-1 重建完整工作流，上传的 Python 原型仅作架构参考；部署先不做**（`[deploy]` 为模板默认值，未做部署验证）。
- 设计基调见 `DESIGN.md`（档案馆检索室：纸面米黄/墨黑/档案绿/朱砂批注，禁蓝紫渐变与玻璃拟态）。
- 模型需可配置切换：9 个托管模型见 `src/lib/rag/models.ts`（以 llm skill 的 Available Models 为准）。

## 常见问题和预防

- **SDK 构造签名**：`EmbeddingClient/LLMClient` 是 `(config?: Config, customHeaders?)`，不是对象字面量；Switch 用 `onCheckedChange`（不是 onValueChange）。
- **模型额度**：平台 LLM/embedding 共用网关配额，耗尽时报 `[临时不可用] 资源点不足…`。已做的诚实降级：embedding 失败→仅 BM25（trace 标注"向量服务不可用"）；LLM 失败→聊天卡内显示错误事件。**不要用 Mock 冒充生成结果**。加文档不依赖向量化（`embedded:false` 待补算，`ensureEmbeddings` 逐条增量回填并即时落盘）。
- 运行时数据在 `data/`（勿提交）；`DataAgent/` 是参考原型，别把新代码写进去。
