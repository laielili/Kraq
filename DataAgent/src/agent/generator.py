from jinja2 import Template
import os

class QAGenerator:
    def __init__(self, llm, template_path: str = "../../prompts/qa_template.j2"):
        self.llm = llm
        # Ensure template path is absolute or relative to current file
        if not os.path.isabs(template_path):
            # Assume relative to this file's directory
            base_dir = os.path.dirname(__file__)
            template_path = os.path.join(base_dir, template_path)
        with open(template_path, encoding="utf-8") as f:
            self.template = Template(f.read())

    def generate(self, query: str, context: list[str]) -> str:
        ctx_str = "\n".join([f"[{i+1}] {c}" for i, c in enumerate(context)])
        prompt = self.template.render(query=query, context=ctx_str)
        return self.llm.generate(prompt)