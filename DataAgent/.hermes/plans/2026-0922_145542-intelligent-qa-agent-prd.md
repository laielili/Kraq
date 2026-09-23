# Intelligent Q&A Knowledge Base Agent Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a modular intelligent question‑answering agent that understands user intent, performs hybrid retrieval (BM25 + vector), reranks results, generates answers with citation tracing, and validates output for accuracy and hallucinations.

**Architecture:** The agent consists of independent, testable components connected via a pipeline: IntentClassifier → HybridRetriever (BM25 + Vector) → Reranker → Generator (LLM with prompt engineering) → Validator (citation + hallucination check). Each component exposes a simple interface (e.g., `process(input) -> output`) allowing easy swapping of implementations.

**Tech Stack:** Python 3.11, sentence‑transformers / FAISS for vector search, rank_bm24 for BM25, transformers (or Hermes‑provided LLM) for generation, cross‑encoder or heuristic for reranking, Pydantic for config, pytest for testing.

---

## Task 1: Project Setup & Dependencies
**Objective:** Create repository structure, virtual environment, and baseline requirements.

**Files:**
- Create: `requirements.txt`
- Create: `src/agent/__init__.py`
- Create: `config.yaml.example`
- Modify: `.gitignore` (add __pycache__, .env, venv/)

**Step 1: Write failing test** (none – setup task)

**Step 2: Verify directory creation**
Run: `ls -la src/agent/`
Expected: `__init__.py` exists

**Step 3: Write requirements**
```text
requirements.txt
sentence-transformers>=2.2.0
faiss-cpu>=1.7.4
rank_bm24>=0.1.0
transformers>=4.30.0
torch>=2.0.0
pydantic>=2.0
pytest>=7.0
```

**Step 4: Commit**
```bash
git add requirements.txt src/agent/__init__.py config.yaml.example .gitignore
git commit -m "feat: initial project structure and dependencies"
```

---

## Task 2: Intent Classification (Preset Intents)
**Objective:** Implement a rule‑based intent classifier that maps user queries to predefined intents (e.g., `FAQ`, `SEARCH`, `CLARIFY`, `OUT_OF_SCOPE`).

**Files:**
- Create: `src/agent/intent.py`
- Create: `tests/test_intent.py`

**Step 1: Write failing test**
```python
def test_intent_classification():
    from src.agent.intent import classify_intent
    assert classify_intent("什么是人工智能？") == "FAQ"
    assert classify_intent("帮我找最近的论文") == "SEARCH"
    assert classify_intent("你说的‘模型’指的是什么？") == "CLARIFY"
    assert classify_intent("今天天气怎么样") == "OUT_OF_SCOPE"
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_intent.py::test_intent_classification -v`
Expected: FAIL – `ModuleNotFoundError` or function not defined

**Step 3: Write minimal implementation**
```python
# src/agent/intent.py
import re
from typing import Literal

IntentType = Literal["FAQ", "SEARCH", "CLARIFY", "OUT_OF_SCOPE"]

_INTENT_PATTERNS = {
    "FAQ": [r"什么是", r"如何", r"为什么"],
    "SEARCH": [r"找", r"查找", r"搜索", r"给我.*资料"],
    "CLARIFY": [r"指的是", r"意思", r"解释"],
}

def classify_intent(query: str) -> IntentType:
    query = query.strip()
    for intent, patterns in _INTENT_PATTERNS.items():
        if any(re.search(p, query) for p in patterns):
            return intent
    return "OUT_OF_SCOPE"
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_intent.py::test_intent_classification -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/intent.py tests/test_intent.py
git commit -m "feat: intent classifier with preset patterns"
```

---

## Task 3: BM25 Retriever
**Objective:** Build a keyword‑based retriever using rank_bm24 over a static knowledge base.

**Files:**
- Create: `src/agent/retriever_bm25.py`
- Create: `tests/test_retriever_bm25.py`
- Create: `data/kb_sample.txt` (sample documents for testing)

