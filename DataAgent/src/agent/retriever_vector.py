from typing import List, Tuple
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np

class VectorRetriever:
    def __init__(self, model_name: str = 'all-MiniLM-L6-v2'):
        self.model = SentenceTransformer(model_name)
        self.index = None
        self.documents = []
    
    def add_documents(self, documents: List[str]):
        self.documents = documents
        # Encode the documents
        embeddings = self.model.encode(documents, convert_to_tensor=False)
        # Build FAISS index
        dimension = embeddings.shape[1]
        self.index = faiss.IndexFlatL2(dimension)  # L2 distance
        self.index.add(embeddings.astype('float32'))
    
    def retrieve(self, query: str, top_k: int = 5) -> List[Tuple[str, float]]:
        if self.index is None:
            return []
        # Encode the query
        query_embedding = self.model.encode([query], convert_to_tensor=False)
        # Search the index
        distances, indices = self.index.search(query_embedding.astype('float32'), top_k)
        # Return list of (document, score) where score is the distance (lower is better)
        # We'll convert distance to a similarity score? But the test expects a float.
        # We'll return the distance as the score for now.
        results = []
        for idx, dist in zip(indices[0], distances[0]):
            if idx < len(self.documents):
                results.append((self.documents[idx], float(dist)))
        return results
