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