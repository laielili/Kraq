# AGENTS.md

## 项目概述
智能问答知识库 Agent（DataAgent）：模块化的 RAG 全链路问答系统，输入用户问题，输出带引用编号的答案并返回验证结果。链路为：意图识别 → 混合检索（BM25 + 向量）→ 重排序 → LLM/模板生成 → 引用溯源与幻觉校验。

## 技术栈
- Python 3.12（项目虚拟环境 `.venv`，由 `uv` 管理）
- 依赖：sentence-transformers、faiss-cpu、transformers、torch、pydantic、jinja2、pytest
- 无 Web 前端、无 HTTP 服务、无数据库；入口为交互式 CLI

## 目录结构
```
src/agent/
├── intent.py            # 意图分类（规则/模式匹配）
├── retriever_bm25.py    # BM25 检索器
├── retriever_vector.py  # 向量检索器（sentence-transformers + faiss）
├── hybrid_retriever.py  # 混合检索融合
├── reranker.py          # 启发式重排序
├── generator.py         # 生成器（Jinja2 模板 + LLM）
├── validator.py         # 引用溯源 + 幻觉检测
├── pipeline.py          # 流程编排 QAAgent
└── cli.py               # 演示交互入口（stdin REPL）
config.yaml               # 配置（权重、top_k、模型名等）
data/kb_sample.txt        # 知识库样例数据
prompts/qa_template.j2    # 生成提示模板
tests/                    # pytest 单元/集成测试
```

## 关键入口 / 核心模块
- `QAAgent.ask(query, top_k)`（`pipeline.py`）：一次完整问答编排，返回 `(answer, trace)`；`trace` 含 intent/retrieved/reranked/context/valid。
- `python -m src.agent.cli`：交互式提问（`exit` 退出）。

## 运行与预览
- 环境：`uv venv .venv` → `uv pip install -r requirements.txt`，在 `.venv` 上下文执行。
- 测试（默认验证）：`.venv/bin/python -m pytest -q`（测试从 DataAgent 根目录导入 `src.agent.*`）。
- 演示：`.venv/bin/python -m src.agent.cli`。
- **非预览型项目**：`.coze` 中 `preview_enable = "disabled"`，无 `[dev]`、无 `.preview`、无 `[deploy]`（CLI 无 HTTP 服务入口，平台无法部署）。技术项目根为 `DataAgent/`，工作区根 `projects/` 下为多层结构，根 `.coze` 的 `[subprojects].path = ["DataAgent"]`。

## 用户偏好与长期约束
- Python 环境统一用 `uv` + 项目级虚拟环境，不使用系统全局安装。
- Node 类依赖只用 `pnpm`。

## 常见问题和预防
- `generator.py` 依赖 `jinja2`，但 `requirements.txt` 未声明 jinja2/pyyaml（`cli.py` 用 yaml）；若环境报缺包，先确认是否需补依赖声明。
- `cli.py` 使用 `DummyLLM` 占位，未接真实 LLM；config 中 `generator.model` 为示例 T5 模型，实际未在运行路径使用。