/* 原型交互层：状态、渲染与模拟管线调用 */
(function () {
  'use strict';

  var E = window.Engine;
  var SEED = window.SEED;

  var STAGE_LABEL = {
    queued: '排队中', fetching: '抓取网页', parsing: '解析正文',
    chunking: '切分片段', indexing: '写入档案', completed: '转存完成',
    failed: '转存失败', cancelled: '已取消'
  };

  var S = {
    kbId: 'default',
    kbs: JSON.parse(JSON.stringify(SEED.kbs)),
    docs: JSON.parse(JSON.stringify(SEED.docs)),
    endpoints: JSON.parse(JSON.stringify(SEED.endpoints)),
    config: JSON.parse(JSON.stringify(SEED.config)),
    prompts: JSON.parse(JSON.stringify(SEED.prompts)),
    messages: [],
    trace: null,
    streaming: false,
    abort: false,
    thinkingStart: null,
    thinkingEnd: null,
    clipTasks: [],
    clipSeq: 0,
    docSeq: 0,
    running: null,
    forced: null,
    retried: {},
    queueOpen: false,
    showAllFinished: false,
    editingKbId: null,
    editingEpId: null,
    deletingDocId: null,
    banner: ''
  };

  /* ── 工具 ───────────────────────────────────────── */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function f4(n) { return Number(n).toFixed(4); }
  function kb() { return S.kbs.filter(function (k) { return k.kbId === S.kbId; })[0] || S.kbs[0]; }
  function curDocs() { return S.docs[S.kbId] || []; }
  function nowStamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function modelsOf(epId) {
    if (S.modelsByEndpoint && S.modelsByEndpoint[epId]) return S.modelsByEndpoint[epId];
    return (SEED.modelsByEndpoint || {})[epId] || [];
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }

  /* ── 迷你 Markdown（含 [n] 引用角标） ───────────── */
  function inline(text, sources) {
    var out = esc(text);
    out = out.replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; });
    out = out.replace(/\*\*([^*]+)\*\*/g, function (_, c) { return '<strong>' + c + '</strong>'; });
    out = out.replace(/\[(\d+)\]/g, function (whole, nStr) {
      var n = parseInt(nStr, 10);
      var src = sources && sources[n - 1];
      if (!src) return '<sup class="cite dead" data-n="' + n + '">' + n + '</sup>';
      return '<sup class="cite" data-n="' + n + '" data-id="' + esc(src.id) +
        '" data-title="' + esc(src.title) + '" data-content="' + esc(src.content) + '">' + n + '</sup>';
    });
    return out;
  }

  function mdToHtml(text, sources) {
    var blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
    return blocks.map(function (b) {
      var lines = b.split('\n');
      if (/^#\s+/.test(lines[0])) return '<h3>' + inline(lines[0].replace(/^#\s+/, ''), sources) + '</h3>';
      if (/^[-*]\s+/.test(lines[0])) {
        return '<ul>' + lines.map(function (l) {
          return '<li>' + inline(l.replace(/^[-*]\s+/, ''), sources) + '</li>';
        }).join('') + '</ul>';
      }
      if (/^\d+[.)]\s+/.test(lines[0])) {
        return '<ol>' + lines.map(function (l) {
          return '<li>' + inline(l.replace(/^\d+[.)]\s+/, ''), sources) + '</li>';
        }).join('') + '</ol>';
      }
      if (/^>\s?/.test(lines[0])) return '<blockquote>' + inline(lines[0].replace(/^>\s?/, ''), sources) + '</blockquote>';
      return '<p>' + lines.map(function (l) { return inline(l, sources); }).join('<br>') + '</p>';
    }).join('');
  }

  /* ── 渲染：档案柜 ───────────────────────────────── */
  function renderKbHead() {
    $('#kb-name-label').textContent = kb().name;
  }

  function renderDocs() {
    var list = $('#doc-list');
    var docs = curDocs();
    if (!docs.length) {
      list.innerHTML = '<li class="doc-empty">暂无资料，请在下方添加</li>';
      return;
    }
    list.innerHTML = docs.map(function (d) {
      return '<li class="doc-item" data-id="' + esc(d.id) + '">' +
        '<span class="dt-ico">' + icon('file-text', '', 14) + '</span>' +
        '<div class="dt-main">' +
        '<p class="dt-title truncate">' + esc(d.title || '（无标题）') + '</p>' +
        '<p class="dt-meta"><span class="n">' + d.content.length + ' 字</span>' +
        (d.embedded
          ? '<span class="badge">已向量化</span>'
          : '<span class="badge warn">待向量化</span>') + '</p>' +
        '</div>' +
        '<button type="button" class="dt-del" data-del="' + esc(d.id) + '" aria-label="删除 ' + esc(d.title) + '">' +
        icon('trash', '', 14) + '</button>' +
        '</li>';
    }).join('');
  }

  /* ── 渲染：对话 ─────────────────────────────────── */
  function messageHtml(msg, idx) {
    if (msg.role === 'user') {
      return '<div class="msg user"><div class="body">' + esc(msg.content) + '</div></div>';
    }
    var body = '';
    if (msg.thinking && msg.thinking.length) {
      var active = msg.streaming && !msg.content;
      var secs = msg.thinkingMs != null ? Math.round(msg.thinkingMs / 1000) : null;
      body += '<div class="think">' +
        '<button type="button" class="think-btn' + (msg.thinkOpen ? ' open' : '') + '" data-think="' + idx + '" aria-expanded="' + (msg.thinkOpen ? 'true' : 'false') + '">' +
        (active ? icon('loader', 'spin', 14) : icon('brain', '', 14)) +
        '<span>' + (active ? '正在思考…' : (secs != null ? '已思考 ' + secs + ' 秒' : '已思考')) + '</span>' +
        icon('chevron-right', 'chev', 12) + '</button>' +
        (msg.thinkOpen ? '<p class="think-body">' + esc(msg.thinking) + '</p>' : '') +
        '</div>';
    }
    if (msg.content) {
      body += '<div class="prose">' + mdToHtml(msg.content, msg.sources || []) + '</div>';
      if (msg.streaming) body += '<span class="caret" aria-hidden="true"></span>';
    } else if (!(msg.thinking && msg.thinking.length)) {
      body += '<p class="pending">' + icon('loader', 'spin', 14) + (msg.streaming ? '正在分析问题…' : '') + '</p>';
    }
    if (!msg.streaming && msg.valid != null) {
      body += '<p class="valid-line ' + (msg.valid ? 'ok' : 'bad') + '">' +
        icon(msg.valid ? 'check-circle' : 'alert-triangle', '', 12) +
        (msg.valid ? '引用校验通过' : '引用校验未通过，请以资料为准') + '</p>';
    }
    return '<div class="msg bot"><div class="body' + (msg.error ? ' failed' : '') + '">' + body + '</div></div>';
  }

  function renderChat() {
    hideHover();
    var wrap = $('#chat-list');
    if (!S.messages.length) {
      wrap.innerHTML = '<div class="empty"><h2>向知识库提问</h2>' +
        '<p>回答基于档案柜中的资料生成，并标注引用编号；<br>右侧可查看检索与校验全过程。</p>' +
        '<p class="empty-note">本页面不连后端，输入框不产生回答——<br>请点输入框上方的链路按钮，它会替你发出对应的提示词。</p></div>';
      return;
    }
    wrap.innerHTML = S.messages.map(messageHtml).join('');
  }

  function scrollChat() {
    var el = $('#chat-scroll');
    el.scrollTop = el.scrollHeight;
  }

  /* ── 渲染：流程追溯 ─────────────────────────────── */
  var STAGES = [
    { name: 'intent', label: '意图识别', icon: 'target' },
    { name: 'retrieve', label: '混合检索', icon: 'search' },
    { name: 'rerank', label: '重排序', icon: 'list-ordered' },
    { name: 'generate', label: '引用生成', icon: 'message-square' },
    { name: 'validate', label: '幻觉校验', icon: 'shield-check' }
  ];
  var INTENT_LABELS = { FAQ: '知识问答', OUT_OF_SCOPE: '超出范围' };
  var FINAL_BY = { llm: '端点 LLM 判定', rule: '规则兜底' };

  function scoreRows(items, titles, empty) {
    if (!items || !items.length) return '<p class="hint">' + empty + '</p>';
    return '<div class="slist">' + items.map(function (it) {
      return '<div class="srow"><span class="nm">' + esc(titles[it.id] || it.id) + '</span>' +
        '<span class="sc">' + f4(it.score) + '</span></div>';
    }).join('') + '</div>';
  }

  function stageCard(st, order, current, doneFlag, inner) {
    var curOrder = current && current !== 'done'
      ? STAGES.findIndex(function (s) { return s.name === current; }) : -1;
    var dim = curOrder >= 0 && order > curOrder && !doneFlag;
    var isCur = current === st.name;
    return '<div class="stage' + (dim ? '' : ' lit') + (isCur ? ' current' : '') + '">' +
      '<p class="stage-h"><span class="s-ico">' + icon(st.icon, '', 14) + '</span>' + st.label +
      (isCur ? icon('loader', 'spin', 12) : '') +
      '<span class="idx">' + String(order + 1).padStart(2, '0') + '</span></p>' + inner + '</div>';
  }

  function renderTrace() {
    var body = $('#trace-body');
    var t = S.trace;
    if (!t) {
      body.innerHTML = '<p class="trace-empty">提问后，这里会展示<br>意图识别 → 检索 → 重排 → 生成 → 校验<br>的完整过程与引用资料。</p>';
      return;
    }
    var last = S.messages.slice().reverse().filter(function (m) { return m.role === 'assistant'; })[0];
    var sources = (last && last.sources) || [];
    var active = t.current;
    var r = t.retrieval;
    var html = '';

    var intentInner = '<span class="badge' + (t.intent === 'OUT_OF_SCOPE' ? ' accent' : '') + '">' +
      (t.intent ? INTENT_LABELS[t.intent] : '—') + '</span>';
    if (t.intentDetail && t.intentDetail.clarify) {
      intentInner += '<p class="hint warn" style="margin-top:6px">最高分数 ' + f4(t.intentDetail.top1Score) +
        ' 低于阈值 ' + Number(t.intentDetail.threshold).toFixed(2) + '，进入 Clarify</p>';
    }
    if (t.intentDetail && t.intentDetail.finalBy) {
      intentInner += '<p class="kv" style="margin-top:6px">最终：' + (FINAL_BY[t.intentDetail.finalBy] || t.intentDetail.finalBy) + '</p>';
    }
    if (S.forced) {
      intentInner += '<p class="kv warn" style="margin-top:6px">演示：本条链路为手动指定（' + esc(S.forced) + '）</p>';
    }
    html += stageCard(STAGES[0], 0, active, !!t.intent, intentInner);

    var retInner;
    if (r) {
      retInner = '';
      if (r.top1Score != null && r.threshold != null && r.vectorAvailable) {
        retInner += '<p class="kv">最高分数 ' + f4(r.top1Score) + ' 高于阈值 ' +
          Number(r.threshold).toFixed(2) + '，不做 Clarify</p>';
      }
      retInner += '<p class="sub">BM25</p>' + scoreRows(r.bm25, r.titles, '无命中');
      retInner += '<p class="sub">向量</p>';
      retInner += r.vectorAvailable ? scoreRows(r.vector, r.titles, '无命中')
        : '<p class="hint warn">向量服务不可用，本轮仅使用 BM25 检索</p>';
      retInner += '<div class="sep"></div><p class="hint">RRF 融合后候选 ' + r.fused.length + ' 条</p>';
    } else {
      retInner = '<p class="hint">等待检索…</p>';
    }
    html += stageCard(STAGES[1], 1, active, !!r, retInner);

    var rr = t.reranked;
    html += stageCard(STAGES[2], 2, active, !!rr, rr && rr.length
      ? '<div>' + rr.map(function (x, i) {
        return '<div class="srow"><span class="rank">' + (i + 1) + '</span>' +
          '<span class="nm">' + esc((t.titles || {})[x.id] || x.id) + '</span>' +
          '<span class="sc">命中' + x.matches + ' · ' + f4(x.score) + '</span></div>';
      }).join('') + '</div>'
      : '<p class="hint">等待重排…</p>');

    var genInner = (active === 'generate' || S.streaming)
      ? '<p class="hint">正在根据命中的资料生成回答…</p>'
      : (t.intentDetail && t.intentDetail.clarify)
        ? '<p class="hint">已生成追问，未作答</p>'
        : '<p class="hint">回答已生成，引用编号见正文</p>';
    html += stageCard(STAGES[3], 3, active, active === 'validate' || active === 'done', genInner);

    var valInner;
    if (t.intentDetail && t.intentDetail.clarify) {
      valInner = '<p class="hint">澄清分支不做校验（追问不产出引用，校验会把它判成失败）</p>';
    } else if (!S.config.enableValidation && !t.validation) {
      valInner = '<p class="hint">本轮未开启校验（可在右上角参数中开启）</p>';
    } else if (t.validation) {
      valInner = '<p class="hint" style="display:flex;align-items:center;gap:6px">' +
        icon(t.validation.valid ? 'check-circle' : 'alert-triangle', '', 14) +
        '<b style="font-weight:500;color:var(--' + (t.validation.valid ? 'primary' : 'accent') + ')">' +
        (t.validation.valid ? '校验通过' : '校验未通过') + '</b></p>' +
        '<p class="hint" style="margin-top:6px">' + esc(t.validation.reason) + '</p>' +
        (t.validation.citations.length
          ? '<p class="kv" style="margin-top:6px">引用：[' + t.validation.citations.join('] [') + ']</p>' : '');
    } else {
      valInner = '<p class="hint">等待校验…</p>';
    }
    html += stageCard(STAGES[4], 4, active, !!t.validation, valInner);

    if (sources.length) {
      html += '<p class="sources-h">命中的资料</p>' + sources.map(function (s, i) {
        return '<div class="src-card" id="src-' + esc(s.id) + '">' +
          '<p class="src-title-row"><span class="cite" data-static="1">' + (i + 1) + '</span>' +
          '<span class="nm">' + esc(s.title) + '</span>' +
          '<span class="sc">' + f4(s.score) + '</span></p>' +
          '<p class="src-content">' + esc(s.content) + '</p></div>';
      }).join('');
    }
    body.innerHTML = html;
  }

  /* ── 渲染：强制链路按钮（每个按钮绑一条最能体现该链路的问题，链路做悬浮提示） ── */
  var BRANCHES = [
    { mode: 'auto', label: '一般链路', q: '混合检索为什么要用 RRF 融合？',
      chain: '意图判定 → BM25 + 向量两路召回 → RRF 融合 → 重排序 → 带 [n] 引用生成 → 引用与幻觉校验' },
    { mode: 'force_clarify', label: '澄清追问', q: 'Kraq 支持视频转写吗？',
      chain: '意图判为知识问答 → 向量 top-1 低于置信阈值 → 跳过检索、重排与校验 → 只生成追问' },
    { mode: 'force_oos', label: '超出范围', q: '帮我写一首关于秋天的诗',
      chain: '意图判为超出范围 → 短路（不发检索事件、不附资料）→ 先说明范围再简短回应' },
    { mode: 'no_hits', label: '检索无果', q: '量子计算在蛋白质折叠上的应用？',
      chain: '意图判为知识问答、该进 RAG → 向量路不可用且 BM25 零命中 → RRF 融合候选 0 条 → 明说检索不到、无法作答' },
    { mode: 'bad_cite', label: '引用越界', kind: 'error', q: '怎么评估检索质量？',
      chain: '生成阶段给出越界编号 [9] → 规则校验判未通过 → 答案卡提示以资料为准（LLM 生成时的错，与提问方式无关）' },
    { mode: 'no_cite', label: '缺失引用', kind: 'error', q: '怎么评估检索质量？',
      chain: '生成阶段漏标所有 [n] → 规则校验判未通过：回答缺少引用标注 → 答案卡提示以资料为准（LLM 生成时的错，与提问方式无关）' }
  ];

  function renderBranches() {
    $('#demo-chips').innerHTML = BRANCHES.map(function (b) {
      return '<button type="button" class="chip' + (b.kind === 'error' ? ' bad' : '') +
        (S.running === b.mode ? ' on' : '') +
        '" data-branch="' + b.mode + '" data-tip="' + esc(b.chain) + '"' +
        (S.streaming ? ' disabled' : '') + '>' + b.label + '</button>';
    }).join('');
  }

  function renderBanner() {
    var b = $('#banner');
    if (!S.banner) { b.classList.add('hidden'); b.textContent = ''; return; }
    b.classList.remove('hidden');
    b.textContent = S.banner;
  }

  /* ── 渲染：转存队列 ─────────────────────────────── */
  function activeTasks() {
    return S.clipTasks.filter(function (t) { return t.status === 'pending' || t.status === 'running'; });
  }
  function finishedTasks() {
    return S.clipTasks.filter(function (t) { return !(t.status === 'pending' || t.status === 'running'); });
  }

  function renderQueueBtn() {
    var n = activeTasks().length;
    var btn = $('#btn-queue');
    btn.classList.toggle('hidden', n === 0);
    $('#queue-count').textContent = n;
    $('#clip-badge').textContent = n;
    $('#clip-badge').classList.toggle('hidden', n === 0);
  }

  function clipStatusLine(t) {
    if (t.status === 'completed') {
      return { text: '已存为 ' + (t.result.doc_ids || []).length + ' 条片段 · 向量化稍后补齐', tone: 'ok', pulse: false };
    }
    if (t.status === 'failed') return { text: t.error || '转存失败', tone: 'bad', pulse: false };
    if (t.status === 'cancelled') {
      return { text: '已取消 · 停在「' + STAGE_LABEL[t.stage] + ' ' + Math.min(100, t.progress) + '%」', tone: 'mute', pulse: false };
    }
    return { text: STAGE_LABEL[t.stage] + (t.detail ? ' · ' + t.detail : ''), tone: 'mute', pulse: true };
  }

  function queueRow(t) {
    var line = clipStatusLine(t);
    var name = t.page_title || t.host;
    var activeTask = t.status === 'pending' || t.status === 'running';
    var pct = t.status === 'completed' ? 100 : Math.max(0, Math.min(100, t.progress));
    var acts = activeTask
      ? '<button type="button" class="cancel" data-clip-cancel="' + esc(t.task_id) + '"' +
        (t.cancel_requested ? ' disabled' : '') + '>' + (t.cancel_requested ? '取消中…' : '取消') + '</button>'
      : (S.retried[t.task_id] ? '<span class="mute">已重试</span>' : '') +
        ((t.status === 'failed' || t.status === 'cancelled')
          ? '<button type="button" class="retry" data-clip-retry="' + esc(t.task_id) + '">重试</button>' : '') +
        '<button type="button" class="dismiss" data-clip-dismiss="' + esc(t.task_id) + '">清除</button>';
    return '<div class="q-row"><div class="q-top">' +
      '<p class="q-name truncate" title="' + esc(t.url) + '">' + esc(name) + '</p>' +
      '<span class="q-acts">' + acts + '</span></div>' +
      '<p class="q-status ' + line.tone + (line.pulse ? ' pulse' : '') + '">' + esc(line.text) + '</p>' +
      (activeTask ? '<div class="q-pct">' + pct + '%</div>' : '') +
      '<div class="bar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="' +
      esc(t.host) + ' 转存进度"><i class="' + (t.status === 'failed' || t.status === 'cancelled' ? 'stop' : '') +
      '" style="width:' + pct + '%"></i></div></div>';
  }

  function renderQueue() {
    var wrap = $('#queue-list');
    $('#queue-meta').textContent = kb().name + ' · 进行中 ' + activeTasks().length + ' · 已结束 ' + finishedTasks().length;
    var mine = S.clipTasks.filter(function (t) { return t.kb_id === S.kbId; });
    if (!mine.length) {
      wrap.innerHTML = '<p class="q-empty">暂无转存任务</p>';
      return;
    }
    var running = mine.filter(function (t) { return t.status === 'pending' || t.status === 'running'; });
    var fin = mine.filter(function (t) { return !(t.status === 'pending' || t.status === 'running'); });
    var shown = S.showAllFinished ? fin : fin.slice(0, 10);
    wrap.innerHTML =
      (running.length ? '<p class="q-group">进行中</p>' + running.map(queueRow).join('') : '') +
      (fin.length ? '<p class="q-group">已结束</p>' + shown.map(queueRow).join('') : '') +
      (fin.length > 10
        ? '<button type="button" class="q-toggle" data-toggle="show-all">' +
          (S.showAllFinished ? '收起' : '展开其余 ' + (fin.length - 10) + ' 条') + '</button>' : '');
  }

  /* ── 渲染：参数浮层 ─────────────────────────────── */
  function syncParams() {
    var c = S.config;
    $('#s-threshold').value = c.clarifyThreshold; $('#v-threshold').textContent = c.clarifyThreshold.toFixed(2);
    $('#s-topk').value = c.retrieveTopK; $('#v-topk').textContent = c.retrieveTopK;
    $('#s-bm25').value = c.bm25Weight; $('#v-bm25').textContent = c.bm25Weight.toFixed(2);
    $('#s-vector').value = c.vectorWeight; $('#v-vector').textContent = c.vectorWeight.toFixed(2);
    $('#s-temp').value = c.temperature; $('#v-temp').textContent = c.temperature.toFixed(1);
    $('#s-temp2').value = c.temperature; $('#v-temp2').textContent = c.temperature.toFixed(1);
    $('#s-topn').value = c.rerankTopN; $('#v-topn').textContent = c.rerankTopN;
    $('#sw-validate').setAttribute('aria-checked', c.enableValidation ? 'true' : 'false');
  }

  /* ── 渲染：知识库管理 ───────────────────────────── */
  function renderKbDialog() {
    $('#kb-list').innerHTML = S.kbs.map(function (k) {
      var count = (S.docs[k.kbId] || []).length;
      var emb = k.embedding && k.embedding.model ? k.embedding.model : '未配置嵌入模型';
      var on = k.kbId === S.kbId;
      var editing = S.editingKbId === k.kbId;
      return '<li class="kb-row' + (on ? ' on' : '') + '" data-kb="' + esc(k.kbId) + '">' +
        '<div class="kr-main"><p class="kr-name">' + esc(k.name) + (on ? ' · 当前' : '') + '</p>' +
        '<p class="kr-meta">' + esc(k.kbId) + ' · ' + count + ' 条 · 切块 ' + k.chunking.maxChars + '/' + k.chunking.overlap + '</p>' +
        (k.description ? '<p class="kr-desc">' + esc(k.description) + '</p>' : '') + '</div>' +
        '<button type="button" class="btn ghost xs" data-kb-edit="' + esc(k.kbId) + '">' +
        icon('pencil', '', 12) + (editing ? '收起' : '编辑') + '</button>' +
        (on ? '' : '<button type="button" class="btn outline xs" data-kb-use="' + esc(k.kbId) + '">切换</button>') +
        '</li>';
    }).join('');

    var opts = function (sel) {
      return '<option value="">（不向量化，只走 BM25）</option>' + S.endpoints.map(function (ep) {
        return modelsOf(ep.id).map(function (m) {
          return '<option value="' + esc(ep.id) + '|' + esc(m) + '"' +
            (sel && sel.endpointId === ep.id && sel.model === m ? ' selected' : '') + '>' +
            esc(m) + ' @ ' + esc(ep.name) + '</option>';
        }).join('');
      }).join('');
    };
    $('#new-kb-emb').innerHTML = opts(null);

    var id = S.editingKbId;
    var target = id ? S.kbs.filter(function (k) { return k.kbId === id; })[0] : null;
    $('#kb-form-block').classList.toggle('hidden', !target);
    if (!target) return;
    $('#kb-form-name').textContent = target.name;
    $('#kb-edit-name').value = target.name;
    $('#kb-edit-desc').value = target.description || '';
    $('#kb-edit-sug').value = (target.suggestions || []).join('\n');
    $('#kb-edit-emb').innerHTML = opts(target.embedding);
    $('#kb-edit-max').value = target.chunking.maxChars;
    $('#kb-edit-overlap').value = target.chunking.overlap;
  }

  /* ── 渲染：配置模型 ─────────────────────────────── */
  function renderModelDialog() {
    $('#ep-list').innerHTML = S.endpoints.map(function (ep) {
      var keyText = ep.protocol === 'ollama' || ep.protocol === 'llamacpp' ? '无需密钥'
        : (ep.hasKey ? '已有密钥' : '无密钥');
      return '<li class="ep-row"><div class="er-main">' +
        '<p class="er-name">' + esc(ep.name) + ' <span class="tag">' + esc(ep.protocol) + '</span></p>' +
        '<p class="er-url">' + esc(ep.baseUrl) + ' · ' + keyText + ' · ' + modelsOf(ep.id).length + ' 个模型</p></div>' +
        '<button type="button" class="btn ghost xs" data-ep-fetch="' + esc(ep.id) + '" title="获取模型列表">' +
        icon('download', '', 12) + '获取模型</button>' +
        '<button type="button" class="btn ghost xs" data-ep-edit="' + esc(ep.id) + '" aria-label="编辑 ' + esc(ep.name) + '">' +
        icon('pencil', '', 12) + '</button>' +
        '<button type="button" class="btn ghost xs" data-ep-del="' + esc(ep.id) + '" aria-label="删除 ' + esc(ep.name) + '">' +
        icon('trash', '', 12) + '</button></li>';
    }).join('');

    var HINTS = {
      intent: '如 qwen3:4b / deepseek-chat', rerank: 'Ollama 不支持；用 llama.cpp /v1/rerank 服务',
      generate: '如 qwen3:8b / deepseek-chat', validate: '如 qwen3:8b / deepseek-chat'
    };
    var NAMES = { intent: '意图识别', rerank: '重排', generate: '生成', validate: '校验' };
    var embedLabel = kb().embedding && kb().embedding.model
      ? kb().embedding.model + ' @ ' + (S.endpoints.filter(function (e) { return e.id === kb().embedding.endpointId; })[0] || { name: '端点已删除' }).name
      : '当前库未配置嵌入模型';
    $('#stage-rows').innerHTML = '<div class="readonly-row"><span class="rr-name">向量化</span>' +
      '<span class="rr-val">' + esc(embedLabel) + '</span><span class="sr-hint" style="font-size:10px;color:var(--muted-fg)">在知识库面板按库维护</span></div>' +
      ['intent', 'rerank', 'generate', 'validate'].map(function (key) {
        var st = S.config.stages[key] || { endpointId: null, model: '' };
        var models = st.endpointId ? modelsOf(st.endpointId) : [];
        return '<div class="stage-row"><span class="sr-name">' + NAMES[key] + '</span>' +
          '<select class="input sm" name="stage-ep-' + key + '" data-stage-ep="' + key + '">' +
          '<option value="">未配置</option>' +
          S.endpoints.map(function (ep) {
            return '<option value="' + esc(ep.id) + '"' + (ep.id === st.endpointId ? ' selected' : '') + '>' + esc(ep.name) + '</option>';
          }).join('') + '</select>' +
          '<select class="input sm" name="stage-model-' + key + '" data-stage-model="' + key + '">' +
          (models.length ? models.map(function (m) {
            return '<option value="' + esc(m) + '"' + (m === st.model ? ' selected' : '') + '>' + esc(m) + '</option>';
          }).join('') : '<option value="">无可选模型</option>') + '</select>' +
          '<span class="sr-hint" title="' + esc(HINTS[key]) + '">' + esc(HINTS[key]) + '</span></div>';
      }).join('');

    $('#ep-name').value = '';
    $('#ep-protocol').value = 'ollama';
    $('#ep-base').value = '';
    $('#ep-key').value = '';
    var editing = S.editingEpId ? S.endpoints.filter(function (e) { return e.id === S.editingEpId; })[0] : null;
    $('#ep-form-title').textContent = editing ? '编辑端点' : '新增端点';
    if (editing) {
      $('#ep-name').value = editing.name;
      $('#ep-protocol').value = editing.protocol;
      $('#ep-base').value = editing.baseUrl;
      $('#ep-key').placeholder = '留空不修改';
    } else {
      $('#ep-key').placeholder = S.config.stages ? '如需要才填' : '';
    }
  }

  /* ── 渲染：提示词 ───────────────────────────────── */
  function renderPromptDialog() {
    $('#prompt-main').value = S.prompts.system;
    $('#prompt-goals').innerHTML = S.prompts.goals.map(function (g, i) {
      return '<div class="field"><label class="lbl">' + esc(g[0]) + '</label>' +
        '<textarea class="input area" name="goal-' + i + '" rows="3" readonly>' + esc(g[1]) + '</textarea></div>';
    }).join('');
  }

  function renderSendBtn() {
    var btn = $('#btn-send');
    btn.innerHTML = icon(S.streaming ? 'square' : 'send', '', 16);
    btn.setAttribute('aria-label', S.streaming ? '停止生成' : '发送');
    btn.title = S.streaming ? '停止生成' : '发送';
    btn.classList.toggle('outline', S.streaming);
    $all('#demo-chips .chip').forEach(function (b) { b.disabled = S.streaming; });
  }

  /* ── 事件应用（与 page.tsx:applyEvent 同构） ────── */
  function applyEvent(ev) {
    if (ev.type === 'stage') {
      var prev = S.trace || { current: ev.stage };
      var next = Object.assign({}, prev);
      next.current = ev.stage;
      if (ev.stage === 'intent') { next.intent = ev.data.intent; next.intentDetail = ev.data; }
      if (ev.stage === 'retrieve') { next.retrieval = ev.data; next.titles = ev.data.titles; }
      if (ev.stage === 'rerank') { next.reranked = ev.data.reranked; next.titles = ev.data.titles; }
      if (ev.stage === 'validate') { next.validation = ev.data; }
      S.trace = next;
      renderTrace();
      renderChat();
      return;
    }
    if (ev.type === 'thinking') {
      if (S.thinkingStart == null) S.thinkingStart = Date.now();
      S.thinkingEnd = Date.now();
      var m = lastAssistant();
      m.thinking = (m.thinking || '') + ev.text;
      renderChat();
      return;
    }
    if (ev.type === 'delta') {
      var m2 = lastAssistant();
      m2.content += ev.text;
      renderChat();
      scrollChat();
      return;
    }
    if (ev.type === 'done') {
      var m3 = lastAssistant();
      m3.content = m3.content || ev.answer;
      m3.sources = ev.sources;
      m3.streaming = false;
      m3.thinkingMs = S.thinkingStart != null ? (S.thinkingEnd || S.thinkingStart) - S.thinkingStart : undefined;
      S.trace = S.trace ? Object.assign({}, S.trace, { current: 'done' }) : S.trace;
      renderChat();
      renderTrace();
      scrollChat();
      return;
    }
    if (ev.type === 'error') {
      var m4 = lastAssistant();
      m4.content = m4.content ? m4.content + '\n\n' + ev.message : ev.message;
      m4.error = true;
      m4.streaming = false;
      renderChat();
      scrollChat();
    }
  }

  function lastAssistant() {
    for (var i = S.messages.length - 1; i >= 0; i--) {
      if (S.messages[i].role === 'assistant') return S.messages[i];
    }
    return S.messages[S.messages.length - 1];
  }

  /* ── 发送 ───────────────────────────────────────── */
  var DEMO_ONLY_REPLY = '本页面为纯前端演示，请点击输入框上方预设提示词了解不同链路设计';

  function send(question, mode) {
    if (S.streaming) return;
    var q = String(question || '').trim();
    if (!q) return;
    if (mode === undefined) {
      S.messages.push({ role: 'user', content: q });
      S.messages.push({ role: 'assistant', content: DEMO_ONLY_REPLY, sources: [] });
      renderChat();
      scrollChat();
      return;
    }
    var branch = BRANCHES.filter(function (b) { return b.mode === mode; })[0];
    S.running = mode;
    S.forced = mode !== 'auto' && branch ? branch.label : null;
    S.streaming = true;
    S.abort = false;
    renderSendBtn();
    renderBranches();
    S.thinkingStart = null;
    S.thinkingEnd = null;
    S.trace = null;
    S.messages.push({ role: 'user', content: q });
    S.messages.push({ role: 'assistant', content: '', thinking: '', sources: [], streaming: true, valid: null, error: false });
    renderChat();
    renderTrace();
    scrollChat();

    E.runAsk(
      { question: q, docs: curDocs(), config: S.config, endpoints: S.endpoints, kb: kb(), mode: mode },
      applyEvent,
      function () { return S.abort; }
    ).then(function () {
      S.streaming = false;
      renderSendBtn();
      renderBranches();
      var m = lastAssistant();
      if (m && m.streaming) { m.streaming = false; renderChat(); }
      // 校验结论回填到答案卡（真前端此处未接线，原型补上）
      if (S.trace && S.trace.validation && !S.abort) {
        m.valid = S.trace.validation.valid;
        renderChat();
      }
      renderTrace();
    });
  }

  function stop() {
    S.abort = true;
    S.streaming = false;
    renderSendBtn();
    renderBranches();
    var m = lastAssistant();
    if (m) m.streaming = false;
    renderChat();
    renderTrace();
  }

  /* ── 档案柜动作 ─────────────────────────────────── */
  function addDocs(docs) {
    if (!S.docs[S.kbId]) S.docs[S.kbId] = [];
    S.docs[S.kbId] = docs.concat(S.docs[S.kbId]);
    renderDocs();
    // 懒回填：向量按条逐个补齐，不阻塞入库
    docs.forEach(function (d, i) {
      if (d.embedded) return;
      setTimeout(function () {
        d.embedded = true;
        renderDocs();
      }, 1400 + i * 1100);
    });
  }

  function nextDocId(prefix) {
    S.docSeq += 1;
    return prefix + '-' + String(S.docSeq).padStart(3, '0');
  }

  function handleFile(file) {
    var ok = /\.(txt|md|markdown)$/i.test(file.name);
    if (!ok) {
      showKbError('原型没有接入档案解析：PDF/Office 走后端 markitdown 转 Markdown，这里只收 .txt / .md');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      if (!text.trim()) { showKbError('文件是空的，没有入库'); return; }
      var k = kb();
      var chunks = E.chunkText(text, k.chunking.maxChars, k.chunking.overlap);
      var base = file.name.replace(/\.(txt|md|markdown)$/i, '');
      addDocs(chunks.map(function (c, i) {
        return {
          id: nextDocId('up'),
          title: chunks.length > 1 ? base + ' · 片段 ' + (i + 1) : base,
          content: c,
          embedded: false,
          createdAt: nowStamp()
        };
      }));
      toast('已存入 ' + chunks.length + ' 条片段 · 向量化稍后补齐');
    };
    reader.onerror = function () { showKbError('读取失败：文件可能已被移动'); };
    reader.readAsText(file, 'utf-8');
  }

  function showKbError(msg) {
    var el = $('#kb-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(function () { el.classList.add('hidden'); }, 4200);
  }

  /* 分享文案里挑出带字母域名的那条：https://75 会被解析成主机 0.0.0.75，必须按域名形状筛 */
  var CLIP_URL_RE = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[:\/?#][^\s，。、！？）)】》"'《]*)*/gi;

  function normalizeClipUrl(raw) {
    var text = String(raw || '').trim();
    var hits = text.match(CLIP_URL_RE) || [];
    var cand = '';
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i].replace(/[.,;:]+$/, '');
      if (!/\./.test(h)) continue;
      cand = /^https?:\/\//i.test(h) ? h : 'https://' + h;
      break;
    }
    if (!cand) return { url: text, host: '' };
    var host = '';
    try { host = new URL(cand).host; } catch (e) { host = ''; }
    if (!/^[a-z0-9.-]+$/i.test(host) || !/[a-z]{2,}$/i.test(host.replace(/\/.*$/, ''))) host = '';
    return { url: cand, host: host.toLowerCase() };
  }

  function clipPageFor(host) {
    if (SEED.clipPages[host]) return SEED.clipPages[host];
    var key = Object.keys(SEED.clipPages).filter(function (k) {
      return host === 'www.' + k || host.slice(-(k.length + 1)) === '.' + k;
    })[0];
    return key ? SEED.clipPages[key] : null;
  }

  function submitClip(raw) {
    var t = normalizeClipUrl(raw);
    if (!t.host) { showKbError('没识别出链接：粘贴整段分享文案也可以，但要包含带字母域名的那条'); return; }
    if (!/\./.test(t.host) || /^(localhost|127\.0\.0\.1)$/.test(t.host)) {
      showKbError('地址不合法：主机名要带点，且只允许 http/https');
      return;
    }
    var page = clipPageFor(t.host);
    S.clipSeq += 1;
    var task = {
      task_id: 'clip-' + S.clipSeq,
      kb_id: S.kbId,
      url: t.url,
      host: t.host,
      status: 'pending',
      progress: 0,
      stage: 'queued',
      detail: null,
      page_title: null,
      error: null,
      result: null,
      created_at: nowStamp(),
      updated_at: nowStamp(),
      cancel_requested: false
    };
    S.clipTasks.unshift(task);
    renderQueueBtn();
    renderQueue();
    runClipTask(task, page);
  }

  function runClipTask(task, page) {
    var steps = [
      { stage: 'fetching', progress: 15, detail: '移动端 UA 请求中' },
      { stage: 'fetching', progress: 32, detail: '命中分享链接自带的 xsec_token' },
      { stage: 'parsing', progress: 52, detail: '提取正文与标题' },
      { stage: 'chunking', progress: 74, detail: '按 400/40 切块' },
      { stage: 'indexing', progress: 92, detail: '写入 data/kb.json' }
    ];
    task.status = 'running';
    task.stage = 'queued';
    task.updated_at = nowStamp();

    function tick(i) {
      if (task.cancel_requested) {
        task.status = 'cancelled';
        task.updated_at = nowStamp();
        renderQueue(); renderQueueBtn();
        return;
      }
      if (i >= steps.length) {
        if (!page) {
          task.status = 'failed';
          task.error = SEED.unsupportedClip;
          task.updated_at = nowStamp();
          renderQueue(); renderQueueBtn();
          return;
        }
        var k = kb();
        var chunks = E.chunkText(page.content, k.chunking.maxChars, k.chunking.overlap);
        var ids = chunks.map(function (c, n) {
          return {
            id: nextDocId('clip'),
            title: chunks.length > 1 ? page.title + ' · 片段 ' + (n + 1) : page.title,
            content: c,
            embedded: false,
            createdAt: nowStamp()
          };
        });
        addDocs(ids);
        task.page_title = page.title;
        task.result = { doc_ids: ids.map(function (d) { return d.id; }), title: page.title, content_chars: page.content.length, platform: task.host };
        task.stage = 'completed';
        task.status = 'completed';
        task.progress = 100;
        task.detail = null;
        task.updated_at = nowStamp();
        renderQueue(); renderQueueBtn(); renderDocs();
        return;
      }
      var s = steps[i];
      task.stage = s.stage;
      task.progress = s.progress;
      task.detail = s.detail;
      task.updated_at = nowStamp();
      renderQueue();
      setTimeout(function () { tick(i + 1); }, 620);
    }
    setTimeout(function () { tick(0); }, 320);
  }

  /* ── 浮层控制 ───────────────────────────────────── */
  var openOverlays = [];
  function openOv(id) {
    $('#' + id).classList.remove('hidden');
    openOverlays.push(id);
    $('#backdrop').classList.remove('hidden');
  }
  function closeOv(id) {
    $('#' + id).classList.add('hidden');
    openOverlays = openOverlays.filter(function (x) { return x !== id; });
    if (!openOverlays.length) $('#backdrop').classList.add('hidden');
  }
  function closeTopOv() {
    if (openOverlays.length) { closeOv(openOverlays[openOverlays.length - 1]); return; }
    $('#col-left').classList.remove('open');
    $('#col-right').classList.remove('open');
    $('#params-pop').classList.add('hidden');
    $('#btn-params').setAttribute('aria-expanded', 'false');
    if (!$('#cite-hover').classList.contains('hidden')) hideHover();
  }

  function hideHover() {
    var h = $('#cite-hover');
    h.classList.remove('show');
    h.classList.add('hidden');
  }

  function showHover(el) {
    var h = $('#cite-hover');
    var title = el.dataset.title, content = el.dataset.content, n = el.dataset.n;
    h.innerHTML = '<p class="hc-title"><span class="cite" data-static="1">' + n + '</span>' + esc(title) + '</p>' +
      '<p class="hc-body">' + esc(content) + '</p>';
    h.classList.remove('hidden');
    requestAnimationFrame(function () {
      var r = el.getBoundingClientRect();
      var w = h.offsetWidth, hh = h.offsetHeight;
      var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
      var top = r.bottom + 6 + hh > window.innerHeight ? Math.max(8, r.top - hh - 6) : r.bottom + 6;
      h.style.left = left + 'px';
      h.style.top = top + 'px';
      h.classList.add('show');
    });
  }

  /* ── 接线 ───────────────────────────────────────── */
  function wire() {
    // 头部
    $('#btn-params').addEventListener('click', function (e) {
      e.stopPropagation();
      var pop = $('#params-pop');
      var show = pop.classList.contains('hidden');
      pop.classList.toggle('hidden', !show);
      $('#btn-params').setAttribute('aria-expanded', show ? 'true' : 'false');
    });
    $('#params-pop').addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () {
      $('#params-pop').classList.add('hidden');
      $('#btn-params').setAttribute('aria-expanded', 'false');
    });
    $('#btn-open-models').addEventListener('click', function () {
      $('#params-pop').classList.add('hidden');
      renderModelDialog();
      openOv('ov-models');
    });
    $('#btn-drawer-left').addEventListener('click', function () { $('#col-left').classList.add('open'); $('#backdrop').classList.remove('hidden'); });
    $('#btn-drawer-right').addEventListener('click', function () { $('#col-right').classList.add('open'); $('#backdrop').classList.remove('hidden'); });
    $('#backdrop').addEventListener('click', function () {
      closeTopOv();
      $('#col-left').classList.remove('open');
      $('#col-right').classList.remove('open');
    });

    // 滑杆与开关
    function bindSlider(sel, key, fmt, extra) {
      $(sel).addEventListener('input', function () {
        var v = Number(this.value);
        if (key === 'retrieveTopK') {
          S.config.retrieveTopK = v;
          S.config.rerankTopN = Math.min(S.config.rerankTopN, v);
        } else if (key === 'rerankTopN') {
          S.config.rerankTopN = v;
          S.config.retrieveTopK = Math.max(S.config.retrieveTopK, v);
        } else {
          S.config[key] = v;
        }
        if (extra) extra(v);
        syncParams();
        renderTrace();
      });
    }
    bindSlider('#s-threshold', 'clarifyThreshold');
    bindSlider('#s-topk', 'retrieveTopK');
    bindSlider('#s-bm25', 'bm25Weight');
    bindSlider('#s-vector', 'vectorWeight');
    bindSlider('#s-temp', 'temperature');
    bindSlider('#s-temp2', 'temperature');
    bindSlider('#s-topn', 'rerankTopN');
    $('#sw-validate').addEventListener('click', function () {
      S.config.enableValidation = !S.config.enableValidation;
      syncParams();
      renderTrace();
    });

    // 左栏
    $('#btn-kb-switch').addEventListener('click', function () {
      S.editingKbId = null;
      renderKbDialog();
      openOv('ov-kbs');
    });
    $('#doc-list').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        S.deletingDocId = del.dataset.del;
        var d = curDocs().filter(function (x) { return x.id === S.deletingDocId; })[0];
        $('#del-title').textContent = '删除笔记「' + (d && d.title ? d.title : '（无标题）') + '」？';
        openOv('ov-delete');
        return;
      }
      var item = e.target.closest('.doc-item');
      if (!item) return;
      var doc = curDocs().filter(function (x) { return x.id === item.dataset.id; })[0];
      if (!doc) return;
      $('#reader-title').textContent = doc.title || '（无标题）';
      $('#reader-meta').textContent = doc.createdAt.slice(0, 16).replace('T', ' ') + (doc.embedded ? ' · 已向量化' : ' · 待向量化') +
        ' · ' + doc.content.length + ' 字';
      $('#reader-content').textContent = doc.content;
      openOv('ov-reader');
    });
    $('#del-confirm').addEventListener('click', function () {
      var id = S.deletingDocId;
      S.docs[S.kbId] = curDocs().filter(function (x) { return x.id !== id; });
      S.deletingDocId = null;
      closeOv('ov-delete');
      renderDocs();
    });
    $('#del-cancel').addEventListener('click', function () { closeOv('ov-delete'); });
    $('#btn-upload').addEventListener('click', function () { $('#file-input').click(); });
    $('#file-input').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (f) handleFile(f);
      this.value = '';
    });
    $('#btn-clip-toggle').addEventListener('click', function () {
      var form = $('#clip-form');
      var show = form.classList.contains('hidden');
      form.classList.toggle('hidden', !show);
      this.setAttribute('aria-expanded', show ? 'true' : 'false');
      if (show) $('#clip-url').focus();
    });
    $('#clip-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('#clip-url').value;
      $('#clip-url').value = '';
      $('#clip-form').classList.add('hidden');
      $('#btn-clip-toggle').setAttribute('aria-expanded', 'false');
      submitClip(v);
    });
    $('#clip-url').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { $('#clip-form').classList.add('hidden'); this.value = ''; }
    });
    $('#btn-queue').addEventListener('click', function () {
      renderQueue();
      S.queueOpen = true;
      openOv('ov-queue');
    });
    $('#queue-list').addEventListener('click', function (e) {
      var c = e.target.closest('[data-clip-cancel]');
      if (c) {
        var t = S.clipTasks.filter(function (x) { return x.task_id === c.dataset.clipCancel; })[0];
        if (t) { t.cancel_requested = true; renderQueue(); }
        return;
      }
      var r = e.target.closest('[data-clip-retry]');
      if (r) {
        var old = S.clipTasks.filter(function (x) { return x.task_id === r.dataset.clipRetry; })[0];
        if (!old) return;
        S.retried[old.task_id] = true;
        submitClip(old.url);
        renderQueue();
        return;
      }
      var d = e.target.closest('[data-clip-dismiss]');
      if (d) {
        S.clipTasks = S.clipTasks.filter(function (x) { return x.task_id !== d.dataset.clipDismiss; });
        renderQueue(); renderQueueBtn();
        return;
      }
      if (e.target.closest('[data-toggle="show-all"]')) {
        S.showAllFinished = !S.showAllFinished;
        renderQueue();
      }
    });

    // 知识库弹窗
    $('#kb-list').addEventListener('click', function (e) {
      var edit = e.target.closest('[data-kb-edit]');
      if (edit) {
        S.editingKbId = S.editingKbId === edit.dataset.kbEdit ? null : edit.dataset.kbEdit;
        renderKbDialog();
        return;
      }
      var use = e.target.closest('[data-kb-use]');
      if (use) { switchKb(use.dataset.kbUse); renderKbDialog(); return; }
      var row = e.target.closest('[data-kb]');
      if (row) { switchKb(row.dataset.kb); closeOv('ov-kbs'); }
    });
    $('#btn-create-kb').addEventListener('click', function () {
      var name = $('#new-kb-name').value.trim();
      if (!name) { toast('名称不能为空'); return; }
      var id = 'kb_' + S.kbs.length;
      var emb = $('#new-kb-emb').value ? $('#new-kb-emb').value.split('|') : [null, ''];
      S.kbs.push({
        kbId: id, name: name,
        description: $('#new-kb-desc').value.trim(),
        suggestions: $('#new-kb-sug').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4),
        embedding: { endpointId: emb[0], model: emb[1] },
        chunking: { maxChars: Number($('#new-kb-max').value) || 600, overlap: Number($('#new-kb-overlap').value) || 0 }
      });
      S.docs[id] = [];
      $('#new-kb-name').value = ''; $('#new-kb-desc').value = ''; $('#new-kb-sug').value = '';
      switchKb(id);
      renderKbDialog();
    });
    $('#btn-save-kb').addEventListener('click', function () {
      var k = S.kbs.filter(function (x) { return x.kbId === S.editingKbId; })[0];
      if (!k) return;
      k.name = $('#kb-edit-name').value.trim() || k.name;
      k.description = $('#kb-edit-desc').value.trim();
      k.suggestions = $('#kb-edit-sug').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 4);
      var emb = $('#kb-edit-emb').value ? $('#kb-edit-emb').value.split('|') : [null, ''];
      k.embedding = { endpointId: emb[0], model: emb[1] };
      k.chunking = { maxChars: Number($('#kb-edit-max').value) || k.chunking.maxChars, overlap: Number($('#kb-edit-overlap').value) || 0 };
      renderKbDialog(); renderKbHead(); renderChat(); renderModelDialog();
      toast('已保存：' + k.name);
    });
    $('#btn-delete-kb').addEventListener('click', function () {
      var id = S.editingKbId;
      if (id === 'default') { toast('默认知识库不能删除'); return; }
      S.kbs = S.kbs.filter(function (k) { return k.kbId !== id; });
      delete S.docs[id];
      S.editingKbId = null;
      if (S.kbId === id) switchKb('default');
      renderKbDialog();
    });
    $('#btn-reembed-kb').addEventListener('click', function () {
      var id = S.editingKbId;
      var docs = S.docs[id] || [];
      var line = $('#reembed-status');
      line.classList.remove('hidden');
      var i = 0;
      var timer = setInterval(function () {
        i += 1;
        if (i > docs.length) {
          clearInterval(timer);
          line.textContent = '重新嵌入 completed · ' + docs.length + '/' + docs.length + ' 条';
          S.banner = '';
          renderBanner(); renderDocs(); renderKbDialog();
          return;
        }
        docs[i - 1].embedded = true;
        line.textContent = '重新嵌入 running · ' + i + '/' + docs.length + ' 条已落盘';
        S.banner = '重新嵌入进行中（' + i + '/' + docs.length + '），每批即时落盘';
        renderBanner();
        if (id === S.kbId) renderDocs();
      }, 900);
    });

    // 配置模型
    $('#ep-list').addEventListener('click', function (e) {
      var fetchBtn = e.target.closest('[data-ep-fetch]');
      if (fetchBtn) {
        var id = fetchBtn.dataset.epFetch;
        setEpStatus('正在获取模型列表…');
        setTimeout(function () {
          var list = modelsOf(id);
          setEpStatus(list.length ? '端点返回 ' + list.length + ' 个模型：' + list.join('、') : '端点可达，但未返回任何模型');
        }, 600);
        return;
      }
      var edit = e.target.closest('[data-ep-edit]');
      if (edit) { S.editingEpId = edit.dataset.epEdit; renderModelDialog(); return; }
      var del = e.target.closest('[data-ep-del]');
      if (del) {
        var delId = del.dataset.epDel;
        S.endpoints = S.endpoints.filter(function (x) { return x.id !== delId; });
        var dead = [];
        ['intent', 'rerank', 'generate', 'validate'].forEach(function (key) {
          if (S.config.stages[key] && S.config.stages[key].endpointId === delId) {
            S.config.stages[key] = { endpointId: null, model: '' };
            dead.push({ intent: '意图识别', rerank: '重排', generate: '生成', validate: '校验' }[key]);
          }
        });
        if (dead.length) S.banner = '以下阶段指向刚删除的端点，已置为未配置：' + dead.join('、') + '。未配置的阶段走规则兜底或单路检索。';
        renderBanner(); renderModelDialog();
        return;
      }
    });
    function setEpStatus(msg) {
      var el = $('#ep-status');
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    $('#btn-save-ep').addEventListener('click', function () {
      var name = $('#ep-name').value.trim() || '未命名端点';
      var protocol = $('#ep-protocol').value;
      var base = $('#ep-base').value.trim();
      if (!base) { setEpStatus('Base URL 不能为空'); return; }
      var key = $('#ep-key').value.trim();
      if (S.editingEpId) {
        var ep = S.endpoints.filter(function (x) { return x.id === S.editingEpId; })[0];
        if (ep) {
          ep.name = name; ep.protocol = protocol; ep.baseUrl = base;
          if (key) ep.hasKey = true;
        }
        S.editingEpId = null;
      } else {
        var id = 'ep_' + Date.now().toString(36);
        S.endpoints.push({ id: id, name: name, protocol: protocol, baseUrl: base, hasKey: !!key });
        S.modelsByEndpoint = S.modelsByEndpoint || {};
        S.modelsByEndpoint[id] = [];
      }
      renderModelDialog();
      setEpStatus('已保存。新端点尚未探测，点「获取模型」看返回哪些模型。');
    });
    $('#btn-cancel-ep').addEventListener('click', function () { S.editingEpId = null; renderModelDialog(); });
    $('#stage-rows').addEventListener('change', function (e) {
      var ep = e.target.closest('[data-stage-ep]');
      if (ep) {
        S.config.stages[ep.dataset.stageEp] = { endpointId: ep.value || null, model: '' };
        renderModelDialog();
        return;
      }
      var md = e.target.closest('[data-stage-model]');
      if (md) {
        var key = md.dataset.stageModel;
        S.config.stages[key] = { endpointId: S.config.stages[key].endpointId, model: md.value };
      }
    });
    $('#btn-open-prompts').addEventListener('click', function () { renderPromptDialog(); openOv('ov-prompts'); });
    $('#btn-save-prompt').addEventListener('click', function () {
      S.prompts.system = $('#prompt-main').value;
      closeOv('ov-prompts');
      toast('已保存全局提示词（原型仅本页生效）');
    });

    // 演示分支
    $('#demo-chips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-branch]');
      if (!b || S.streaming) return;
      var branch = BRANCHES.filter(function (x) { return x.mode === b.dataset.branch; })[0];
      if (branch) send(branch.q, branch.mode);
    });
    $('#btn-reset').addEventListener('click', function () {
      if (S.streaming) stop();
      S.messages = [];
      S.trace = null;
      S.forced = null;
      renderChat(); renderTrace(); renderBranches();
    });
    $('#btn-collapse').addEventListener('click', function () {
      $('#col-right').classList.add('collapsed');
      $('#col-right').classList.remove('open');
      $('#btn-expand').classList.remove('hidden');
      $('#backdrop').classList.add('hidden');
    });
    $('#btn-expand').addEventListener('click', function () {
      $('#col-right').classList.remove('collapsed');
      $('#btn-expand').classList.add('hidden');
    });

    // 对话
    $('#chat-list').addEventListener('click', function (e) {
      var th = e.target.closest('[data-think]');
      if (th) {
        var i = Number(th.dataset.think);
        S.messages[i].thinkOpen = !S.messages[i].thinkOpen;
        renderChat();
        return;
      }
      var cite = e.target.closest('.cite[data-id]');
      if (cite) {
        var target = document.getElementById('src-' + cite.dataset.id);
        if (target) {
          $('#col-right').classList.remove('collapsed');
          $('#btn-expand').classList.add('hidden');
          if (window.innerWidth < 1280) { $('#col-right').classList.add('open'); $('#backdrop').classList.remove('hidden'); }
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(function () { target.classList.remove('flash'); }, 1200);
        }
      }
    });
    $('#chat-list').addEventListener('mouseover', function (e) {
      var cite = e.target.closest('.cite[data-id]');
      if (cite) showHover(cite);
    });
    $('#chat-list').addEventListener('mouseout', function (e) {
      if (e.target.closest('.cite[data-id]')) hideHover();
    });

    var input = $('#ask-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitComposer();
      }
    });
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(144, Math.max(44, this.scrollHeight)) + 'px';
    });
    $('#btn-send').addEventListener('click', function () {
      if (S.streaming) { stop(); return; }
      submitComposer();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeTopOv();
    });
    $all('.overlay').forEach(function (ov) {
      ov.addEventListener('click', function (e) {
        if (e.target === ov || e.target.closest('[data-close]')) {
          if (ov.id === 'ov-queue') S.queueOpen = false;
          closeOv(ov.id);
        }
      });
    });
  }

  function submitComposer() {
    var v = $('#ask-input').value.trim();
    if (!v || S.streaming) return;
    $('#ask-input').value = '';
    $('#ask-input').style.height = '44px';
    send(v);
  }

  function switchKb(id) {
    S.kbId = id;
    S.queueOpen = false;
    if (S.queueOpen) closeOv('ov-queue');
    // 任务按库归属，跨库显示会误导：切库收起队列
    var ov = $('#ov-queue');
    if (!ov.classList.contains('hidden')) closeOv('ov-queue');
    S.queueOpen = false;
    renderKbHead(); renderDocs(); renderChat(); renderQueueBtn(); renderQueue();
    if ($('#ov-models') && !$('#ov-models').classList.contains('hidden')) renderModelDialog();
  }

  /* ── 启动 ───────────────────────────────────────── */
  hydrateIcons();
  syncParams();
  renderSendBtn();
  renderKbHead();
  renderDocs();
  renderChat();
  renderTrace();
  renderQueueBtn();
  renderBranches();
  renderBanner();
  wire();
  // 演示脚本与自动化走查用的句柄（不影响界面）
  window.Kraq = { state: S, send: send, stop: stop, switchKb: switchKb, submitClip: submitClip };
  $('#ask-input').focus();
})();