**Step 1: Write failing test**
```python
def test_bm25_retriever():
    from src.agent.retriever_bm25 import BM25Retriever
    docs = ["人工智能是模拟人类智能的科学。", "机器学习是AI的一个分支。"]
    retriever = BM25Retriever(docs)
    results = retriever.retrieve("机器学习", top_k=1)
    assert len(results) == 1
    assert "机器学习" in results[0]
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_retriever_bm25.py::test_bm25_retriever -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/retriever_bm25.py
from rank_bm24 import BM25Okapi
from typing import List

class BM25Retriever:
    def __init__(self, documents: List[str]):
        self.documents = documents
        tokenized = [doc.split() for doc in documents]
        self.bm25 = BM25Okapi(tokenized)

    def retrieve(self, query: str, top_k: int = 5) -> List[str]:
        tokenized_query = query.split()
        scores = self.bm25.get_scores(tokenized_query)
        top_idx = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
        return [self.documents[i] for i in top_idx]
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_retriever_bm25.py::test_bm25_retriever -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/retriever_bm25.py tests/test_retriever_bm25.py data/kb_sample.txt
git commit -m "feat: BM25 retriever implementation"
```

---

## Task 4: Vector Retriever (Sentence‑Transformers + FAISS)
**Objective:** Implement dense vector retrieval using a pre‑trained sentence transformer and FAISS index.

**Files:**
- Create: `src/agent/retriever_vector.py`
- Create: `tests/test_retriever_vector.py`

**Step 1: Write failing test**
```python
def test_vector_retriever_shape():
    from src.agent.retriever_vector import VectorRetriever
    docs = ["人工智能是模拟人类智能的科学。", "机器学习是AI的一个分支。"]
    retriever = VectorRetriever(docs, model_name="sentence-transformers/all-MiniLM-L6-v2")
    results = retriever.retrieve("机器学习", top_k=1)
    assert len(results) == 1
    assert isinstance(results[0], str)
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_retriever_vector.py::test_vector_retriever_shape -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/retriever_vector.py
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np
from typing import List

class VectorRetriever:
    def __init__(self, documents: List[str], model_name: str = "sentence-transformers/all-MiniLM-L6-v2"):
        self.documents = documents
        self.model = SentenceTransformer(model_name)
        embeddings = self.model.encode(documents, normalize_embeddings=True)
        self.dim = embeddings.shape[1]
        self.index = faiss.IndexFlatIP(self.dim)  # inner product = cosine if normalized
        self.index.add(np.array(embeddings).astype('float32'))

    def retrieve(self, query: str, top_k: int = 5) -> List[str]:
        q_emb = self.model.encode([query], normalize_embeddings=True)
        D, I = self.index.search(np.array(q_emb).astype('float32'), top_k)
        return [self.documents[i] for i in I[0]]
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_retriever_vector.py::test_vector_retriever_shape -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/retriever_vector.py tests/test_retriever_vector.py
git commit -m "feat: vector retriever with sentence-transformers + FAISS"
```

---

## Task 5: Hybrid Retriever Fusion
**Objective:** Combine BM25 and vector results using weighted reciprocal rank fusion (RRF) or simple score averaging.

**Files:**
- Create: `src/agent/hybrid_retriever.py`
- Create: `tests/test_hybrid_retriever.py`

**Step 1: Write failing test**
```python
def test_hybrid_retriever_combines():
    from src.agent.hybrid_retriever import HybridRetriever
    from src.agent.retriever_bm25 import BM25Retriever
    from src.agent.retriever_vector import VectorRetriever
    docs = ["人工智能是模拟人类智能的科学。", "机器学习是AI的一个分支。"]
    bm25 = BM25Retriever(docs)
    vec = VectorRetriever(docs)
    hybrid = HybridRetriever([bm25, vec], weights=[0.5, 0.5])
    results = hybrid.retrieve("机器学习", top_k=2)
    assert len(results) == 2
    assert all(isinstance(r, str) for r in results)
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_hybrid_retriever.py::test_hybrid_retriever_combines -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/hybrid_retriever.py
from typing import List, Sequence

class HybridRetriever:
    def __init__(self, retrievers: Sequence, weights: List[float]):
        self.retrievers = retrievers
        self.weights = weights

    def retrieve(self, query: str, top_k: int = 5) -> List[str]:
        all_results = []
        for ret, w in zip(self.retrievers, self.weights):
            docs = ret.retrieve(query, top_k=top_k*2)  # get more to fuse
            for rank, doc in enumerate(docs, start=1):
                all_results.append((doc, w / (rank + 60)))  # RRF style
        # aggregate scores per document
        scores = {}
        for doc, score in all_results:
            scores[doc] = scores.get(doc, 0.0) + score
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return [doc for doc, _ in ranked[:top_k]]
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_hybrid_retriever.py::test_hybrid_retriever_combines -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/hybrid_retriever.py tests/test_hybrid_retriever.py
git commit -m "feat: hybrid retriever fusing BM25 and vector"
```

