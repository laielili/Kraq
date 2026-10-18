/* 原型引擎：检索侧逐式移植 backend/tokenizer.py 与 backend/search.py；
   事件顺序复刻 backend/pipeline.py:run_ask（超出范围与澄清分支在 intent 后短路，
   澄清分支不发 retrieve/rerank/validate）。
   模拟部分：embedding 余弦、交叉编码器打分、回答文本与逐段推送节奏。 */
(function () {
  'use strict';

  var K1 = 1.5, B = 0.75, RRF_K = 60;

  var NO_DOCS_ANSWER = '知识库暂无文档，请先在左侧「档案柜」中添加资料后再提问。';
  var GEN_NOT_CONFIGURED = '尚未配置生成模型，请点击右上角「检索与生成参数 → 配置模型」完成配置。';
  var NO_RELEVANT_ANSWER = '知识库中暂未检索到与该问题相关的资料，无法作答。';

  /* ── tokenizer.py 1:1 ───────────────────────────── */
  var WORD_RE = /[a-z0-9]+/g;
  var CJK_RUN_RE = /[\u4e00-\u9fff]+/g;

  function tokenize(text) {
    var lowered = String(text == null ? '' : text).toLowerCase();
    var tokens = [];
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(lowered))) tokens.push(m[0]);
    CJK_RUN_RE.lastIndex = 0;
    while ((m = CJK_RUN_RE.exec(lowered))) {
      var chars = Array.from(m[0]);
      for (var i = 0; i < chars.length; i++) tokens.push(chars[i]);
      for (var j = 0; j < chars.length - 1; j++) tokens.push(chars[j] + chars[j + 1]);
    }
    return tokens;
  }

  function uniqSet(tokens) {
    var set = {};
    tokens.forEach(function (t) { set[t] = 1; });
    return set;
  }

  function round4(x) { return Math.round(Number(x) * 10000) / 10000; }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

  /* ── search.py:bm25_search 1:1 ──────────────────── */
  function bm25Search(query, docs, topK) {
    var qTokens = tokenize(query);
    if (!qTokens.length || !docs.length) return [];
    var docTokens = docs.map(function (d) { return tokenize(d.title + ' ' + d.content); });
    var df = {};
    docTokens.forEach(function (tokens) {
      Object.keys(uniqSet(tokens)).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
    });
    var n = docs.length;
    var total = docTokens.reduce(function (s, t) { return s + t.length; }, 0);
    var avgdl = (total / n) || 1;

    var scored = [];
    docTokens.forEach(function (tokens, i) {
      var tf = {};
      tokens.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      var dl = tokens.length || 1;
      var score = 0;
      qTokens.forEach(function (t) {
        var f = tf[t];
        if (!f) return;
        var dfT = df[t] || 0;
        var idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
        score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (dl / avgdl)));
      });
      if (score > 0) scored.push({ id: docs[i].id, score: score });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, topK);
  }

  /* ── search.py:rrf_fuse 1:1 ─────────────────────── */
  function rrfFuse(bm25, vector, bm25Weight, vectorWeight) {
    var scores = {};
    bm25.forEach(function (r, i) { scores[r.id] = (scores[r.id] || 0) + bm25Weight / (RRF_K + i + 1); });
    vector.forEach(function (r, i) { scores[r.id] = (scores[r.id] || 0) + vectorWeight / (RRF_K + i + 1); });
    var out = Object.keys(scores).map(function (id) { return { id: id, score: scores[id] }; });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /* ── search.py:heuristic_rerank 1:1 ─────────────── */
  function heuristicRerank(query, candidates, docsById, topN) {
    var qKeys = Object.keys(uniqSet(tokenize(query)));
    var scored = candidates.map(function (c) {
      var doc = docsById[c.id];
      var tokens = doc ? uniqSet(tokenize(doc.title + ' ' + doc.content)) : {};
      var matches = qKeys.filter(function (t) { return tokens[t]; }).length;
      return { id: c.id, score: c.score, matches: matches };
    });
    scored.sort(function (a, b) { return b.matches - a.matches || b.score - a.score; });
    return scored.slice(0, topN);
  }

  /* ── 模拟向量与重排打分 ─────────────────────────── */
  function mockCosine(question, doc) {
    var q = Object.keys(uniqSet(tokenize(question)));
    if (!q.length) return 0.05;
    var titleSet = uniqSet(tokenize(doc.title));
    var bodySet = uniqSet(tokenize(doc.content));
    var hit = 0;
    q.forEach(function (t) {
      if (titleSet[t]) hit += 2;
      else if (bodySet[t]) hit += 1;
    });
    var cover = hit / (q.length * 2);
    var base = 0.505 + 0.55 * Math.pow(cover, 0.75);
    var jitter = (hash(question + '|' + doc.id) - 0.5) * 0.07;
    return Math.max(0.04, Math.min(0.97, base + jitter));
  }

  function vectorSearch(question, docs, topK) {
    return docs
      .map(function (d) { return { id: d.id, score: mockCosine(question, d) }; })
      .filter(function (r) { return r.score > 0.1; })
      .sort(function (a, b) { return b.score - a.score; })
      .slice(0, topK);
  }

  /* 模拟交叉编码器：以查询词覆盖度为主，融合名次做轻微衰减 */
  function mockRerank(question, fused, docsById) {
    var qKeys = Object.keys(uniqSet(tokenize(question)));
    return fused.map(function (r, i) {
      var doc = docsById[r.id] || { title: '', content: '' };
      var tokens = uniqSet(tokenize(doc.title + ' ' + doc.content));
      var cover = qKeys.filter(function (t) { return tokens[t]; }).length / (qKeys.length || 1);
      var score = 0.24 + 0.66 * Math.pow(cover, 0.8) - i * 0.012 + (hash(question + '|rr|' + r.id) - 0.5) * 0.05;
      return { id: r.id, score: Math.max(0.02, Math.min(0.97, score)) };
    }).sort(function (a, b) { return b.score - a.score; });
  }

  /* ── 意图 ───────────────────────────────────────── */
  var FAQ_RE = /(什么是|是什么|怎么|如何|为什么|为啥|是否|能不能|可以吗|谁是|是谁|什么时候|何时|哪里|哪儿|介绍|找|搜|检索|搜索|查一下|哪些|哪种)/;
  var OOS_RE = /(写一首|作一首|诗|天气|新闻|笑话|股票|帮我写|编译|报错|翻译|聊天|打个招呼)/;

  function classifyIntentRule(question) {
    if (OOS_RE.test(question) && !FAQ_RE.test(question)) return 'OUT_OF_SCOPE';
    return 'FAQ';
  }

  function classifyIntentLLM(question) {
    return OOS_RE.test(question) ? 'OUT_OF_SCOPE' : 'FAQ';
  }

  /* ── 校验：pipeline.py 规则兜底逐字对齐 ─────────── */
  function ruleValidation(answer, sourceCount) {
    var citations = [];
    var re = /\[(\d+)\]/g, m;
    while ((m = re.exec(answer))) citations.push(parseInt(m[1], 10));
    if (!citations.length) return { valid: false, citations: [], reason: '回答缺少引用标注 [n]，请重新生成后再试' };
    var out = citations.filter(function (n) { return n <= 0 || n > sourceCount; });
    if (out.length) {
      var uniqOut = out.filter(function (v, i) { return out.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
      return { valid: false, citations: citations, reason: '引用编号越界: [' + uniqOut.join('] [') + ']，资料共 ' + sourceCount + ' 条' };
    }
    var dedup = citations.filter(function (v, i) { return citations.indexOf(v) === i; });
    return { valid: true, citations: dedup, reason: '引用编号均在资料范围内，已去重为 ' + dedup.length + ' 位编号' };
  }

  /* ── 回答文本 ───────────────────────────────────── */
  var TITLE_RE = /\[\[([^\]]+)\]\]/g;

  function referencedTitles(text) {
    var out = [], re = new RegExp(TITLE_RE.source, 'g'), m;
    while ((m = re.exec(text))) out.push(m[1]);
    return out;
  }

  function pickScript(table, question) {
    var q = String(question).toLowerCase();
    for (var i = 0; i < table.length; i++) {
      var s = table[i];
      for (var j = 0; j < s.match.length; j++) {
        if (q.indexOf(s.match[j].toLowerCase()) >= 0) return s;
      }
    }
    return null;
  }

  function sentences(text) {
    var out = [];
    String(text).split(/\n+/).forEach(function (para) {
      (para.match(/[^。！？；]*[。！？；]?/g) || []).forEach(function (s) {
        var t = s.trim();
        if (t) out.push(t);
      });
    });
    return out;
  }

  function genericAnswer(question, sources) {
    var qKeys = Object.keys(uniqSet(tokenize(question)));
    var blocks = sources.map(function (src, i) {
      var ranked = sentences(src.doc.content).map(function (s, idx) {
        var toks = uniqSet(tokenize(s));
        return { s: s, idx: idx, hits: qKeys.filter(function (t) { return toks[t]; }).length };
      }).sort(function (a, b) { return b.hits - a.hits || a.idx - b.idx; });
      var take = ranked.slice(0, Math.min(2, ranked.length)).sort(function (a, b) { return a.idx - b.idx; });
      return '- **' + src.doc.title + '**：' + take.map(function (r) { return r.s; }).join('') + '[' + (i + 1) + ']';
    });
    return '档案柜里与「' + question + '」最接近的资料有 ' + sources.length + ' 条，能确认的是：\n\n' +
      blocks.join('\n') +
      '\n\n（原型说明：这一段由命中片段直接拼装；真实链路里由生成模型逐句作答。）';
  }

  function plainTitles(text) {
    return text.replace(new RegExp(TITLE_RE.source, 'g'), function (_, t) { return '「' + t + '」'; });
  }

  function fillTitlesBySources(text, sources) {
    return text.replace(new RegExp(TITLE_RE.source, 'g'), function (_, title) {
      for (var i = 0; i < sources.length; i++) {
        if (sources[i].title === title) return '[' + (i + 1) + ']';
      }
      return '';
    });
  }

  /* ── 流式与暂停 ─────────────────────────────────── */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function streamText(text, emit, done) {
    var chars = Array.from(text);
    var i = 0, size = 3;
    function step() {
      if (done() || i >= chars.length) return Promise.resolve();
      emit({ type: 'delta', text: chars.slice(i, i + size).join('') });
      i += size;
      return sleep(22 + Math.random() * 22).then(step);
    }
    return step();
  }

  function streamThinking(text, emit, done) {
    var chars = Array.from(text);
    var i = 0, size = 18;
    function step() {
      if (done() || i >= chars.length) return Promise.resolve();
      emit({ type: 'thinking', text: chars.slice(i, i + size).join('') });
      i += size;
      return sleep(24).then(step);
    }
    return step();
  }

  function resolveStage(cfg, key, endpoints) {
    var stage = (cfg.stages && cfg.stages[key]) || {};
    var ep = endpoints.filter(function (e) { return e.id === stage.endpointId; })[0];
    return { endpoint: ep || null, model: String(stage.model || '').trim() };
  }

  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  /* ── run_ask ────────────────────────────────────── */
  function runAsk(opts, emit, aborted) {
    var question = opts.question;
    var docs = opts.docs;
    var cfg = opts.config;
    var endpoints = opts.endpoints;
    var kb = opts.kb;
    var mode = opts.mode || 'auto';
    var kbId = kb.kbId;

    var docsById = {};
    docs.forEach(function (d) { docsById[d.id] = d; });
    function titlesMap() {
      var m = {};
      docs.forEach(function (d) { m[d.id] = d.title; });
      return m;
    }
    function done() { return aborted(); }

    return (async function () {
      // ---------- intent ----------
      var detail = {};
      var intentStage = resolveStage(cfg, 'intent', endpoints);
      var useLlm = intentStage.endpoint && intentStage.model;
      var intent = useLlm ? classifyIntentLLM(question) : classifyIntentRule(question);
      detail.finalBy = useLlm ? 'llm' : 'rule';
      if (mode === 'force_oos') { intent = 'OUT_OF_SCOPE'; detail.finalBy = 'llm'; }
      detail.intent = intent;
      emit({ type: 'stage', stage: 'intent', data: copy(detail), kbId: kbId });
      await sleep(340);
      if (done()) return;

      var gen = resolveStage(cfg, 'generate', endpoints);
      if (gen.endpoint === null || !gen.model) {
        emit({ type: 'error', message: GEN_NOT_CONFIGURED });
        return;
      }

      // ---------- 超出范围：不发检索事件，不附资料 ----------
      if (intent === 'OUT_OF_SCOPE') {
        emit({ type: 'stage', stage: 'generate', data: { model: gen.model }, kbId: kbId });
        await sleep(200);
        var oosScript = pickScript([SEED.oosScript], question);
        var oosText = oosScript ? oosScript.answer : '这类问题不在当前知识库的资料范围内，档案柜里现在只有' +
          docs.slice(0, 3).map(function (d) { return '「' + d.title + '」'; }).join('、') +
          '这些方向的条目；换成它们相关的问法，我就能带引用作答了。';
        await streamText(oosText, emit, done);
        if (done()) return;
        emit({ type: 'done', answer: oosText, sources: [], kbId: kbId });
        return;
      }

      if (!docs.length) {
        emit({
          type: 'stage', stage: 'retrieve',
          data: { vectorAvailable: false, bm25: [], vector: [], fused: [], titles: {} }, kbId: kbId
        });
        await sleep(200);
        emit({ type: 'done', answer: NO_DOCS_ANSWER, sources: [], kbId: kbId });
        return;
      }

      // ---------- retrieve：向量先行定闸门，再跑 BM25 ----------
      var candidateK = Number(cfg.retrieveTopK);
      var vectorAvailable = !!(kb.embedding && kb.embedding.model);
      var vectorList = vectorAvailable ? vectorSearch(question, docs, candidateK) : [];
      var top1 = vectorList.length ? vectorList[0].score : 0;
      var threshold = Number(cfg.clarifyThreshold);
      // 检索无果：真实前置条件是向量路不可用，否则低分先被澄清闸门接走
      if (mode === 'no_hits') { vectorAvailable = false; vectorList = []; top1 = 0; }
      var clarify = vectorAvailable && top1 < threshold;
      if (mode === 'force_clarify') clarify = vectorAvailable;

      if (clarify) {
        detail.clarify = true;
        detail.top1Score = round4(top1);
        detail.threshold = round4(threshold);
        emit({ type: 'stage', stage: 'intent', data: copy(detail), kbId: kbId });
        emit({ type: 'stage', stage: 'generate', data: { model: gen.model }, kbId: kbId });

        var near = vectorList.slice(0, Math.min(3, vectorList.length)).map(function (r) { return docsById[r.id]; });
        var clScript = pickScript([SEED.clarifyScript], question);
        if (clScript && referencedTitles(clScript.answer).some(function (t) {
          return !docs.some(function (d) { return d.title === t; });
        })) clScript = null;
        var clText = clScript
          ? plainTitles(clScript.answer)
          : '先确认一下你要问的是哪一层：是「' + (near[0] ? near[0].title : '这些资料') + '」里的做法，还是另一件事？\n\n' +
            '当前档案柜最接近的是' + near.map(function (d) { return '「' + d.title + '」'; }).join('、') +
            '，置信度不够，我先不替你作答。\n\n补一句具体场景，我按它重新检索。';
        var clThink = clScript ? clScript.thinking
          : '向量 top-1 低于置信阈值，档案柜里没有正面覆盖这个方向的条目。按澄清分支的规矩：只把问题问清楚，不作答、不挂引用编号。';
        await streamThinking(clThink, emit, done);
        if (done()) return;
        await sleep(200);
        await streamText(clText, emit, done);
        if (done()) return;
        emit({
          type: 'done', answer: clText, kbId: kbId,
          sources: vectorList.map(function (r) {
            var d = docsById[r.id];
            return { id: r.id, title: d.title, content: d.content, score: round4(r.score) };
          })
        });
        return;
      }

      var bm25List = mode === 'no_hits' ? [] : bm25Search(question, docs, candidateK);
      var fused = rrfFuse(bm25List, vectorList, Number(cfg.bm25Weight), Number(cfg.vectorWeight));
      emit({
        type: 'stage', stage: 'retrieve',
        data: {
          vectorAvailable: vectorAvailable,
          top1Score: round4(top1),
          threshold: round4(threshold),
          bm25: bm25List.map(function (r) { return { id: r.id, score: round4(r.score) }; }),
          vector: vectorList.map(function (r) { return { id: r.id, score: round4(r.score) }; }),
          fused: fused.map(function (r) { return { id: r.id, score: round4(r.score) }; }),
          titles: titlesMap()
        },
        kbId: kbId
      });
      await sleep(180);
      if (done()) return;

      if (!fused.length) {
        emit({ type: 'done', answer: NO_RELEVANT_ANSWER, sources: [], kbId: kbId });
        return;
      }

      // ---------- rerank ----------
      var topN = Number(cfg.rerankTopN);
      var rerankStage = resolveStage(cfg, 'rerank', endpoints);
      var reranked = [];
      if (rerankStage.endpoint && rerankStage.model) {
        await sleep(700); // 本机实测：10 条候选的交叉编码约 717ms
        if (done()) return;
        var scored = mockRerank(question, fused, docsById);
        var byId = {};
        scored.forEach(function (r) { byId[r.id] = r.score; });
        fused.forEach(function (r, i) {
          if (byId[r.id] != null) reranked.push({ id: r.id, score: byId[r.id], matches: 0, fusedPos: i });
        });
        reranked.sort(function (a, b) { return b.score - a.score; });
        // pipeline.py 现有语义：命中数取「融合序位 - 重排序位」的绝对值（换位量）
        reranked.forEach(function (r, outI) { r.matches = Math.abs(r.fusedPos - outI); });
      } else {
        await sleep(240);
        if (done()) return;
        reranked = heuristicRerank(question, fused, docsById, topN);
      }

      var script = pickScript(SEED.scripts, question);
      if (script) {
        // 脚本引用的资料必须都在当前库里，否则 [n] 会被替换成空串，答案失去引用
        var refs = referencedTitles(script.answer);
        var missing = refs.filter(function (t) {
          return !docs.some(function (d) { return d.title === t; });
        });
        if (missing.length) script = null;
      }
      var picked = reranked.slice(0, topN);
      if (script) {
        var need = referencedTitles(script.answer);
        need.forEach(function (t) {
          var d = docs.filter(function (x) { return x.title === t; })[0];
          if (d && !picked.some(function (r) { return r.id === d.id; })) {
            // 脚本引用的资料必须进上下文，否则 [n] 会越界；分数接在队尾之后
            var tail = picked.length ? Number(picked[picked.length - 1].score) : 0.6;
            picked.push({ id: d.id, score: Math.max(0.02, tail - 0.03), matches: 0 });
          }
        });
        var dropGuard = 0;
        while (picked.length > topN && dropGuard++ < 50) {
          var dropIdx = -1;
          for (var i = picked.length - 1; i >= 0; i--) {
            if (need.indexOf(docsById[picked[i].id].title) < 0) { dropIdx = i; break; }
          }
          if (dropIdx < 0) break;
          picked.splice(dropIdx, 1);
        }
        // 引用资料条数装不下脚本的全部引用时，退回按条数拼装的通用回答，保住这个旋钮的语义
        if (picked.length > topN) {
          script = null;
          picked = reranked.slice(0, topN);
        }
      }
      emit({
        type: 'stage', stage: 'rerank',
        data: {
          reranked: picked.map(function (r) { return { id: r.id, score: round4(r.score), matches: Number(r.matches) }; }),
          titles: titlesMap()
        },
        kbId: kbId
      });
      await sleep(160);
      if (done()) return;

      // ---------- generate ----------
      emit({ type: 'stage', stage: 'generate', data: { model: gen.model }, kbId: kbId });
      var sources = picked.map(function (r) {
        var d = docsById[r.id];
        return { id: r.id, title: d.title, content: d.content, score: round4(r.score), doc: d };
      });
      var text = script ? fillTitlesBySources(script.answer, sources) : genericAnswer(question, sources);
      if (mode === 'bad_cite') text += '\n\n这条结论还能参考 [9] 里的补充说明。';
      if (mode === 'no_cite') text = text.replace(/\[\d+\]/g, '');
      var think = script ? script.thinking
        : '按问题在档案柜里找最贴近的几条，对照用词决定引用顺序；资料没覆盖的方向留白，不编。';
      await streamThinking(think, emit, done);
      if (done()) return;
      await sleep(240);
      await streamText(text, emit, done);
      if (done()) return;

      // ---------- validate ----------
      if (cfg.enableValidation) {
        await sleep(520);
        if (done()) return;
        var v = ruleValidation(text, sources.length);
        emit({
          type: 'stage', stage: 'validate',
          data: { valid: v.valid, citations: v.citations, reason: v.reason }, kbId: kbId
        });
      }

      emit({
        type: 'done', answer: text, kbId: kbId,
        sources: sources.map(function (s) { return { id: s.id, title: s.title, content: s.content, score: s.score }; })
      });
    })();
  }

  /* 上传档案的段落感知切块（重拼保留分隔符） */
  function chunkText(text, maxChars, overlap) {
    var paras = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
    var chunks = [];
    var buf = '';
    paras.forEach(function (p) {
      var piece = (buf ? '\n\n' : '') + p;
      if (buf && (buf + piece).length > maxChars) {
        chunks.push(buf);
        buf = overlap > 0 ? buf.slice(-overlap) + '\n\n' + p : p;
      } else {
        buf += piece;
      }
      while (buf.length > maxChars * 1.6) {
        chunks.push(buf.slice(0, maxChars));
        buf = buf.slice(maxChars - overlap);
      }
    });
    if (buf.trim()) chunks.push(buf);
    return chunks.filter(function (c) { return c.trim(); });
  }

  window.Engine = {
    tokenize: tokenize,
    bm25Search: bm25Search,
    rrfFuse: rrfFuse,
    heuristicRerank: heuristicRerank,
    mockCosine: mockCosine,
    runAsk: runAsk,
    classifyIntentRule: classifyIntentRule,
    chunkText: chunkText,
    round4: round4,
    sleep: sleep,
    NO_DOCS_ANSWER: NO_DOCS_ANSWER,
    GEN_NOT_CONFIGURED: GEN_NOT_CONFIGURED,
    NO_RELEVANT_ANSWER: NO_RELEVANT_ANSWER
  };
})();
