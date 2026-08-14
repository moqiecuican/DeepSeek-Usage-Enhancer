// ==UserScript==
// @name         DeepSeek Usage Panorama
// @name:zh-CN   DeepSeek 用量显示优化
// @namespace    https://github.com/moqiecuican/DeepSeek-Usage-Enhancer
// @version      2.1.1
// @description  在 DeepSeek 开放平台用量页注入今日数据：今日消费、今日用量、各模型今日/昨日请求数与缓存命中率（原生克隆，以假乱真）
// @author       Jmkwang, Kiming, moqiecuican
// @match        https://platform.deepseek.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/**
 * DeepSeek Usage Enhancer v2.0.0（页面注入版）
 *
 * 适配 DeepSeek 开放平台 2026-08 全新用量页：
 *   - API: /api/v0/usage/by_api_key/amount|cost + /api/v0/users/get_user_summary
 *   - 数据: series[] = api_key × model × buckets[{time, usage}]
 *   - 页面: ds-* 设计系统 + data-usage-layout-* 语义锚点
 *
 * 注入策略（以假乱真）：克隆原生卡片/指标行节点，只改文案与数值，
 * 全部样式继承原生 —— CSS Modules hash class 再变也不影响。
 * 数据完全在浏览器本地处理，不向任何第三方发送。
 */