---

## Task 6: Reranker (Confidence & Relevance)
**Objective:** Implement a simple reranker that scores candidate passages using a cross‑encoder or heuristic (e.g., length + keyword match) and returns top‑N sorted by confidence.

**Files:**
- Create: `src/agent/reranker.py`
- Create: `tests/test_reranker.py`

**Step 1: Write failing test**
```python
def test_reranker_orders():
    from src.agent.reranker import Reranker
    query = "机器学习是什么"
    candidates = [
        "机器学习是人工智能的一个分支。",
        "今天天气很好。",
        "机器学习需要大量数据和计算资源。"
    ]
    reranker = Reranker()
    ranked = reranker.rerank(query, candidates, top_k=2)
    assert len(ranked) == 2
    assert ranked[0][0] == "机器学习是人工智能的一个分支。"
    assert ranked[1][0] == "机器学习需要大量数据和计算资源。"
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_reranker.py::test_reranker_orders -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/reranker.py
from typing import List, Tuple

class Reranker:
    def __init__(self):
        pass

    def _score(self, query: str, passage: str) -> float:
        # heuristic: keyword overlap + inverse length penalty
        q_terms = set(query.lower().split())
        p_terms = set(passage.lower().split())
        overlap = len(q_terms & p_terms)
        length_penalty = 1.0 / (1 + len(passage) / 100)
        return overlap * length_penalty

    def rerank(self, query: str, candidates: List[str], top_k: int = 5) -> List[Tuple[str, float]]:
        scored = [(doc, self._score(query, doc)) for doc in candidates]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_reranker.py::test_reranker_orders -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/reranker.py tests/test_reranker.py
git commit -m "feat: heuristic reranker based on keyword overlap"
```

---

## Task 7: Generator (LLM with Prompt Engineering)
**Objective:** Wrap the Hermes‑provided LLM (or a HuggingFace model) to produce answers given query + retrieved context, with instruction to cite sources.

**Files:**
- Create: `src/agent/generator.py`
- Create: `tests/test_generator.py`
- Create: `prompts/qa_template.j2` (Jinja2 template)

**Step 1: Write failing test**
```python
def test_generator_returns_answer():
    from src.agent.generator import QAGenerator
    # mock the LLM call to avoid external dependency in unit test
    class DummyLLM:
        def generate(self, prompt: str) -> str:
            return "根据提供的资料，机器学习是人工智能的一个分支。[1]"
    gen = QAGenerator(llm=DummyLLM())
    context = ["机器学习是人工智能的一个分支。"]
    answer = gen.generate("机器学习是什么", context)
    assert "机器学习" in answer
    assert "[1]" in answer
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_generator.py::test_generator_returns_answer -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/generator.py
from jinja2 import Template

class QAGenerator:
    def __init__(self, llm, template_path: str = "prompts/qa_template.j2"):
        self.llm = llm
        with open(template_path, encoding="utf-8") as f:
            self.template = Template(f.read())

    def generate(self, query: str, context: list[str]) -> str:
        ctx_str = "\n".join([f"[{i+1}] {c}" for i, c in enumerate(context)])
        prompt = self.template.render(query=query, context=ctx_str)
        return self.llm.generate(prompt)
```

**Prompt template (qa_template.j2):**
```jinja
你是一个知识库问答助手。请根据以下提供的资料回答用户问题，并在答案中使用方括号标注引用编号。

用户问题：{{ query }}

资料：
{{ context }}

答案：
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_generator.py::test_generator_returns_answer -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/generator.py tests/test_generator.py prompts/qa_template.j2
git commit -m "feat: LLM generator with citation prompt"
```

---

## Task 8: Validator (Citation Tracing + Hallucination Detection)
**Objective:** Implement a validator that checks that every citation in the answer corresponds to a retrieved passage and runs a simple self‑consistency check (e.g., ask the model to judge if answer is supported by context).

**Files:**
- Create: `src/agent/validator.py`
- Create: `tests/test_validator.py`

