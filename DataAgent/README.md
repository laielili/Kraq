# 智能问答知识库 Agent

本项目实现了一个模块化的智能问答系统，包含意图识别、混合检索（BM25 + 向量）、重排序、生成与验证。

## 快速开始

1. 安装依赖
   ```bash
   pip install -r requirements.txt
   ```
2. 准备知识库（放入 `data/kb.txt`，一行一条文档）。
3. 运行演示
   ```bash
   python -m src.agent.cli
   ```
4. 交互式提问，系统会给出带有引用的答案及验证结果。

## 项目结构

```
src/agent/
├── intent.py           # 意图分类（规则ベース）
├── retriever_bm25.py   # BM25 检索器
├── retriever_vector.py # 向量检索器（Sentence‑Transformers + FAISS）
├── hybrid_retriever.py # 混合检索融合
├── reranker.py         # 启发式重排序
├── generator.py        # LLM 生成（带引用模板）
├── validator.py        # 引用溯源 + 幻觉检测
├── pipeline.py         # 流程编排 QAAgent
└── cli.py              # 演示交互入口
config.yaml             # 配置文件
data/                   # 知识库存放目录
prompts/                # Jinja2 模板
tests/                  # 单元测试
```

## 测试

运行全部单元测试：

```bash
pytest -q
```

## 许可证

MIT
