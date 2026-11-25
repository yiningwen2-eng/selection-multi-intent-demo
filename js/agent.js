/* agent.js — 灵犀 Agent 侧边栏：欢迎区 / 对话区 / 输入区 + 剧本播放引擎。
   对话动效复刻 cowork（流式输出、shimmer、思考折叠、工作中指示器），vanilla JS 实现。

   会话状态：Agent.sessions[tabId]，切换 doc tab 后再切回来对话还在。
   session = { type, tabId, collapsed, processing, playId, messages: [...], view }
   message = { role:'user', text } | { role:'ai', streaming, steps: [...] }
   step    = { type, content, toolName?, action?, shown, phase: 'active'|'done', ui?: {...DOM 引用} }
   action  = 剧本 tool_call 步骤的可选字段（见 mock/agent-scripts.js）：该步骤完成（shimmer 停留
             结束）的那一刻交给 editor-api.js 的 EditorAPI.apply 执行，让画布真实变化。

   实现要点（改这里时保持）：
   - 播放循环只往「当前最后一步」的文本节点增量追加（step.shown → ui.textEl.textContent），
     其余步骤完成时一次性插入，不整段重建 DOM。
   - 切 tab 会卸载 DOM（session.view=null），播放循环改走「纯数据模式」；
     切回来重挂载时按数据重建，并把进行中的步骤 DOM 引用重新接回 step.ui，流式续播不断。 */