**Step 1: Write failing test**
```python
def test_validator_passes_when_citations_match():
    from src.agent.validator import AnswerValidator
    validator = AnswerValidator()
    answer = "机器学习是人工智能的一个分支。[1]"
    context = ["机器学习是人工智能的一个分支。"]
    assert validator.validate(answer, context) == True

def test_validator_fails_when_missing_citation():
    from src.agent.validator import AnswerValidator
    validator = AnswerValidator()
    answer = "机器学习是人工智能的一个分支。"  # no citation
    context = ["机器学习是人工智能的一个分支。"]
    assert validator.validate(answer, context) == False
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_validator.py -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/validator.py
import re

class AnswerValidator:
    def __init__(self):
        self.citation_pattern = re.compile(r'\[(\d+)\]')

    def validate(self, answer: str, context: list[str]) -> bool:
        citations = self.citation_pattern.findall(answer)
        # all citation numbers must be within range of context
        for num in citations:
            if not num.isdigit():
                return False
            idx = int(num) - 1
            if idx < 0 or idx >= len(context):
                return False
        # simple hallucination check: ensure answer does not contain new entities not in context
        # placeholder: if answer length > sum(context lengths)*2, flag as possible hallucination
        if len(answer) > sum(len(c) for c in context) * 2:
            return False
        return True
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_validator.py -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/validator.py tests/test_validator.py
git commit -m "feat: validator for citation tracing and basic hallucination check"
```

---

## Task 9: Pipeline Orchestration
**Objective:** Assemble intent classification, hybrid retrieval, reranking, generation, and validation into a single `QAAgent` class.

**Files:**
- Create: `src/agent/pipeline.py`
- Create: `tests/test_pipeline.py`
- Create: `config.yaml` (default configuration)

**Step 1: Write failing test**
```python
def test_pipeline_end_to_end():
    from src.agent.pipeline import QAAgent
    # use lightweight dummy components for fast unit test
    agent = QAAgent(
        intent_classifier=lambda q: "FAQ",
        retriever=lambda q, k: ["机器学习是人工智能的一个分支。"],
        reranker=lambda q, c, k: [(c[0], 1.0)],
        generator=lambda q, c: "机器学习是人工智能的一个分支。[1]",
        validator=lambda a, c: True
    )
    answer, trace = agent.ask("机器学习是什么", top_k=1)
    assert "机器学习" in answer
    assert trace["intent"] == "FAQ"
    assert len(trace["retrieved"]) == 1
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_pipeline.py::test_pipeline_end_to_end -v`
Expected: FAIL

**Step 3: Write minimal implementation**
```python
# src/agent/pipeline.py
from typing import Callable, List, Tuple, Dict, Any

class QAAgent:
    def __init__(
        self,
        intent_classifier: Callable[[str], str],
        retriever: Callable[[str, int], List[str]],
        reranker: Callable[[str, List[str], int], List[Tuple[str, float]]],
        generator: Callable[[str, List[str]], str],
        validator: Callable[[str, List[str]], bool],
    ):
        self.intent_classifier = intent_classifier
        self.retriever = retriever
        self.reranker = reranker
        self.generator = generator
        self.validator = validator

    def ask(self, query: str, top_k: int = 5) -> Tuple[str, Dict[str, Any]]:
        intent = self.intent_classifier(query)
        if intent == "OUT_OF_SCOPE":
            return "抱歉，我无法回答此问题。", {"intent": intent}
        candidates = self.retriever(query, top_k=top_k*2)
        reranked = self.reranker(query, candidates, top_k=top_k)
        context = [doc for doc, _ in reranked]
        answer = self.generator(query, context)
        is_valid = self.validator(answer, context)
        trace = {
            "intent": intent,
            "retrieved": candidates[:top_k],
            "reranked": reranked,
            "context_used": context,
            "answer": answer,
            "valid": is_valid,
        }
        return answer, trace
```

**Step 4: Run test to verify pass**
Run: `pytest tests/test_pipeline.py::test_pipeline_end_to_end -v`
Expected: PASS

**Step 5: Commit**
```bash
git add src/agent/pipeline.py tests/test_pipeline.py config.yaml
git commit -m "feat: pipeline orchestrating all components"
```

---

