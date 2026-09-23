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