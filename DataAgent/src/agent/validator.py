import re

class AnswerValidator:
    def __init__(self):
        self.citation_pattern = re.compile(r'\[(\d+)\]')

    def validate(self, answer: str, context: list[str]) -> bool:
        citations = self.citation_pattern.findall(answer)
        if not citations:
            return False
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