(function () {
  'use strict';

  // ============================================================
  // 配置（集中管理 —— 与站点契约，站点改版先查这里）
  // ============================================================
  const TRACKED_ENDPOINTS = [
    '/api/v0/usage/by_api_key/amount',   // 各 API Key × 模型 的 Token/请求用量
    '/api/v0/usage/by_api_key/cost',     // 各 API Key × 模型 的费用
    '/api/v0/users/get_user_summary',    // 账户余额/累计消费
  ];

  // 注入节点标记（防止重复注入 + 定位已注入节点更新数值）
  const CARD_TODAY_COST = 'data-dsue-card-today-cost';
  const CARD_TODAY_USAGE = 'data-dsue-card-today-usage';
  const ROW_MARKER = 'data-dsue-row';

  // 文案（中文优先，英文兜底）
  const L = {
    zh: {
      todayCost: '今日消费', todayUsage: '今日用量',
      today: '今日', yesterday: '昨日', cacheHitRate: '今日缓存命中率',
      cardCost: '消费金额', cardTokens: 'Tokens',
      metricRequests: ['API 请求次数', '请求次数'], metricTokens: ['Tokens'],
    },
    en: {
      todayCost: "Today's cost", todayUsage: 'Today usage',
      today: 'Today', yesterday: 'Yesterday', cacheHitRate: "Today's cache hit rate",
      cardCost: ['Cost'], cardTokens: ['Tokens'],
      metricRequests: ['Requests', 'API Requests'], metricTokens: ['Tokens'],
    },
  };

  // ============================================================
  // 状态
  // ============================================================
  let auth = null;                                  // Authorization 头（自请求兜底用）
  const store = { amount: null, cost: null, summary: null };
  let lang = null;                                  // 页面语言（zh/en），首次注入时探测

  // ============================================================
  // 工具函数
  // ============================================================
  function log(msg) {
    console.log('[DSUE] ' + msg);
  }

  function safeJSON(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function extractBizData(json) {
    if (!json || typeof json !== 'object') return null;
    if (json.biz_data) return json.biz_data;
    if (json.data && json.data.biz_data) return json.data.biz_data;
    return null;
  }

  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(Number(n)).toLocaleString('en-US');
  }

  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    // 与官方一致：金额显示截断到 2 位小数（官方 Decimal.floor(2)），非四舍五入
    return Math.floor(Number(n) * 100) / 100 + '';
  }

  /**
   * 金额精确累加（对齐官方 Decimal 语义）。
   * cost 字符串 -> BigInt 定点（×1e8，覆盖官方 8 位小数字段）
   */
  function costToFixed(str) {
    const s = String(str ?? '0').trim();
    const neg = s.startsWith('-');
    const a = neg ? s.slice(1) : s;
    const dot = a.indexOf('.');
    const intPart = dot === -1 ? a : a.slice(0, dot);
    const fracPart = dot === -1 ? '' : a.slice(dot + 1);
    let v = BigInt(intPart || '0') * 100000000n;
    if (fracPart) v += BigInt((fracPart + '00000000').slice(0, 8));
    return neg ? -v : v;
  }

  /** 定点值 -> 显示字符串：截断到 2 位小数（对齐官方） */
  function fmtFixedCents(v) {
    const neg = v < 0n;
    const a = neg ? -v : v;
    const yuan = a / 100000000n;
    const cents = (a % 100000000n) / 1000000n;   // 截断第 3 位以后
    return (neg ? '-' : '') + yuan.toString() + '.' + cents.toString().padStart(2, '0');
  }

  function fmtRate(r) {
    if (r === null || r === undefined || isNaN(r)) return '—';
    return (r * 100).toFixed(1) + '%';
  }

  /**
   * 今日/昨日区间（与页面 h2() 同语义：本地时区，tz=整小时偏移秒数）
   * 返回 { start, end, tz } —— start=今天本地 00:00 对齐秒，end=明天 00:00
   */
  function todayRange() {
    const now = new Date();
    const tzMin = -now.getTimezoneOffset();              // 本地时区偏移分钟
    const tzSec = 3600 * Math.floor(tzMin * 60 / 3600);  // 整小时偏移（秒）
    const rem = tzMin * 60 - tzSec;                      // 分钟余数（秒）
    const ms = d => Math.floor(d.getTime() / 1000);
    const dayStart = ms(new Date(now.getFullYear(), now.getMonth(), now.getDate())) + rem;
    return { start: dayStart, end: dayStart + 86400, tz: tzSec };
  }

  function yesterdayStart() {
    return todayRange().start - 86400;
  }

  /** 响应区间是否覆盖指定秒 */
  function rangeCovers(biz, t) {
    return biz && Number.isFinite(biz.start) && Number.isFinite(biz.end)
      && biz.start <= t && t < biz.end;
  }

  // ============================================================
  // 数据变换（与 bundle 中 h0/h2/hG/mu/mf 逻辑对齐）
  // ============================================================

  /**
   * 从 amount 响应聚合「某一天」各模型指标。
   * @param {object} biz  amount 的 biz_data {start,end,bucket,models,series[]}
   * @param {number} dayStartSec  目标日 00:00（秒）
   * @returns {object} { perModel: {model: {requests, hit, miss, output, tokens, cacheHitRate}}, total: {...} }
   */
  function aggregateDay(biz, dayStartSec) {
    const dayEnd = dayStartSec + 86400;
    const perModel = {};
    const total = { requests: 0, hit: 0, miss: 0, output: 0 };
    for (const s of (biz && biz.series) || []) {
      const m = perModel[s.model] || (perModel[s.model] = { requests: 0, hit: 0, miss: 0, output: 0, tokens: 0, cacheHitRate: null });
      for (const b of s.buckets || []) {
        if (b.time < dayStartSec || b.time >= dayEnd) continue;
        const u = b.usage || {};
        const req = Number(u.REQUEST) || 0;
        const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0;
        const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0;
        const out = Number(u.RESPONSE_TOKEN) || 0;
        m.requests += req; m.hit += hit; m.miss += miss; m.output += out;
        total.requests += req; total.hit += hit; total.miss += miss; total.output += out;
      }
    }
    for (const m of Object.values(perModel)) {
      m.tokens = m.hit + m.miss + m.output;
      m.cacheHitRate = (m.hit + m.miss) > 0 ? m.hit / (m.hit + m.miss) : null;
    }
    total.tokens = total.hit + total.miss + total.output;
    total.cacheHitRate = (total.hit + total.miss) > 0 ? total.hit / (total.hit + total.miss) : null;
    return { perModel, total };
  }

  /**
   * 从 cost 响应聚合「某时间范围」各币种费用（BigInt 定点精确累加，对齐官方 Decimal）。
   * @returns {object} { perCurrency: {CNY: 103n(定点)}, total: 103n }
   */
  function aggregateCostDay(biz, startSec, endSec) {
    const perCurrency = {};
    let total = 0n;
    for (const d of (biz && biz.data) || []) {
      const cur = d.currency || 'CNY';
      let sum = 0n;
      for (const s of d.series || []) {
        for (const b of s.buckets || []) {
          if (b.time < startSec || b.time >= endSec) continue;
          sum += costToFixed(b.cost);
        }
      }
      perCurrency[cur] = sum;
      total += sum;
    }
    return { perCurrency, total };
  }

  /** 汇总今日视图：cost + amount 各模型 + 总量 */
  function computeToday() {
    const r = todayRange();
    const cost = store.cost && rangeCovers(extractBizData(store.cost), r.start)
      ? aggregateCostDay(extractBizData(store.cost), r.start) : null;
    const amount = store.amount && rangeCovers(extractBizData(store.amount), r.start)
      ? aggregateDay(extractBizData(store.amount), r.start) : null;
    const yest = store.amount && rangeCovers(extractBizData(store.amount), yesterdayStart())
      ? aggregateDay(extractBizData(store.amount), yesterdayStart()) : null;
    return { cost, amount, yest, models: (extractBizData(store.amount) || {}).models || [] };
  }

  // ============================================================
  // 拦截层（fetch + XHR 双重 monkey-patch）
  // ============================================================
  function installInterceptors() {
    const interested = url => TRACKED_ENDPOINTS.some(ep => url.includes(ep));

    // ---- XHR（页面主用）----
    const XHR = window.XMLHttpRequest;
    if (XHR) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      const origSetHeader = XHR.prototype.setRequestHeader;

      XHR.prototype.open = function (method, url) {
        this.__dsUrl = String(url);
        this.__dsMethod = method;
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        // 捕获鉴权头，供自请求兜底
        if (/authorization/i.test(name)) auth = value;
        return origSetHeader.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        if (interested(this.__dsUrl || '')) {
          const xhr = this;
          xhr.addEventListener('load', function () {
            const body = safeJSON(xhr.responseText);
            if (!body) return;
            const biz = extractBizData(body);
            if (this.__dsUrl.includes('/by_api_key/amount')) store.amount = body;
            else if (this.__dsUrl.includes('/by_api_key/cost')) store.cost = body;
            else if (this.__dsUrl.includes('/get_user_summary')) store.summary = body;
            else return;
            log('拦截 ' + this.__dsUrl.split('?')[0] + ' -> ' + (biz ? 'biz_data' : '无数据'));
            scheduleInject();
          });
        }
        return origSend.apply(this, arguments);
      };
    }

    // ---- fetch（防御性兜底）----
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      // 捕获请求鉴权头（init.headers 或 Request 对象）
      if (interested(url)) {
        try {
          const hd = (init && init.headers) || (input instanceof Request ? input.headers : null);
          if (hd) new Headers(hd).forEach((v, k) => {
            if (/authorization/i.test(k)) auth = v;
          });
        } catch (e) { /* ignore */ }
      }
      const p = origFetch.apply(this, arguments);
      if (!interested(url)) return p;
      p.then(resp => {
        if (!resp) return;
        resp.clone().text().then(t => {
          const body = safeJSON(t);
          if (!body) return;
          if (url.includes('/by_api_key/amount')) store.amount = body;
          else if (url.includes('/by_api_key/cost')) store.cost = body;
          else if (url.includes('/get_user_summary')) store.summary = body;
          else return;
          log('拦截(fetch) ' + url.split('?')[0]);
          scheduleInject();
        }).catch(() => {});
      }).catch(() => {});
      return p;
    };
    log('拦截层已就绪');
  }

  /** 自请求兜底：当页面当前选的时间范围不含今天时，自己拉一次今日数据（带频率限制） */
  let lastSelfRequest = 0;
  function ensureTodayData() {
    const r = todayRange();
    const needAmount = !(store.amount && rangeCovers(extractBizData(store.amount), r.start));
    const needCost = !(store.cost && rangeCovers(extractBizData(store.cost), r.start));
    if (!needAmount && !needCost) return;
    if (!auth) return;                                  // 页面还没发过请求，稍后再试
    if (Date.now() - lastSelfRequest < 10000) return;   // 限流：10s 内最多一次
    lastSelfRequest = Date.now();
    const q = `?start=${r.start}&end=${r.end}&tz=${r.tz}`;
    const hdrs = { Authorization: auth };
    if (needAmount) {
      fetch('/api/v0/usage/by_api_key/amount' + q, { headers: hdrs })
        .then(resp => resp.json()).then(j => {
          const biz = extractBizData(j);
          if (biz) { store.amount = j; log('自请求 amount 成功'); scheduleInject(); }
        }).catch(e => log('自请求 amount 失败: ' + e));
    }
    if (needCost) {
      fetch('/api/v0/usage/by_api_key/cost' + q, { headers: hdrs })
        .then(resp => resp.json()).then(j => {
          const biz = extractBizData(j);
          if (biz) { store.cost = j; log('自请求 cost 成功'); scheduleInject(); }
        }).catch(e => log('自请求 cost 失败: ' + e));
    }
  }

  // ============================================================
  // 语言探测
  // ============================================================
  function detectLang() {
    const cls = document.body && document.body.className || '';
    if (/zh/i.test(cls)) return 'zh';
    if (/en/i.test(cls)) return 'en';
    // 兜底：看原生卡片文案（此时 body class 可能尚未被 React 设置）
    const cards = document.querySelectorAll('[data-usage-layout-card]');
    const text = Array.from(cards).map(c => c.innerText || '').join(' ');
    if (/消费金额|充值余额/.test(text)) return 'zh';
    if (/balance|cost|token/i.test(text)) return 'en';
    return null;   // 完全不确定：等下一轮再测，避免过早锁死错误语言
  }

  const LANG = () => L[lang] || L.zh;

  // ============================================================
  // 注入层 —— 全部「克隆原生节点」实现以假乱真
  // ============================================================

  /** 按标题文案找原生卡片（返回卡片元素） */
  function findCardByTitle(candidates) {
    const cards = document.querySelectorAll('[data-usage-layout-card]');
    for (const card of cards) {
      const titleEl = card.querySelector('[data-usage-layout-row] > span, [data-usage-layout-row] span');
      if (!titleEl) continue;
      const t = (titleEl.textContent || '').trim();
      if (candidates.includes(t)) return card;
    }
    return null;
  }

  /** 注入/刷新 今日消费 / 今日用量 卡片（克隆原生，紧邻锚点卡片插入——恢复原始设计） */
  function injectTodayCards(data) {
    const l = LANG();
    const updateOrCreate = (anchorCard, marker, newTitle, valueText, unitText) => {
      if (!anchorCard) return;
      let card = document.querySelector('[' + marker + ']');
      if (card) {
        const v = card.querySelector('[data-usage-layout-font="value"]');
        if (v && valueText) v.textContent = valueText;
        const u = card.querySelector('[data-usage-layout-font="unit"]');
        if (u && unitText) u.textContent = unitText;
        return;
      }
      // 原生卡片还在骨架屏（加载中）-> 等下一轮再克隆，避免复制骨架
      if (anchorCard.querySelector('.ds-skeleton')) return;
      const clone = anchorCard.cloneNode(true);
      const titleEl = clone.querySelector('[data-usage-layout-row] > span, [data-usage-layout-row] span');
      if (titleEl) titleEl.textContent = newTitle;
      const valueEl = clone.querySelector('[data-usage-layout-font="value"]');
      if (valueEl && valueText) valueEl.textContent = valueText;
      const unitEl = clone.querySelector('[data-usage-layout-font="unit"]');
      if (unitEl && unitText) unitEl.textContent = unitText;
      clone.setAttribute(marker, 'true');
      anchorCard.insertAdjacentElement('afterend', clone);
      log('注入卡片：' + newTitle + ' ' + valueText);
    };

    // 今日消费：克隆「消费金额」卡片，紧邻其后插入
    const todayCost = data.cost ? (data.cost.perCurrency['CNY'] ?? data.cost.total) : null;
    updateOrCreate(findCardByTitle(l.cardCost), CARD_TODAY_COST, l.todayCost,
      todayCost !== null ? '¥' + fmtFixedCents(todayCost) : null, 'CNY');
    // 今日用量：克隆「Tokens」卡片，紧邻其后插入
    const todayTokens = data.amount ? data.amount.total.tokens : null;
    updateOrCreate(findCardByTitle(l.cardTokens), CARD_TODAY_USAGE, l.todayUsage,
      todayTokens !== null ? fmtInt(todayTokens) : null, null);
  }

  /**
   * 找「指标头」元素：结构 = 恰好 2 个 span 子元素，首个 span 文案命中指标名。
   * 返回 [{ el, kind: 'requests'|'tokens' }]
   */
  function findMetricHeaders() {
    const l = LANG();
    const out = [];
    document.querySelectorAll('div').forEach(el => {
      const spans = Array.from(el.children).filter(c => c.tagName === 'SPAN');
      if (spans.length !== 2) return;
      const t = (spans[0].textContent || '').trim();
      if (l.metricRequests.includes(t)) out.push({ el, kind: 'requests' });
      else if (l.metricTokens.includes(t)) out.push({ el, kind: 'tokens' });
    });
    return out;
  }

  /** 从指标头向上找所属模型（数据动态下发，不能硬编码模型名） */
  function findModelFor(headerEl, models) {
    // v4-pro 加入后，模型名标题与指标图是「相邻兄弟」（模型组容器内并列多模型），
    // 旧逻辑向上找「唯一含模型名的容器」会撞上含多模型名的容器 → 歧义 → 全灭。
    // 新逻辑：从指标头逐层向上，找「前一个兄弟元素文本精确等于某模型名」。
    let el = headerEl.parentElement;
    while (el && el !== document.body) {
      let sib = el.previousElementSibling;
      while (sib) {
        const t = (sib.textContent || '').trim();
        const hit = models.find(m => m && t === m);
        if (hit) return hit;
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
    // 兜底：旧逻辑（向上找唯一含模型名的容器）
    el = headerEl.parentElement;
    while (el && el !== document.body) {
      const txt = el.textContent || '';
      const hits = models.filter(m => m && txt.includes(m));
      if (hits.length === 1 && el.children.length <= 20) return hits[0];
      el = el.parentElement;
    }
    return null;
  }

  /** 注入各模型「昨日/今日/缓存命中率」行 */
  function injectPerModelRows(data) {
    const l = LANG();
    const headers = findMetricHeaders();
    if (!headers.length || !data.amount) return;
    const models = data.models;
    if (!models.length) return;

    for (const { el, kind } of headers) {
      const model = findModelFor(el, models);
      if (!model) continue;
      const todayM = data.amount.perModel[model];
      const yestM = data.yest && data.yest.perModel[model];
      if (!todayM) continue;

      const rows = [];
      if (kind === 'requests') {
        rows.push({ label: l.yesterday, value: fmtInt(yestM ? yestM.requests : null), cls: 'y' });
        rows.push({ label: l.today, value: fmtInt(todayM.requests), cls: 't' });
      } else { // tokens
        rows.push({ label: l.today, value: fmtInt(todayM.tokens), cls: 't' });
        rows.push({ label: l.cacheHitRate, value: fmtRate(todayM.cacheHitRate), cls: 'r' });
      }
      // 防重复：容器内已有注入行 -> 按 label 刷新值（数据晚到时也能更新）
      const container = el.parentElement;
      if (container) {
        const existing = container.querySelectorAll('[' + ROW_MARKER + ']');
        if (existing.length) {
          for (const r of existing) {
            const lab = r.querySelector('span');
            if (!lab || !r.children[1]) continue;
            const row = rows.find(x => x.label === lab.textContent.trim());
            if (row) r.children[1].textContent = row.value;
          }
          continue;
        }
      }

      for (const row of rows) {
        const clone = el.cloneNode(true);
        const spans = clone.children;
        if (spans.length >= 2) {
          spans[0].textContent = row.label;
          spans[1].textContent = row.value;
        }
        clone.setAttribute(ROW_MARKER, row.cls);
        el.insertAdjacentElement('afterend', clone);
      }
      log('注入模型行：' + model + ' ' + kind + ' (今日=' + fmtInt(kind === 'requests' ? todayM.requests : todayM.tokens) + ')');
    }
  }

  /**
   * 图表 tooltip 增强（v2.1.0）：
   * 1) 千分位安全网（v2.0.9）：新平台原生已对 tooltip 的金额/Token 做千分位，此观察器只兜底未格式化的场景。
   * 2) 缓存命中率注入：官方 tooltip 无命中率，此处按 tooltip 日期从拦截数据算当日命中率，
   *    在系列行末尾追加「缓存命中率 xx.x%」（深色 UI 下文案仍是中文/英文跟随页面语言）。
   * 只处理：(a) data-usage-layout-root 内新增节点；(b) 绝对定位的 tooltip 层。
   * 正则排除日期（2026-08-13）与已格式化数字（1,234）。
   */
  function installTooltipFormatter() {
    const re = /(?<![\d.\-])(\d{4,})(?![\d.\-])/g;
    const formatNode = root => {
      if (root._dsFormatted) return;
      root._dsFormatted = true;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const orig = node.textContent;
        if (!re.test(orig)) continue;
        re.lastIndex = 0;
        const formatted = orig.replace(re, (_, n) => Number(n).toLocaleString('en-US'));
        if (formatted !== orig) node.textContent = formatted;
      }
    };
    const isTooltipLayer = node => {
      if (node.nodeType !== 1) return false;
      const style = node.style;
      return style.position === 'absolute' && parseInt(style.zIndex || '0', 10) >= 1000;
    };
    /** 向 Tokens 图 tooltip 追加/更新「缓存命中率」行（tooltip 层是持久复用的，内容随日期变化） */
    const injectRate = node => {
      const txt = node.innerText || '';
      if (!/(输入（命中缓存）|Input \(cache hit\))/.test(txt)) return;
      // 找系列 label 行（结构：1 个 12px 色块 div + 1 个文本节点，childElementCount === 1）
      const findLabel = name => [...node.querySelectorAll('div')].find(d =>
        d.childElementCount === 1 && d.children[0] && d.children[0].style &&
        d.children[0].style.width === '12px' && d.textContent.trim() === name);
      const labelHit = findLabel('输入（命中缓存）') || findLabel('Input (cache hit)');
      const labelMiss = findLabel('输入（未命中缓存）') || findLabel('Input (cache miss)');
      const labelRow = findLabel('输出') || findLabel('Output');
      if (!labelHit || !labelMiss || !labelRow) return;
      const col = labelRow.parentElement;                 // 左列（label）
      const wrap = col.parentElement;
      const rightCol = [...wrap.children].find(c => c !== col);  // 右列（数值）
      if (!rightCol) return;
      // 命中率 = 当前模型「输入（命中缓存）/（命中+未命中）」，直接用 tooltip 显示的数值。
      // 左列与右列 index 一一对应（日期行右列也有值=总 token），故 value = 右列同 index。
      const parseNum = s => { const t = String(s || '').replace(/[^\d.]/g, ''); if (!t) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
      const valOf = label => { const idx = [...col.children].indexOf(label); return rightCol.children[idx] ? parseNum(rightCol.children[idx].textContent) : null; };
      const hit = valOf(labelHit);
      const miss = valOf(labelMiss);
      // 该模型当天无使用（命中+未命中=0）→ 不注入，避免给未使用的模型编造命中率
      if (hit === null || miss === null || hit + miss === 0) return;
      const rate = hit / (hit + miss) * 100;
      const rateLabel = lang === 'en' ? 'Cache hit rate' : '缓存命中率';
      const rateText = rate.toFixed(1) + '%';
      // 防重复：已有「缓存命中率」行则仅更新值（tooltip 复用 + 日期切换）
      // 注意：值相同则不写 DOM，否则 textContent 变化会再次触发 MutationObserver → 死循环
      const existing = [...col.children].find(d => d.textContent.trim() === rateLabel);
      if (existing) {
        const valEl = rightCol.lastElementChild;  // 命中率值在右列末尾
        if (valEl && valEl.textContent !== rateText) valEl.textContent = rateText;
        return;
      }
      const newLabel = labelRow.cloneNode(true);
      const chip = newLabel.children[0];
      if (chip) { chip.style.background = '#3964FE'; chip.style.borderRadius = '50%'; }
      newLabel.lastChild.textContent = rateLabel;
      col.appendChild(newLabel);
      const newVal = rightCol.lastElementChild ? rightCol.lastElementChild.cloneNode(true) : null;
      if (newVal) { newVal.textContent = rateText; rightCol.appendChild(newVal); }
      log('tooltip 注入命中率: ' + rateText);
    };
    const isInsideTooltip = node => {
      let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
      while (el && el !== document.body) {
        if (isTooltipLayer(el)) return el;
        el = el.parentElement;
      }
      return null;
    };
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (isTooltipLayer(node)) { formatNode(node); injectRate(node); }
          else if (node.closest && node.closest('[data-usage-layout-root]')) formatNode(node);
        }
        // tooltip 层是持久复用的（内容随日期变化），须在内容变化时重新注入/更新命中率
        const tip = isInsideTooltip(m.target);
        if (tip) injectRate(tip);
      }
    });
    // 注意：document-start 阶段 documentElement 可能尚不存在，延迟到 DOM 就绪再观察
    const startObserve = () => obs.observe(document.documentElement, { childList: true, subtree: true });
    if (document.documentElement) {
      startObserve();
    } else {
      document.addEventListener('DOMContentLoaded', startObserve);
    }
    log('tooltip 千分位安全网已启用');
  }


  // ============================================================
  // 注入调度
  // ============================================================
  let injectTimer = null;
  function scheduleInject() {
    if (injectTimer) return;
    injectTimer = setTimeout(() => {
      injectTimer = null;
      tryInject();
    }, 60);
  }

  function tryInject() {
    if (!document.body || !lang) return;
    const data = computeToday();
    if (!data.cost && !data.amount) {
      ensureTodayData();   // 数据未覆盖今日 -> 自请求
      return;
    }
    if (data.amount) injectPerModelRows(data);
    if (data.cost || data.amount) injectTodayCards(data);
  }

  // ============================================================
  // 启动
  // ============================================================
  function init() {
    log('DeepSeek Usage Enhancer v2.1.0 已加载');
    installInterceptors();
    installTooltipFormatter();

    let pollFast = true;
    let pollCount = 0;

    function poll() {
      pollCount++;
      // 语言探测每轮刷新（body class 出现较晚，允许更正，避免锁死错误语言）
      const dl = detectLang();
      if (dl) lang = dl;
      // URL 门控：从官网进入时首载为平台首页 /，SPA 路由到 /usage 前不注入
      if (!lang || !location.pathname.startsWith('/usage')) { /* 等 SPA 路由 / 页面就绪 */ }
      else {
        tryInject();
        ensureTodayData();   // 每轮兜底检查
      }
      if (pollFast && pollCount > 24) pollFast = false;
      setTimeout(poll, pollFast ? 500 : 3000);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pollCount = 0;
        pollFast = true;
        poll();
      }
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(poll, 300));
    } else {
      setTimeout(poll, 300);
    }
  }

  try {
    init();
  } catch (e) {
    console.error('[DSUE] init 异常:', e);
  }
})();