## Task 10: Configuration & Entrypoint (CLI / Demo Script)
**Objective:** Provide a `config.yaml` for model paths, weights, and a simple CLI demo to interact with the agent.

**Files:**
- Create: `src/agent/cli.py`
- Create: `config.yaml` (final version)
- Create: `README.md` (brief usage)

**Step 1: Write failing test** (none – demo task)

**Step 2: Write config.yaml**
```yaml
# config.yaml
intent:
  # preset patterns are hardcoded; can be extended
retriever:
  bm25_weight: 0.4
  vector_weight: 0.6
  top_k: 10
reranker:
  method: heuristic  # placeholder for future cross-encoder
generator:
  model: "uer/t5-base-chinese-cluecorpussmall"  # example Chinese T5
  max_length: 256
  temperature: 0.7
validator:
  enable_citation_check: true
  enable_hallucination_heuristic: true
```

**Step 3: Write CLI demo**
```python
# src/agent/cli.py
import yaml
import sys
from pathlib import Path
from .pipeline import QAAgent
from .intent import classify_intent
from .retriever_bm25 import BM25Retriever
from .retriever_vector import VectorRetriever
from .hybrid_retriever import HybridRetriever
from .reranker import Reranker
from .generator import QAGenerator
from .validator import AnswerValidator

def load_kb(path: str) -> list[str]:
    with open(path, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]

def main():
    cfg_path = Path("config.yaml")
    cfg = yaml.safe_load(cfg_path.read_text()) if cfg_path.exists() else {}
    # load knowledge base (for demo use sample)
    kb = load_kb("data/kb_sample.txt")
    bm25 = BM25Retriever(kb)
    vec = VectorRetriever(kb)
    hybrid = HybridRetriever([bm25, vec],
                             weights=[cfg.get("retriever",{}).get("bm25_weight",0.4),
                                      cfg.get("retriever",{}).get("vector_weight",0.6)])
    reranker = Reranker()
    # For demo we use a simple placeholder LLM that echoes context
    class DummyLLM:
        def generate(self, prompt: str) -> str:
            # very naive: return first sentence of context if contains a citation marker
            return "根据提供的资料，" + prompt.split("资料：")[-1].split("\n")[0][:50] + "。[1]"
    generator = QAGenerator(llm=DummyLLM(), template_path="prompts/qa_template.j2")
    validator = AnswerValidator()
    agent = QAAgent(
        intent_classifier=classify_intent,
        retriever=lambda q, k: hybrid.retrieve(q, top_k=k),
        reranker=reranker.rerank,
        generator=generator.generate,
        validator=validator.validate,
    )
    print("智能问答知识库Agent已启动（输入 exit 退出）")
    while True:
        query = input("\n请提问: ").strip()
        if query.lower() in ("exit", "quit"):
            break
        answer, trace = agent.ask(query, top_k=cfg.get("retriever",{}).get("top_k",5))
        print(f"\n回答: {answer}")
        if trace.get("valid") is not None:
            print(f"[验证] {'通过' if trace['valid'] else '未通过'}")
        # optionally show intent
        print(f"[意图] {trace.get('intent')}")

if __name__ == "__main__":
    main()
```

**Step 4: Create README.md**
```markdown
# 智能问答知识库 Agent

本项目实现了一个模块化的智能问答系统，包含意图识别、混合检索（BM25 + 向量）、重排序、生成与验证五大环节。

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
```

**Step 5: Commit**
```bash
git add src/agent/cli.py config.yaml README.md
git commit -m "feat: CLI demo, config, and README"
```

---

## Task 11: Integration Test with Sample Knowledge Base
**Objective:** Run an end‑to‑end scenario using a small curated KB to verify that the pipeline returns a correct answer with citations and passes validation.

**Files:**
- Create: `tests/test_integration.py`
- Extend: `data/kb_sample.txt` with a few QA pairs.

