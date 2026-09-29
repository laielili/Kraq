# DataAgent — 知识库智能问答系统

RAG 全链路的问答工作台：**意图识别 → BM25 + 向量混合检索 → RRF 融合 → 重排序 → 流式生成 → 引用/幻觉校验**。全过程在右侧「流程追溯」面板逐步可视化，回答带 `[n]` 引用编号，悬停可溯源原文。

Python FastAPI 承担全部 RAG 逻辑，Next.js 只做界面与流式转发；模型端点可配置、可换（Ollama / 任何 OpenAI 兼容服务 / llama.cpp）。

> 前身是扣子编程 CLI 生成的 Next.js 全栈模板（当时 RAG 五环节跑在 TS 端），现已整体重构为前后端双栈架构，此前的模板式 README 已随架构一同废弃。

## 架构

```
                       浏览器只需认识 :3000
┌────────────────────────────────────────────────────────────┐
│  Next.js dev :3000（页面 + HMR）                            │
│  src/app/page.tsx 三栏工作台                                │
│    左：档案柜（多知识库切换 / 管理 / 文档上传）               │
│    中：对话流（SSE 增量渲染、thinking 折叠块、[n] 引用）      │
│    右：流程追溯（五阶段过程卡，展示真实中间数据）              │
│                                                            │
│  src/app/api/[...path]/route.ts —— 流式 catch-all           │
│  所有 /api/* 逐字节转发到 :8000（SSE 不能走 rewrites，会缓冲卡死）│
└───────────────┬────────────────────────────────────────────┘
                │ http://127.0.0.1:8000（仅本机回环，不对外）
┌───────────────▼────────────────────────────────────────────┐
│  FastAPI :8000（uvicorn，main.py 一并托管）                  │
│    backend/main.py      REST + /api/ask SSE                 │
│    backend/pipeline.py  RAG 编排 + 向量补算                  │
│    backend/search.py    BM25 / RRF / 意图规则 / 启发式重排    │
│    backend/chroma_store.py  Chroma 向量库（每库一个 collection）│
│    backend/store.py     kb.json / config.json 原子写 + 迁移   │
│    backend/models_client.py  三协议模型客户端                 │
│  非路由请求：反向代理回 :3000（所以 :8000 也能开页面，仅调试用）  │
└────────────────────────────────────────────────────────────┘
```

```
data/（运行时数据，已 gitignore，首次启动自动播种）
├── kb.json       {kbs:[{kbId, name, docs:[{id,title,content,embeddingMeta,createdAt}]}]}
├── config.json   端点 + 五阶段模型映射 + 检索/校验/切块参数
├── chroma/       唯一的向量存储（正文永远只存 kb.json，避免双写漂移）
└── example_docs/ 12 条种子资料的 txt 版（便于手动导入体验）
```

## RAG 流水线与降级策略

每一环都在真实数据上运行，所有中间结果通过 SSE 事件推给前端：

| 阶段 | 实现 | 模型不可用/失败时 |
| --- | --- | --- |
| 意图识别 | LLM 分类为 FAQ / SEARCH / CLARIFY / OUT_OF_SCOPE | 规则兜底 `classify_intent`；OUT_OF_SCOPE 短路作答 |
| 检索 | BM25（CJK 单字+二元分词）+ Chroma 向量召回，加权 RRF 融合（k=60） | 向量端点不可达→仅 BM25（trace 标记 `vectorAvailable:false`），绝不阻塞 |
| 重排 | 配置了重排模型则调用（如 bge-reranker-v2-m3） | 词重叠启发式重排兜底 |
| 生成 | 流式输出（`delta` 事件），思考型模型的思考走 `thinking` 事件 | 聊天卡内直接显示失败原因，**不用 mock 内容冒充回答** |
| 校验 | LLM 校验引用与幻觉，输出 `valid/citations/reason` JSON | 引用规则校验兜底（编号越界/缺失即不通过，可整体开关） |

诚实降级是设计原则：任何环节失败都明确标注、能兜底就兜底，不伪造结果。

## 快速开始