(function () {
  'use strict';

  var Agent = window.Agent = { sessions: {} };

  var COMP_LABEL = { wps: '文字', wpp: '演示', et: '表格', pdf: 'PDF' };

  /* ── 动效参数（改这里：节奏快慢都调这段） ── */
  var TYPE_CHARS = 2;                 // 正文每次追加字符数
  var typeDelay = function () { return 18 + Math.random() * 12; };   // 正文逐字间隔 ms
  var toolDelay = function (text) {   // tool_call 停留时长 clamp(字符数*50, 800, 3000)
    return Math.min(3000, Math.max(800, text.length * 50));
  };
  var GAP = 240;                      // 步骤之间的停顿 ms

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ════════════ 视图 =========═══ */

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  /* 挂载 / 重挂载侧边栏（editors.js 每次渲染编辑器时调用） */
  Agent.mount = function (aside, tab) {
    var s = sessionOf(tab);
    var conf = window.AGENT_SCRIPTS[tab.type];
    var view = {
      aside: aside,
      body: null, welcomeEl: null, msgsEl: null, anchor: null,
      input: null, send: null,
    };
    s.view = view;

    aside.className = 'agent-sidebar' + (s.collapsed ? ' is-collapsed' : '');
    aside.innerHTML =
      '<div class="ag-inner">' +
        '<div class="ag-head">' +
          '<span class="ag-title">灵犀</span>' +
          '<span class="ag-tag">' + COMP_LABEL[tab.type] + '</span>' +
          '<div class="ag-head-btns">' +
            '<button type="button" class="ag-icon-btn" data-act="new" title="新建对话">' + icon('bubble_add_three', 16) + '</button>' +
            '<button type="button" class="ag-icon-btn" data-act="history" title="历史记录（仅视觉）">' + icon('clock', 16) + '</button>' +
            '<button type="button" class="ag-icon-btn" data-act="more" title="更多（仅视觉）">' + icon('more', 16) + '</button>' +
            '<button type="button" class="ag-icon-btn" data-act="collapse" title="折叠侧边栏">' + icon('arrow_right_double_s', 16) + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="ag-body"></div>' +
        '<div class="ag-foot">' +
          '<div class="ag-input-card">' +
            '<textarea class="ag-input" rows="2" placeholder="请输入任务，交给我来帮你完成"></textarea>' +
            '<div class="ag-input-row">' +
              '<button type="button" class="ag-icon-btn" title="附件（仅视觉）" aria-label="添加附件">' + icon('insert', 16) + '</button>' +
              '<button type="button" class="ag-icon-btn" title="AI 技能（仅视觉）">' + icon('ai_stick_gradient', 16) + '</button>' +
              '<span class="ag-mode">Max 模式 ' + icon('arrow_down_s', 16) + '</span>' +
              '<button type="button" class="ag-send" title="发送" aria-label="发送" disabled>' + icon('paper_plane', 16) + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="ag-disclaimer">内容由 AI 生成</div>' +
        '</div>' +
      '</div>';

    view.body = aside.querySelector('.ag-body');
    view.input = aside.querySelector('.ag-input');
    view.send = aside.querySelector('.ag-send');

    /* 对话区：无消息 → 欢迎区；有消息 → 按数据重建 */
    if (s.messages.length === 0) {
      view.welcomeEl = el(
        '<div class="ag-welcome">' +
          '<div class="ag-mascot">' + icon('lingxi_logo_m', 48) + '</div>' +
          '<h3>' + conf.welcome + '</h3>' +
          '<div class="ag-try">你可以试试</div>' +
        '</div>');
      conf.cards.forEach(function (c) {
        var card = el(
          '<div class="ag-card">' +
            '<span class="ag-card-icon">' + icon(c.icon, 16) + '</span>' +
            '<span class="ag-card-title">' + c.title + '</span>' +
            '<span class="ag-card-desc">' + c.desc + '</span>' +
          '</div>');
        // 点卡片 = 把标题作为用户消息发送
        card.addEventListener('click', function () { send(s, c.title); });
        view.welcomeEl.appendChild(card);
      });
      view.body.appendChild(view.welcomeEl);
    } else {
      view.msgsEl = el('<div class="ag-msgs"></div>');
      view.anchor = el('<div class="ag-anchor"></div>');
      view.body.appendChild(view.msgsEl);
      view.body.appendChild(view.anchor);
      s.messages.forEach(function (m) { view.msgsEl.appendChild(buildMsg(s, m)); });
      updateWorking(s, s.messages[s.messages.length - 1]);
      scrollToEnd(s, true);
    }

    syncInput(s);

    /* ── 事件 ── */
    aside.querySelector('[data-act="new"]').addEventListener('click', function () { newChat(s); });
    aside.querySelector('[data-act="collapse"]').addEventListener('click', function () { Agent.toggle(); });

    view.input.addEventListener('input', function () {
      view.send.disabled = s.processing || !view.input.value.trim();
    });
    view.input.addEventListener('keydown', function (e) {
      // Enter 发送，Shift+Enter 换行；isComposing 防中文输入法误发
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        trySend(s);
      }
    });
    view.send.addEventListener('click', function () { trySend(s); });
  };

  /* 折叠 / 展开（#btn-lingxi 与栏内折叠按钮共用） */
  Agent.toggle = function () {
    var tab = App.tabs.filter(function (t) { return t.id === App.activeId; })[0];
    if (!tab) return;
    var s = sessionOf(tab);
    s.collapsed = !s.collapsed;
    if (s.view) s.view.aside.classList.toggle('is-collapsed', s.collapsed);
  };

  function sessionOf(tab) {
    if (!Agent.sessions[tab.id]) {
      Agent.sessions[tab.id] = {
        type: tab.type, tabId: tab.id, collapsed: true, processing: false, playId: 0,
        messages: [], view: null,
      };
    }
    return Agent.sessions[tab.id];
  }

  /* ════ 给文内 LUI（lui.js）复用的能力 ════ */

  /* 动效节奏参数/函数（文内过程面板与侧边栏保持同一套节奏） */
  Agent.utils = { sleep: sleep, typeDelay: typeDelay, toolDelay: toolDelay, GAP: GAP, TYPE_CHARS: TYPE_CHARS };

  /* 侧边栏当前是否展开（lui.js 分流依据：展开 → 任务直接走侧边栏 send 路径） */
  Agent.isOpen = function () {
    var tab = App.tabs.filter(function (t) { return t.id === App.activeId; })[0];
    return !!tab && !sessionOf(tab).collapsed;
  };

  /* 文内 LUI 分流入口：等价于用户在侧边栏输入 text 并发送。
     ctx = 唤起时的选区/光标上下文（文内划词→侧边栏链路带来），播放时 action 坐标注入用 */
  Agent.sendText = function (tabId, text, ctx) {
    var tab = App.tabs.filter(function (t) { return t.id === tabId; })[0];
    if (!tab || !text) return;
    send(sessionOf(tab), text, ctx);
  };

  /* 文内完成的任务沉淀进会话：追加一条 user 消息 + 一条已完成 ai 消息
     （tool_call 步骤在渲染时被 applyCollapse 折叠成「已执行 N 次命令 ›」摘要），
     无会话则按 sessionOf 创建；侧边栏已挂载则同步追加 DOM，切 tab 重挂载按数据重建。 */
  Agent.record = function (tabId, rec) {
    var tab = App.tabs.filter(function (t) { return t.id === tabId; })[0];
    if (!tab) return;
    var s = sessionOf(tab);
    var steps = (rec.stepLabels || []).map(function (c) {
      return { type: 'tool_call', content: c, shown: '', phase: 'done' };
    });
    steps.push({ type: 'done', content: rec.resultText, shown: rec.resultText, phase: 'done' });
    var um = { role: 'user', text: rec.userText };
    var am = { role: 'ai', streaming: false, steps: steps };
    s.messages.push(um, am);
    if (s.view) {
      ensureMsgs(s);
      s.view.msgsEl.appendChild(userMsg(um));
      s.view.msgsEl.appendChild(aiMsg(s, am));
      scrollToEnd(s, true);
    }
  };

  /* ════════════ 消息渲染 =========== */

  function buildMsg(s, m) {
    if (m.role === 'user') return userMsg(m);
    return aiMsg(s, m);
  }

  function userMsg(m) {
    var node = el('<div class="ag-msg-user"><div class="ag-bubble"></div></div>');
    node.querySelector('.ag-bubble').textContent = m.text;
    return node;
  }

  /* AI 消息容器：步骤逐个 append；末尾是「灵犀工作中」指示器 */
  function aiMsg(s, m) {
    var box = el('<div class="ag-msg-ai"></div>');
    m.stepsEl = box;
    m.steps.forEach(function (step) { box.appendChild(buildStep(s, step, m)); });
    m.workingEl = el(
      '<div class="ag-working" hidden>' +
        '<span class="ag-star">' + icon('animation_path_four_pointed_star_display', 16) + '</span>' +
        '<span class="ag-working-text ag-shimmer">灵犀工作中</span>' +
      '</div>');
    box.appendChild(m.workingEl);
    /* 已完成的历史消息：重建时直接套折叠组（切 tab 重渲染后仍保持折叠态）；
       groupEl 是旧 DOM 引用，重建前清掉再重新分组 */
    m.groupEl = null;
    if (!m.streaming) {
      applyCollapse(m);
      if (s.type === 'et' && m.ctx) box.appendChild(etResultActions(s, m));
    }
    return box;
  }

  /* 10 月表格链路：完成态使用轻量反馈工具栏，不在画布上生成决策条。 */
  function etResultActions(s, msg) {
    var node = el('<div class="ag-et-actions" role="toolbar" aria-label="回答操作">' +
      '<div class="ag-et-actions-group">' +
        '<button type="button" data-act="copy" aria-label="复制">' + icon('copy', 16) + '</button>' +
        '<button type="button" data-act="like" aria-label="赞" aria-pressed="' + (msg.feedback === 'like') + '">' + icon('gesture_thumb', 16) + '</button>' +
        '<button type="button" data-act="dislike" aria-label="踩" aria-pressed="' + (msg.feedback === 'dislike') + '">' + icon('gesture_thumb_down', 16) + '</button>' +
        '<button type="button" data-act="read" aria-label="朗读" aria-pressed="false">' + icon('doc_voice_reading', 16) + '</button>' +
      '</div>' +
      '<span class="ag-et-actions-sep" aria-hidden="true"></span>' +
      '<button type="button" data-act="regenerate" aria-label="重新生成">' + icon('arrow_revoke', 16) + '</button>' +
      '</div>');
    if (msg.feedback) node.querySelector('[data-act="' + msg.feedback + '"]').classList.add('is-active');

    node.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'copy') {
        copyAnswerText(answerText(msg));
        btn.setAttribute('aria-label', '已复制');
        setTimeout(function () { if (btn.isConnected) btn.setAttribute('aria-label', '复制'); }, 1200);
      } else if (act === 'like' || act === 'dislike') {
        msg.feedback = msg.feedback === act ? '' : act;
        Array.prototype.forEach.call(node.querySelectorAll('[data-act="like"], [data-act="dislike"]'), function (feedbackBtn) {
          var active = feedbackBtn.getAttribute('data-act') === msg.feedback;
          feedbackBtn.classList.toggle('is-active', active);
          feedbackBtn.setAttribute('aria-pressed', String(active));
        });
      } else if (act === 'read') {
        toggleReadAnswer(btn, answerText(msg));
      } else if (act === 'regenerate') {
        regenerateAnswer(s, msg);
      }
    });
    return node;
  }

  function answerText(msg) {
    return msg.steps.filter(function (step) { return step.type === 'done' || step.type === 'understanding'; })
      .map(function (step) { return step.content; }).join('\n');
  }

  function copyAnswerText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { copyAnswerTextFallback(text); });
      return;
    }
    copyAnswerTextFallback(text);
  }

  function copyAnswerTextFallback(text) {
    var area = el('<textarea aria-hidden="true"></textarea>');
    area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
  }

  function toggleReadAnswer(btn, text) {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance || !text) return;
    if (btn.classList.contains('is-active')) {
      window.speechSynthesis.cancel(); btn.classList.remove('is-active'); btn.setAttribute('aria-pressed', 'false'); return;
    }
    window.speechSynthesis.cancel();
    var utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.onend = utterance.onerror = function () {
      if (btn.isConnected) { btn.classList.remove('is-active'); btn.setAttribute('aria-pressed', 'false'); }
    };
    btn.classList.add('is-active'); btn.setAttribute('aria-pressed', 'true');
    window.speechSynthesis.speak(utterance);
  }

  function regenerateAnswer(s, msg) {
    if (s.processing) return;
    var index = s.messages.indexOf(msg);
    var previous = index > 0 ? s.messages[index - 1] : null;
    if (!previous || previous.role !== 'user') return;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    var oldBox = msg.stepsEl;
    msg.streaming = true; msg.steps = []; msg.feedback = '';
    if (oldBox && oldBox.isConnected) oldBox.replaceWith(aiMsg(s, msg));
    s.processing = true; syncInput(s); updateWorking(s, msg);
    play(s, msg, route(s.type, previous.text));
  }

  /* 单个步骤 DOM；进行中的步骤把引用挂到 step.ui 供增量追加 */
  function buildStep(s, step, msg) {
    var last = msg.steps[msg.steps.length - 1] === step;
    var streaming = msg.streaming && step.phase === 'active';

    if (step.type === 'thinking') {
      var open = streaming; // 流式中展开「思考中…」，否则收起「思考已完成 ›」
      var node = el(
        '<div class="ag-step ag-step-thinking">' +
          '<span class="ag-thinking-head">' +
            '<span class="ag-th-label"></span>' +
            '<span class="ag-th-caret"></span>' +
          '</span>' +
          '<div class="ag-thinking-body"></div>' +
        '</div>');
      var body = node.querySelector('.ag-thinking-body');
      body.textContent = step.shown;
      var paint = function () {
        node.querySelector('.ag-th-label').textContent = open ? '思考中…' : '思考已完成';
        node.querySelector('.ag-th-caret').innerHTML = icon(open ? 'arrow_down_s' : 'arrow_right_s', 12);
        body.hidden = !open;
      };
      paint();
      node.querySelector('.ag-thinking-head').addEventListener('click', function () {
        open = !open; paint();
      });
      if (streaming) step.ui = { textEl: body, dotHost: body, collapse: function () { open = false; paint(); } };
      return node;
    }

    if (step.type === 'tool_call') {
      var t = el(
        '<div class="ag-step">' +
          '<div class="ag-tool">' +
            '<span class="ag-tool-rail">' +
              '<span class="ag-tool-icon">' + icon('equipment_computer', 14) + '</span>' +
              (last ? '' : '<span class="ag-tool-line"></span>') +
            '</span>' +
            '<span class="ag-tool-text"></span>' +
          '</div>' +
        '</div>');
      var tt = t.querySelector('.ag-tool-text');
      tt.textContent = step.content;
      if (streaming) tt.classList.add('ag-shimmer');
      return t;
    }

    /* understanding / done：正文流式 */
    var p = el('<div class="ag-step"><div class="ag-text"></div></div>');
    var textEl = p.querySelector('.ag-text');
    textEl.textContent = step.shown;
    if (streaming) step.ui = { textEl: textEl, dotHost: textEl };
    return p;
  }

  /* 「灵犀工作中」：仅流式中且最后一步还没文字内容时显示（避免双 loading；
     tool_call 一出现就自带 shimmer，算「已有内容」） */
  function updateWorking(s, msg) {
    if (!msg || !msg.workingEl) return;
    var last = msg.steps[msg.steps.length - 1];
    var contentShown = last && (last.type === 'tool_call' || last.shown.length > 0);
    msg.workingEl.hidden = !(msg.streaming && !contentShown);
  }

  function scrollToEnd(s, instant) {
    if (!s.view || !s.view.anchor) return;
    s.view.anchor.scrollIntoView({ behavior: instant ? 'auto' : 'smooth' });
  }

  /* 输入区状态：处理中 → disabled + placeholder 变「正在处理中…」 */
  function syncInput(s) {
    if (!s.view) return;
    s.view.input.disabled = s.processing;
    s.view.input.placeholder = s.processing ? '正在处理中…' : '请输入任务，交给我来帮你完成';
    s.view.send.disabled = s.processing || !s.view.input.value.trim();
  }

  /* ════════════ 发送与播放 =========== */

  function trySend(s) {
    var text = (s.view ? s.view.input.value : '').trim();
    if (!text || s.processing) return;
    send(s, text);
  }

  /* 欢迎区 → 对话区（send / Agent.record 共用）：确保 view.msgsEl/anchor 存在 */
  function ensureMsgs(s) {
    if (!s.view || s.view.msgsEl) return;
    if (s.view.welcomeEl) { s.view.welcomeEl.remove(); s.view.welcomeEl = null; }
    s.view.msgsEl = el('<div class="ag-msgs"></div>');
    s.view.anchor = el('<div class="ag-anchor"></div>');
    s.view.body.appendChild(s.view.msgsEl);
    s.view.body.appendChild(s.view.anchor);
  }

  function send(s, text, ctx) {
    if (s.processing) return;
    s.processing = true;

    ensureMsgs(s); // 欢迎区 → 对话区
    if (s.view) { s.view.input.value = ''; }

    var um = { role: 'user', text: text };
    var am = { role: 'ai', streaming: true, steps: [], ctx: ctx || null }; // ctx: 文内剧本 action 坐标注入用
    s.messages.push(um, am);
    if (s.view) {
      s.view.msgsEl.appendChild(userMsg(um));
      s.view.msgsEl.appendChild(aiMsg(s, am));
    }
    updateWorking(s, am);
    syncInput(s);
    scrollToEnd(s, true);

    play(s, am, route(s.type, text));
  }

  /* 关键词路由：命中剧本；否则兜底（改这里：匹配规则）。
     AGENT_SCRIPTS 未命中时继续匹配 LUI_SCRIPTS 文内剧本（文内能跑的指令侧边栏也能跑；
     带 action 的步骤照常经 EditorAPI.apply 真实改文档，坐标由 apply 注入 msg.ctx 或现取光标） */
  function route(type, text) {
    var conf = window.AGENT_SCRIPTS[type];
    var lower = text.toLowerCase();
    var i, j, sc;
    for (i = 0; i < conf.scripts.length; i++) {
      sc = conf.scripts[i];
      for (j = 0; j < sc.match.length; j++) {
        if (lower.indexOf(sc.match[j].toLowerCase()) >= 0) return sc;
      }
    }
    var luiConf = window.LUI_SCRIPTS && window.LUI_SCRIPTS[type];
    if (luiConf) {
      for (i = 0; i < luiConf.scripts.length; i++) {
        sc = luiConf.scripts[i];
        for (j = 0; j < sc.match.length; j++) {
          if (lower.indexOf(sc.match[j].toLowerCase()) >= 0) return sc;
        }
      }
    }
    return conf.fallback;
  }

  /* 播放引擎：逐条播放步骤。playId 用于「新建对话」打断在播的流。 */
  async function play(s, msg, script) {
    var id = ++s.playId;
    var alive = function () { return s.playId === id; };

    for (var i = 0; i < script.steps.length; i++) {
      if (!alive()) return;
      var def = script.steps[i];
      /* 文内剧本的 ask 澄清步骤在侧边栏降级为正文（选项平铺成文本，交互只在文内面板有） */
      if (def.type === 'ask') {
        def = { type: 'understanding', content: def.content + '\n' + def.options.map(function (o, j) {
          return (j + 1) + '. ' + o.label + (o.desc ? '：' + o.desc : '');
        }).join('\n') };
      }
      var step = { type: def.type, content: def.content, toolName: def.toolName, action: def.action, shown: '', phase: 'active' };
      msg.steps.push(step);
      if (s.view) {
        // 插到「工作中」指示器前面；新步骤出现后重算各 tool_call 的竖线/ shimmer 归属
        msg.stepsEl.insertBefore(buildStep(s, step, msg), msg.workingEl);
        refreshToolRails(msg);
      }
      updateWorking(s, msg);
      scrollToEnd(s);

      if (step.type === 'tool_call') {
        await sleep(toolDelay(step.content));
        if (!alive()) return;
        // 剧本带 action：shimmer 停留结束 = 步骤完成，这一刻让画布真实变化（editor-api.js；msg.ctx 注入坐标）
        if (step.action && window.EditorAPI) await EditorAPI.apply(s.tabId, step.action, msg.ctx);
      } else {
        await typewrite(s, msg, step, alive);
        if (!alive()) return;
        if (step.type === 'thinking' && step.ui && step.ui.collapse) step.ui.collapse();
      }
      step.phase = 'done';
      step.ui = null;
      if (s.view) refreshToolRails(msg);
      updateWorking(s, msg);
      await sleep(GAP);
    }

    msg.streaming = false;
    s.processing = false;
    updateWorking(s, msg);
    syncInput(s);
    if (s.type === 'et' && msg.ctx && s.view && msg.stepsEl && !msg.stepsEl.querySelector('.ag-et-actions')) {
      msg.stepsEl.appendChild(etResultActions(s, msg));
    }
    /* 生成完成：done 之前的步骤自动折叠成「已执行 N 次命令、M 次搜索 ›」摘要（collapse-all） */
    if (s.view) applyCollapse(msg);
    scrollToEnd(s);
  }

  /* 逐字流式：每帧 TYPE_CHARS 个字符，只追加当前步骤的文本节点 */
  async function typewrite(s, msg, step, alive) {
    var dot = null;
    while (step.shown.length < step.content.length) {
      if (!alive()) return;
      step.shown = step.content.slice(0, step.shown.length + TYPE_CHARS);
      if (step.ui && step.ui.textEl) {
        step.ui.textEl.textContent = step.shown;
        if (!dot) { dot = el('<span class="ag-dot"></span>'); }
        step.ui.dotHost.appendChild(dot); // 光标始终跟在文字尾部
      }
      updateWorking(s, msg); // 文字开始流出 → 工作中指示器隐藏
      scrollToEnd(s);
      await sleep(typeDelay());
    }
    if (dot) dot.remove();
  }

  /* 折叠组（collapse-all，复刻 cowork）：done 之前的 thinking/tool_call/understanding 步骤
     收拢成一行摘要「已执行 N 次命令、M 次搜索 ›」，点击展开成完整步骤静态列表，再点收起。
     统计口径：toolName === 'search' 计「搜索」，其余 tool_call 计「命令」；
     一个 tool_call 都没有时降级为「已折叠 N 个步骤」（N = 被折叠的步骤数）。
     播放收尾与历史消息重建共用；msg.groupOpen 记展开态，切 tab 重渲染后保持。
     （改这里：摘要文案 / 统计口径） */
  function applyCollapse(msg) {
    if (!msg.stepsEl || msg.groupEl) return;
    /* 找最后一条 done；done 之前没有步骤就不折叠 */
    var doneIdx = -1;
    for (var i = msg.steps.length - 1; i >= 0; i--) {
      if (msg.steps[i].type === 'done') { doneIdx = i; break; }
    }
    if (doneIdx <= 0) return;

    var cmds = 0, searches = 0;
    for (i = 0; i < doneIdx; i++) {
      var st = msg.steps[i];
      if (st.type !== 'tool_call') continue;
      if (st.toolName === 'search') searches++; else cmds++;
    }
    var summary;
    if (cmds + searches === 0) {
      summary = '已折叠 ' + doneIdx + ' 个步骤';
    } else {
      var parts = [];
      if (cmds) parts.push(cmds + ' 次命令');
      if (searches) parts.push(searches + ' 次搜索');
      summary = '已执行 ' + parts.join('、');
    }

    var group = el(
      '<div class="ag-collapse-group">' +
        '<div class="ag-collapse-head">' +
          '<span class="ag-collapse-text"></span>' +
          '<span class="ag-collapse-caret"></span>' +
        '</div>' +
        '<div class="ag-collapse-body"></div>' +
      '</div>');
    group.querySelector('.ag-collapse-text').textContent = summary;

    /* 把 done 之前的步骤节点原样挪进折叠体（完成态静态渲染，无 shimmer/光标） */
    var body = group.querySelector('.ag-collapse-body');
    var nodes = msg.stepsEl.querySelectorAll('.ag-step');
    for (i = 0; i < doneIdx; i++) body.appendChild(nodes[i]);
    msg.stepsEl.insertBefore(group, nodes[doneIdx]);

    var caret = group.querySelector('.ag-collapse-caret');
    var paint = function () {
      caret.innerHTML = icon(msg.groupOpen ? 'arrow_down_s' : 'arrow_right_s', 12);
      body.hidden = !msg.groupOpen;
    };
    paint();
    group.querySelector('.ag-collapse-head').addEventListener('click', function () {
      msg.groupOpen = !msg.groupOpen; paint();
    });
    msg.groupEl = group;
  }

  /* tool_call 的竖线/shimmer 只保留在「非末尾」/「执行中」语义上：重挂时 cheap 重建 */
  function refreshToolRails(msg) {    if (!msg.stepsEl) return;
    var nodes = msg.stepsEl.querySelectorAll('.ag-step');
    msg.steps.forEach(function (step, i) {
      if (step.type !== 'tool_call') return;
      var node = nodes[i];
      var last = i === msg.steps.length - 1;
      var rail = node.querySelector('.ag-tool-rail');
      var line = rail.querySelector('.ag-tool-line');
      if (!last && !line) rail.appendChild(el('<span class="ag-tool-line"></span>'));
      if (last && line) line.remove();
      node.querySelector('.ag-tool-text').classList.toggle('ag-shimmer', msg.streaming && step.phase === 'active');
    });
  }

  /* 新建对话：打断在播流，清空消息回欢迎区 */
  function newChat(s) {
    s.playId++;
    s.processing = false;
    s.messages = [];
    var tab = App.tabs.filter(function (t) { return t.id === App.activeId; })[0];
    if (tab && s.view) Agent.mount(s.view.aside, tab);
  }
})();