**Step 1: Write failing test**
```python
def test_integration_qa():
    from src.agent.pipeline import QAAgent
    from src.agent.intent import classify_intent
    from src.agent.retriever_bm25 import BM25Retriever
    from src.agent.retriever_vector import VectorRetriever
    from src.agent.hybrid_retriever import HybridRetriever
    from src.agent.reranker import Reranker
    from src.agent.generator import QAGenerator
    from src.agent.validator import AnswerValidator

    # tiny KB
    kb = [
        "人工智能（AI）是模拟人类智能的科学。",
        "机器学习是人工智能的一个分支，通过数据训练模型实现自动学习。",
        "深度学习使用多层神经网络进行特征学习。",
        "自然语言处理让计算机理解和生成人类语言。",
    ]
    bm25 = BM25Retriever(kb)
    vec = VectorRetriever(kb)
    hybrid = HybridRetriever([bm25, vec], weights=[0.4, 0.6])
    reranker = Reranker()
    class EchoLLM:
        def generate(self, prompt: str) -> str:
            # extract first sentence after "资料：" that looks like a context line
            import re
            m = re.search(r"资料：\n(.*)", prompt, re.S)
            if m:
                first_line = m.group(1).split("\n")[0].strip()
                return f"根据提供的资料，{first_line}[1]"
            return "未知。"
    generator = QAGenerator(llm=EchoLLM(), template_path="prompts/qa_template.j2")
    validator = AnswerValidator()
    agent = QAAgent(
        intent_classifier=classify_intent,
        retriever=lambda q, k: hybrid.retrieve(q, top_k=k),
        reranker=reranker.rerank,
        generator=generator.generate,
        validator=validator.validate,
    )
    answer, trace = agent.ask("什么是机器学习？", top_k=2)
    assert "机器学习" in answer
    assert "[1]" in answer
    assert trace["valid"] == True
```

**Step 2: Run test to verify failure**
Run: `pytest tests/test_integration.py::test_integration_qa -v`
Expected: FAIL

**Step 3: Pass after previous tasks are implemented**
Running after committing all previous tasks should PASS.

**Step 4: Commit**
```bash
git add tests/test_integration.py data/kb_sample.txt
git commit -m "feat: end‑to‑end integration test with sample KB"
```

---

## Task 12: Final Documentation & Cleanup
**Objective:** Ensure all public functions/docstrings are complete, update README with badge, and prepare a release checklist.

**Files:**
- Modify: `src/agent/*.py` (add docstrings)
- Modify: `README.md` (add installation badge, license)
- Create: `RELEASE_CHECKLIST.md`

**Step 1: Write docstring example** (we will just note the task; actual docstrings added via execute_code if needed)

**Step 2: Commit**
```bash
git add src/agent/intent.py src/agent/retriever_bm25.py src/agent/retriever_vector.py src/agent/hybrid_retriever.py src/agent/reranker.py src/agent/generator.py src/agent/validator.py src/agent/pipeline.py src/agent/cli.py README.md
git commit -m "doc: add docstrings and finalize README"
```

---

### Summary of Files Likely to Change / Be Created

```
requirements.txt
src/agent/__init__.py
src/agent/intent.py
src/agent/retriever_bm25.py
src/agent/retriever_vector.py
src/agent/hybrid_retriever.py
src/agent/reranker.py
src/agent/generator.py
src/agent/prompt/qa_template.j2
src/agent/validator.py
src/agent/pipeline.py
src/agent/cli.py
config.yaml
README.md
data/kb_sample.txt
tests/
    test_intent.py
    test_retriever_bm25.py
    test_retriever_vector.py
    test_hybrid_retriever.py
    test_reranker.py
    test_generator.py
    test_validator.py
    test_pipeline.py
    test_integration.py
```

### Risks, Trade‑offs, and Open Questions

- **Model Choice:** Using a small Chinese T5 for generation keeps latency low but may limit answer quality. Open question: whether to switch to a larger LLM via Hermes API later.
- **Hallucination Detection:** Current heuristic is rudimentary. Future work could integrate entailment models or self‑consistency sampling.
- **Scalability:** FAISS index built in‑memory; for large corpora need to implement sharded or disk‑based indexes (e.g., FAISS IVFPQ, Annoy, or Elasticsearch).
- **Intent Coverage:** Rule‑based intent may miss nuances; consider adding a lightweight classifier (e.g., Logistic Regression on TF‑IDF) as an optional extension.
- **Language Support:** Currently Chinese‑centric; extending to multilingual would require multilingual embeddings and language‑specific prompt templates.

--- 

**Plan complete and saved.** Ready to execute using subagent-driven-development — I'll dispatch a fresh subagent per task with two-stage review (spec compliance then code quality). Shall I proceed?