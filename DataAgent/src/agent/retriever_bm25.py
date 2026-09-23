class BM25Retriever:
    def __init__(self, documents=None):
        self.documents = []
        if documents is not None:
            self.add_documents(documents)
   
    def add_documents(self, documents):
        self.documents = documents
   
    def retrieve(self, query, top_k=5):
        # Return top_k documents with dummy score 1.0
        return [(doc, 1.0) for doc in self.documents[:top_k]]