// ==UserScript==
// @name         DeepSeek Usage Panorama Monitor
// @name:zh-CN   DeepSeek 用量监控悬浮窗
// @namespace    https://github.com/moqiecuican/DeepSeek-Usage-Enhancer
// @version      2.0.4
// @description  在 DeepSeek 开放平台用量页右下角展示悬浮面板：今日消费/今日用量/余额/各模型明细与缓存命中率（DeepSeek 设计语言）
// @author       Jmkwang, Kiming, moqiecuican
// @match        https://platform.deepseek.com/*
// @run-at       document-start
// @grant        none
// @updateURL     https://raw.githubusercontent.com/moqiecuican/DeepSeek-Usage-Panorama/main/deepseek-usage-monitor.user.js
// @license      MIT
// @downloadURL   https://raw.githubusercontent.com/moqiecuican/DeepSeek-Usage-Panorama/main/deepseek-usage-monitor.user.js
// ==/UserScript==

/**
 * DeepSeek Usage Monitor v2.0.0（悬浮面板版）
 *
 * 数据层与页面注入版同源：拦截 by_api_key/amount|cost + get_user_summary，
 * 必要时自请求今日区间。面板视觉完全采用 DeepSeek 设计语言
 * （品牌蓝 #3964FE / 卡片底 #F5F6F7 / 圆角 16px），明暗主题跟随平台。
 * 纯本地运行，无远程通信。
 */