**前置条件**：Node.js 24 + pnpm ≥ 9、Python ≥ 3.10；生成/向量模型需要一个可访问的端点（默认配置指向本地 [Ollama](https://ollama.com) `:11434`）。

```bash
# 1. 前端依赖
pnpm install

# 2. 后端依赖（项目根建虚拟环境）
python -m venv .venv
source .venv/Scripts/activate        # Windows Git Bash；Linux/macOS 为 .venv/bin/activate
pip install -r requirements.txt      # fastapi / uvicorn / httpx / chromadb / pydantic

# 3. 一键启动（同时拉起 Next dev :3000 与 FastAPI :8000）
python main.py
```

启动完成后打开 **http://localhost:3000**（:8000 仅 API 调试入口，日常别从它开页面——从后端端口开页面会触发 dev server 异常刷新循环）。
停服按 `Ctrl+C`，main.py 会连带终止 Next 子进程（Windows 下杀整棵进程树）。

推荐配置 Ollama（默认端点即指向它）：

```bash
ollama pull qwen3:4b                    # 示例：意图/生成/校验
ollama pull qwen3-embedding:4b          # 向量
ollama pull qllama/bge-reranker-v2-m3   # 重排（可选）
```

重排端点用 `llamacpp` 协议时**无需手动起服务**：首次问答若 `:8082` 无人监听，后端会自动用 llama-server 以 `--reranking` 模式拉起（复用 ollama 已下载的 GGUF blob，不重复下载）。前提：`llama-server.exe` 位于 `~/llama.cpp/`，或用环境变量 `LLAMA_CPP_DIR` 指向其所在目录。

端口可用环境变量覆盖：`FRONTEND_PORT=3000 BACKEND_PORT=8000 python main.py`。

## 模型与检索参数配置

全部走 UI（右上角「检索与生成参数」），落盘到 `data/config.json`：

- **端点管理**：任意数量的端点，协议 `ollama` / `openai`（/v1 后缀自动探测）/ `llamacpp`；API Key 只写不回显（接口返回 `hasKey` 标记）。
- **五阶段映射**：intent / embedding / rerank / generate / validate 各自绑定端点+模型，改配置即时生效。
- **检索参数**：候选召回数 `retrieveTopK`（默认 10）、重排保留数 `rerankTopN`（默认 5，恒 ≤ 召回数）、BM25/向量权重（默认 0.4/0.6）、温度、校验开关。
- **切块参数**：文件上传按 markdown 标题/段落感知切块，`chunking.maxChars=600`、`overlap=50`。
- **Agent 级系统提示词**：归属知识问答 Agent，对所有知识库统一生效；定制存 `config.json` 的 `systemPrompt`（未定制时回落全局默认 `prompts/system_kb_default.md`）。提示词弹窗里保存空内容 = 重置回默认。注意 `[n]` 引用编号是前端渲染与幻觉校验的契约，提示词模板中的相关条目不可删。

## 项目结构

```
backend/                 # FastAPI 后端（RAG 心脏）
  main.py                # 路由：health/config/models/kbs/kb/upload/ask(SSE)
  pipeline.py            # run_ask 流水线 + 缺失向量补算（启动时后台 sync）
  search.py              # BM25、RRF、意图规则、启发式重排
  chroma_store.py        # Chroma PersistentClient（data/chroma/，每库一个 collection）
  store.py               # kb.json/config.json 存储：asyncio锁 + 原子写 + 版本迁移
  models_client.py       # ollama/openai/llamacpp 三协议 + llama.cpp rerank 服务自动拉起
  chunker.py             # 上传文件的标题/段落感知切块
  seed_docs.py           # 12 条中文种子知识（首访自动入库）
  tokenizer.py           # 中英混合分词（CJK 单字+二元组 + 词级）
src/                     # Next.js 前端
  app/page.tsx           # 三栏工作台主页面
  app/api/[...path]/route.ts  # 流式转发 /api/* → :8000（刻意不用 rewrites）
  components/rag/        # chat-panel / kb-panel / trace-panel / citation-text
                         # kb-manager-dialog / model-config-dialog / prompt-config-dialog
  lib/rag/types.ts       # SSE 事件与配置的共享类型（前后端契约钉子）
prompts/system_kb_default.md  # 生成默认系统提示词（引用契约在此）
data/                    # 运行时状态（gitignore）；删掉即完全重置
```

## API 一览

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /api/health` | `{ok, docs, kbs}` |
| `GET/PUT /api/config` | 读写端点/阶段映射/参数（PUT 侧有量程钳制） |
| `GET /api/models` | 并发探测各端点可用模型清单（配置弹窗的数据源+连通性测试） |
| `GET/POST /api/kbs`、`PUT/DELETE /api/kbs` | 知识库增删改查（default 库不可删；删库连带清 Chroma collection） |
| `GET/PUT /api/kbs/{kbId}/prompt` | 逐库系统提示词（空 = 回落全局默认） |
| `GET/POST/DELETE /api/kb` | 当前库文档列表/添加/删除（均带 `kbId`，缺省回落 `default`） |
| `POST /api/kb/upload` | 上传 txt/md（≤2M 字符）→ 自动切块入库 |
| `POST /api/ask` | SSE 问答，`kbId` 可选 |

SSE 事件序固定为 `intent → retrieve → rerank → generate → (delta/thinking…) → (validate) → done`，异常发 `{"type":"error"}`。这一帧序是前后端契约（前端 `applyEvent` 依赖它），改动任何一环都不得破坏。

## 数据与备份

`knowledge base = data/kb.json`，向量在 `data/chroma/`，均为运行时生成且已 gitignore：

- 旧版平铺结构自动迁移为单库 `default`，无需手工迁移。
- 向量按文档懒补算（带模型名+维度校验），启动时后台 `sync_all` 幂等补齐；换 embedding 模型后旧向量自动失效重算。
- 添加文档立即返回，不阻塞在向量化上（逐条增量补算，期间仅 BM25 可检索）。
- 备份/迁移只需带走 `data/` 目录；删掉 `data/` 即完全重来（下次启动重新播种 12 条种子知识）。

## 开发注意事项（红线）

- **只用 pnpm**（`preinstall` 钩子拦截 npm/yarn）。
- **改了 `backend/*.py` 必须重启** `python main.py`——uvicorn 无热重载，旧代码会静默继续生效。
- **`/api/ask` 的 SSE 必须流式透传**：`src/app/api/[...path]/route.ts` 的 catch-all 是刻意设计；换 next.config.ts rewrites 会缓冲响应体，实测卡死流式问答。
- 前端改动验证：`pnpm validate`（tsc + eslint + stylelint 三合一）；完整发布走 `pnpm run build`。
- Windows 细节：uvicorn 只绑 `127.0.0.1:8000` 是有意为之（后端不直接对外 + 避免 WS 升级冲突），勿改 `0.0.0.0`；杀后端用 `taskkill /PID <pid> /T /F` 杀整棵树，只杀监听 PID 会留残子进程占着 :8000。
- `_trash/` 存放历史参考原型（初创 Python 脚手架、已移除的组件），被 gitignore，不参与构建，勿往里写新代码。
- 运行时数据在 `data/`（gitignore），勿提交。

## 设计基准文档

- `DESIGN.md` —— 视觉语言「档案馆检索室」（纸面米黄 / 墨黑 / 档案绿 / 朱砂批注；明确禁蓝紫渐变与玻璃拟态）。改 UI 前先读它。
- `SOP.md` —— 启动运维速查（含 Windows 端口排障）。
- `AGENTS.md` —— 面向 AI 协作者的仓库上下文注释。

## 平台预览（扣子编程）

`.coze` 是平台唯一入口，`[dev]`/`[deploy]` 经 `scripts/` 下脚本驱动——日常本地开发请直接 `python main.py`。平台验收只认 `test_run`（静态检查 + 探活 + 全接口 curl 冒烟），改代码后必须重跑；预览端口走 `.preview`（`expose_port=5000`）。
