import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'DataAgent · 知识库智能问答',
    template: '%s | DataAgent',
  },
  description:
    '基于 RAG 全链路的知识库问答系统：意图识别、BM25 + 向量混合检索、重排序、引用生成与幻觉校验，全过程可视可溯源。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased`}>
        {children}
      </body>
    </html>
  );
}