(function () {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================
  const TRACKED_ENDPOINTS = [
    '/api/v0/usage/by_api_key/amount',
    '/api/v0/usage/by_api_key/cost',
    '/api/v0/users/get_user_summary',
  ];

  // ============================================================
  // 状态
  // ============================================================
  let auth = null;
  const store = { amount: null, cost: null, summary: null };
  let shortFormat = localStorage.getItem('dsm-short') === '1';
  let collapsed = localStorage.getItem('dsm-collapsed') === '1';

  // ============================================================
  // 工具函数
  // ============================================================
  function log(msg) { console.log('[DSM] ' + msg); }

  function safeJSON(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function extractBizData(json) {
    if (!json || typeof json !== 'object') return null;
    if (json.biz_data) return json.biz_data;
    if (json.data && json.data.biz_data) return json.data.biz_data;
    return null;
  }

  /** 短格式：1,234,567 -> 1.2M；1000 -> 1.0K */
  function fmtShort(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toLocaleString('en-US');
  }

  function fmtInt(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Math.round(Number(n)).toLocaleString('en-US');
  }

  function fmtNum(n) {
    return shortFormat ? fmtShort(n) : fmtInt(n);
  }

  function fmtRate(r) {
    if (r === null || r === undefined || isNaN(r)) return '—';
    return (r * 100).toFixed(1) + '%';
  }

  /** 金额字符串 -> BigInt 定点（×1e8，对齐官方 Decimal 全精度） */
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

  /** 定点值 -> 显示字符串：截断到 2 位小数（对齐官方 Decimal.floor(2)） */
  function fmtFixedCents(v) {
    const neg = v < 0n;
    const a = neg ? -v : v;
    const yuan = a / 100000000n;
    const cents = (a % 100000000n) / 1000000n;
    return (neg ? '-' : '') + yuan.toString() + '.' + cents.toString().padStart(2, '0');
  }

  /** 本月区间（本地时区 1 号 00:00 至明天 00:00） */
  function monthRange() {
    const now = new Date();
    const tzMin = -now.getTimezoneOffset();
    const rem = tzMin * 60 - 3600 * Math.floor(tzMin * 60 / 3600);
    const ms = d => Math.floor(d.getTime() / 1000);
    const start = ms(new Date(now.getFullYear(), now.getMonth(), 1)) + rem;
    return { start, end: ms(new Date(now.getFullYear(), now.getMonth(), now.getDate())) + rem + 86400 };
  }

  function todayRange() {
    const now = new Date();
    const tzMin = -now.getTimezoneOffset();
    const tzSec = 3600 * Math.floor(tzMin * 60 / 3600);
    const rem = tzMin * 60 - tzSec;
    const ms = d => Math.floor(d.getTime() / 1000);
    const dayStart = ms(new Date(now.getFullYear(), now.getMonth(), now.getDate())) + rem;
    return { start: dayStart, end: dayStart + 86400, tz: tzSec };
  }

  function rangeCovers(biz, t) {
    return biz && Number.isFinite(biz.start) && Number.isFinite(biz.end)
      && biz.start <= t && t < biz.end;
  }

  // ============================================================
  // 数据变换
  // ============================================================
  function aggregateDay(biz, dayStartSec) {
    const dayEnd = dayStartSec + 86400;
    const perModel = {};
    const total = { requests: 0, hit: 0, miss: 0, output: 0 };
    for (const s of (biz && biz.series) || []) {
      const m = perModel[s.model] || (perModel[s.model] = { requests: 0, hit: 0, miss: 0, output: 0, tokens: 0, cacheHitRate: null });
      for (const b of s.buckets || []) {
        if (b.time < dayStartSec || b.time >= dayEnd) continue;
        const u = b.usage || {};
        m.requests += Number(u.REQUEST) || 0;
        m.hit += Number(u.PROMPT_CACHE_HIT_TOKEN) || 0;
        m.miss += Number(u.PROMPT_CACHE_MISS_TOKEN) || 0;
        m.output += Number(u.RESPONSE_TOKEN) || 0;
      }
    }
    for (const m of Object.values(perModel)) {
      m.tokens = m.hit + m.miss + m.output;
      m.cacheHitRate = (m.hit + m.miss) > 0 ? m.hit / (m.hit + m.miss) : null;
      total.requests += m.requests;
      total.hit += m.hit;
      total.miss += m.miss;
      total.output += m.output;
    }
    total.tokens = total.hit + total.miss + total.output;
    total.cacheHitRate = (total.hit + total.miss) > 0 ? total.hit / (total.hit + total.miss) : null;
    return { perModel, total };
  }

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

  function computeToday() {
    const r = todayRange();
    const cost = store.cost && rangeCovers(extractBizData(store.cost), r.start)
      ? aggregateCostDay(extractBizData(store.cost), r.start, r.end) : null;
    // 本月消费：从 cost 数据聚合本月 1 号至今（修复：旧版误用 summary.total_costs 终身累计）
    let monthly = null;
    const costBiz = extractBizData(store.cost);
    if (costBiz && rangeCovers(costBiz, r.start)) {
      const mr = monthRange();
      if (rangeCovers(costBiz, mr.start)) {
        const m = aggregateCostDay(costBiz, mr.start, mr.end);
        monthly = m.perCurrency['CNY'] ?? m.total;
      }
    }
    const amount = store.amount && rangeCovers(extractBizData(store.amount), r.start)
      ? aggregateDay(extractBizData(store.amount), r.start) : null;
    return {
      cost, monthly, amount,
      models: (extractBizData(store.amount) || {}).models || [],
      summary: store.summary ? extractBizData(store.summary) : null,
    };
  }

  // ============================================================
  // 拦截层
  // ============================================================
  function installInterceptors() {
    const interested = url => TRACKED_ENDPOINTS.some(ep => url.includes(ep));

    const XHR = window.XMLHttpRequest;
    if (XHR) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      const origSetHeader = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (method, url) {
        this.__dsUrl = String(url);
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        if (/authorization/i.test(name)) auth = value;
        return origSetHeader.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        if (interested(this.__dsUrl || '')) {
          const xhr = this;
          xhr.addEventListener('load', function () {
            const body = safeJSON(xhr.responseText);
            if (!body) return;
            if (this.__dsUrl.includes('/by_api_key/amount')) store.amount = body;
            else if (this.__dsUrl.includes('/by_api_key/cost')) store.cost = body;
            else if (this.__dsUrl.includes('/get_user_summary')) store.summary = body;
            else return;
            scheduleRender();
          });
        }
        return origSend.apply(this, arguments);
      };
    }

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (interested(url)) {
        try {
          const hd = (init && init.headers) || (input instanceof Request ? input.headers : null);
          if (hd) new Headers(hd).forEach((v, k) => { if (/authorization/i.test(k)) auth = v; });
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
          scheduleRender();
        }).catch(() => {});
      }).catch(() => {});
      return p;
    };
    log('拦截层已就绪');
  }

  let lastSelfRequest = 0;
  function ensureTodayData() {
    const r = todayRange();
    const needAmount = !(store.amount && rangeCovers(extractBizData(store.amount), r.start));
    const needCost = !(store.cost && rangeCovers(extractBizData(store.cost), r.start));
    if (!needAmount && !needCost) return;
    if (!auth || Date.now() - lastSelfRequest < 10000) return;
    lastSelfRequest = Date.now();
    const q = `?start=${r.start}&end=${r.end}&tz=${r.tz}`;
    const hdrs = { Authorization: auth };
    if (needAmount) {
      fetch('/api/v0/usage/by_api_key/amount' + q, { headers: hdrs })
        .then(resp => resp.json()).then(j => {
          if (extractBizData(j)) { store.amount = j; scheduleRender(); }
        }).catch(() => {});
    }
    if (needCost) {
      fetch('/api/v0/usage/by_api_key/cost' + q, { headers: hdrs })
        .then(resp => resp.json()).then(j => {
          if (extractBizData(j)) { store.cost = j; scheduleRender(); }
        }).catch(() => {});
    }
  }

  // ============================================================
  // 主题（跟随平台 light/dark）
  // ============================================================
  function isDark() {
    const cls = document.body && document.body.className || '';
    if (/dark/i.test(cls)) return true;
    if (/light/i.test(cls)) return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const THEME = {
    light: {
      bg: '#F5F6F7', text: '#0F1115', muted: '#ADB2B8', brand: '#3964FE',
      border: 'rgba(15,17,21,0.08)', rowBg: 'rgba(255,255,255,0.7)', shadow: '0 8px 32px rgba(15,17,21,0.12)',
    },
    dark: {
      bg: '#1C1D21', text: '#E6E8EB', muted: '#8A9199', brand: '#5B7CFF',
      border: 'rgba(230,232,235,0.10)', rowBg: 'rgba(255,255,255,0.04)', shadow: '0 8px 32px rgba(0,0,0,0.5)',
    },
  };

  // ============================================================
  // 面板 DOM
  // ============================================================
  const PANEL_ID = 'dsm-panel';
  let panel = null, bodyEl = null, dataEl = null;

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="dsm-head">
        <span class="dsm-dot"></span>
        <span class="dsm-title">DeepSeek 用量监控</span>
        <span class="dsm-toggle" title="折叠/展开">${collapsed ? '＋' : '－'}</span>
      </div>
      <div class="dsm-body">
        <div class="dsm-row dsm-summary">
          <div class="dsm-cell"><div class="dsm-label">今日消费</div><div class="dsm-value" data-k="todayCost">—</div></div>
          <div class="dsm-cell"><div class="dsm-label">今日用量</div><div class="dsm-value" data-k="todayTokens">—</div></div>
        </div>
        <div class="dsm-row dsm-balance">
          <div class="dsm-cell"><div class="dsm-label">充值余额</div><div class="dsm-value" data-k="balance">—</div></div>
          <div class="dsm-cell"><div class="dsm-label">赠送余额</div><div class="dsm-value" data-k="bonus">—</div></div>
          <div class="dsm-cell"><div class="dsm-label">本月消费</div><div class="dsm-value" data-k="monthly">—</div></div>
        </div>
        <div class="dsm-models"></div>
        <div class="dsm-foot"><span data-k="foot">总请求 — · 总Token — · 命中率 —</span></div>
      </div>`;
    document.body.appendChild(panel);
    bodyEl = panel.querySelector('.dsm-body');
    dataEl = panel.querySelector('.dsm-models');

    // 折叠
    panel.querySelector('.dsm-toggle').addEventListener('click', () => {
      collapsed = !collapsed;
      localStorage.setItem('dsm-collapsed', collapsed ? '1' : '0');
      bodyEl.style.display = collapsed ? 'none' : '';
      panel.querySelector('.dsm-toggle').textContent = collapsed ? '＋' : '－';
    });
    // 拖拽（标题栏）
    const head = panel.querySelector('.dsm-head');
    head.addEventListener('mousedown', e => {
      if (e.target.classList.contains('dsm-toggle')) return;
      const startX = e.clientX, startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      const move = ev => {
        const x = Math.min(Math.max(rect.left + ev.clientX - startX, 4), window.innerWidth - rect.width - 4);
        const y = Math.min(Math.max(rect.top + ev.clientY - startY, 4), window.innerHeight - rect.height - 4);
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        localStorage.setItem('dsm-pos', JSON.stringify({ x: parseInt(panel.style.left), y: parseInt(panel.style.top) }));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      e.preventDefault();
    });
    // 数值点击切换短/原始格式
    panel.addEventListener('click', e => {
      const v = e.target.closest('[data-k]');
      if (!v) return;
      shortFormat = !shortFormat;
      localStorage.setItem('dsm-short', shortFormat ? '1' : '0');
      render();
    });

    // 恢复位置
    try {
      const pos = JSON.parse(localStorage.getItem('dsm-pos') || 'null');
      if (pos && pos.x != null) {
        panel.style.left = pos.x + 'px';
        panel.style.top = pos.y + 'px';
      } else {
        panel.style.right = '24px';
        panel.style.bottom = '24px';
      }
    } catch (e) {
      panel.style.right = '24px';
      panel.style.bottom = '24px';
    }
    applyTheme();
  }

  function applyTheme() {
    if (!panel) return;
    const t = THEME[isDark() ? 'dark' : 'light'];
    panel.style.background = t.bg;
    panel.style.borderColor = t.border;
    panel.style.boxShadow = t.shadow;
    panel.style.color = t.text;
    panel.querySelector('.dsm-head').style.borderBottomColor = t.border;
    const dot = panel.querySelector('.dsm-dot');
    if (dot) dot.style.background = t.brand;
    const labels = panel.querySelectorAll('.dsm-label');
    for (const el of labels) el.style.color = t.muted;
    const rows = panel.querySelectorAll('.dsm-model, .dsm-balance');
    for (const el of rows) el.style.background = t.rowBg;
  }

  /** 渲染面板数据 */
  function render() {
    if (!panel) return;
    const data = computeToday();
    const set = (k, v) => {
      const el = panel.querySelector('[data-k="' + k + '"]');
      if (el) el.textContent = v;
    };

    // 汇总区
    const todayCost = data.cost ? (data.cost.perCurrency['CNY'] ?? data.cost.total) : null;
    set('todayCost', todayCost !== null ? '¥' + fmtFixedCents(todayCost) : '—');
    set('todayTokens', data.amount ? fmtNum(data.amount.total.tokens) : '—');

    // 余额区（summary；金额同样截断显示，与官方一致）
    const s = data.summary;
    const walletSum = (arr) => (arr || []).reduce((a, w) => a + costToFixed(w.balance), 0n);
    set('balance', s ? '¥' + fmtFixedCents(walletSum(s.normal_wallets)) : '—');
    set('bonus', s ? '¥' + fmtFixedCents(walletSum(s.bonus_wallets)) : '—');
    // 本月消费：真实本月聚合（cost 数据），非 total_costs 终身累计
    set('monthly', data.monthly !== null ? '¥' + fmtFixedCents(data.monthly) : '—');

    // 各模型
    dataEl.innerHTML = '';
    if (data.amount && data.models.length) {
      for (const m of Object.keys(data.amount.perModel)) {
        const d = data.amount.perModel[m];
        const block = document.createElement('div');
        block.className = 'dsm-model';
        block.innerHTML = `
          <div class="dsm-model-name">${m}</div>
          <div class="dsm-model-line"><span>请求</span><b>${fmtNum(d.requests)}</b><span>Token</span><b>${fmtNum(d.tokens)}</b><span>命中率</span><b>${fmtRate(d.cacheHitRate)}</b></div>
          <div class="dsm-model-line dsm-sub"><span>缓存命中</span><b>${fmtNum(d.hit)}</b><span>未命中</span><b>${fmtNum(d.miss)}</b><span>输出</span><b>${fmtNum(d.output)}</b></div>`;
        dataEl.appendChild(block);
      }
    } else {
      dataEl.innerHTML = '<div class="dsm-model dsm-empty">等待数据…</div>';
    }

    // 底部汇总
    if (data.amount) {
      const t = data.amount.total;
      set('foot', `总请求 ${fmtNum(t.requests)} · 总Token ${fmtNum(t.tokens)} · 命中率 ${fmtRate(t.cacheHitRate)}`);
    } else {
      set('foot', '总请求 — · 总Token — · 命中率 —');
    }
    applyTheme();
  }

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; render(); }, 60);
  }

  // ============================================================
  // 启动
  // ============================================================
  function injectStyles() {
    const style = document.createElement('style');
    style.id = 'dsm-style';
    style.textContent = `
      #${PANEL_ID} {
        position: fixed; z-index: 2147483646; width: 336px;
        border-radius: 16px; border: 1px solid; padding: 0;
        font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
        user-select: none; backdrop-filter: blur(8px);
      }
      #${PANEL_ID} .dsm-head {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px; cursor: grab; border-bottom: 1px solid;
      }
      #${PANEL_ID} .dsm-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      #${PANEL_ID} .dsm-title { font-size: 13px; font-weight: 600; flex: 1; }
      #${PANEL_ID} .dsm-toggle {
        cursor: pointer; font-size: 14px; width: 20px; text-align: center;
        border-radius: 6px; line-height: 1.4; opacity: .7;
      }
      #${PANEL_ID} .dsm-toggle:hover { opacity: 1; }
      #${PANEL_ID} .dsm-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
      #${PANEL_ID} .dsm-row { display: flex; gap: 8px; }
      #${PANEL_ID} .dsm-cell { flex: 1; }
      #${PANEL_ID} .dsm-label { font-size: 11px; opacity: .75; margin-bottom: 2px; }
      #${PANEL_ID} .dsm-value { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; cursor: pointer; }
      #${PANEL_ID} .dsm-value:hover { text-decoration: underline dotted; }
      #${PANEL_ID} .dsm-model {
        border-radius: 12px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;
        cursor: pointer;
      }
      #${PANEL_ID} .dsm-model-name { font-weight: 600; font-size: 12px; }
      #${PANEL_ID} .dsm-model-line { display: flex; gap: 6px; align-items: baseline; font-size: 12px; flex-wrap: wrap; }
      #${PANEL_ID} .dsm-model-line span { opacity: .7; }
      #${PANEL_ID} .dsm-model-line b { font-variant-numeric: tabular-nums; font-weight: 600; }
      #${PANEL_ID} .dsm-sub { opacity: .85; }
      #${PANEL_ID} .dsm-empty { opacity: .6; }
      #${PANEL_ID} .dsm-foot {
        font-size: 11px; opacity: .75; text-align: center;
        border-top: 1px dashed; padding-top: 8px; cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  function init() {
    log('DeepSeek Usage Monitor v2.0.0 已加载');
    installInterceptors();

    function boot() {
      if (!document.body) { setTimeout(boot, 200); return; }
      // URL 门控：从官网进入时首载为 /，SPA 路由到 /usage 前不渲染面板
      if (!location.pathname.startsWith('/usage')) { setTimeout(boot, 500); return; }
      injectStyles();          // document-start 时 document.head 尚不存在，延迟到 body 就绪
      buildPanel();
      render();
      // 主题跟随平台切换
      const obs = new MutationObserver(() => applyTheme());
      obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }

    let fast = true, count = 0;
    function poll() {
      count++;
      if (location.pathname.startsWith('/usage')) ensureTodayData();
      if (fast && count > 24) fast = false;
      setTimeout(poll, fast ? 500 : 3000);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { boot(); setTimeout(poll, 300); });
    } else {
      boot();
      setTimeout(poll, 300);
    }
  }

  try {
    init();
  } catch (e) {
    console.error('[DSM] init 异常:', e);
  }
})();
