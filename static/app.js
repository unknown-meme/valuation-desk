/* 估值决策台 · 前端逻辑
   纯原生 JS，不依赖任何库；图表用手绘 SVG，离线也能用。 */
(() => {
  "use strict";

  document.documentElement.classList.add("js");

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    data: null,
    tab: "hs300",
    hold: Number(localStorage.getItem("desk.hold") || 0),
    legend: {
      hs300: { close: 1, buy: 1, deep: 1, deep2: 1, sell: 1 },
      cyb: { close: 1, buy: 1, deep: 1, deep2: 1, sell: 1 },
    },
    busy: false,
  };

  const urlTab = new URLSearchParams(location.search).get("tab");
  if (urlTab === "cyb" || urlTab === "hs300") state.tab = urlTab;

  const ZONES = {
    deep2: { label: "深水区", tone: "tone-deep", badge: "badge-deep" },
    tier3: { label: "深水区", tone: "tone-deep", badge: "badge-deep" },
    tier2: { label: "加仓区", tone: "tone-buy", badge: "badge-deep" },
    tier1: { label: "建仓区", tone: "tone-buy", badge: "badge-buy" },
    wait: { label: "观察区", tone: "tone-wait", badge: "badge-wait" },
    clear: { label: "清仓区", tone: "tone-clear", badge: "badge-clear" },
  };

  const COLOR = {
    ink: "#191712", ink2: "#57503f", ink3: "#8a8172",
    red: "#a63a28", green: "#2c5545", greenSoft: "#4d7a63",
    ochre: "#9a6b36", indigo: "#1e3a4c", plum: "#5f3a52", gold: "#b89147",
  };

  // ------------------------------------------------------------- 工具
  const num = (v, d = 2) =>
    v == null || Number.isNaN(Number(v))
      ? "——"
      : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });

  const int = (v) => num(v, 0);
  const signed = (v, d = 1) => (v == null ? "——" : (v >= 0 ? "+" : "") + Number(v).toFixed(d));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function niceTicks(min, max, count) {
    if (!(max > min)) return [min];
    const raw = (max - min) / (count || 5);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function pathOf(pts) {
    if (!pts.length) return "";
    let d = "M" + pts[0][0].toFixed(2) + "," + pts[0][1].toFixed(2);
    for (let i = 1; i < pts.length; i++) d += "L" + pts[i][0].toFixed(2) + "," + pts[i][1].toFixed(2);
    return d;
  }

  const svgEl = (tag, attrs) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };

  // ------------------------------------------------------------- 取数
  function setBusy(busy) {
    state.busy = busy;
    const btn = $("#refreshBtn");
    btn.disabled = busy;
    btn.classList.toggle("loading", busy);
    $(".label", btn).textContent = busy ? "抓取中…" : "刷新数据";
    document.body.classList.toggle("refreshing", busy);
  }

  async function load(force) {
    if (state.busy) return;
    setBusy(true);
    try {
      const url = force ? "/api/refresh?force=1" : "/api/refresh";
      const res = await fetch(state.data ? url : "/api/data", { cache: "no-store" });
      const json = await res.json();
      if (!json || (!json.hs300 && !json.cyb)) throw new Error((json && json.message) || "没有拿到数据");
      state.data = json;
      render();
      if (json.warnings && json.warnings.length) {
        console.warn("数据预警：", json.warnings);
      }
    } catch (err) {
      flashError(err);
    } finally {
      setBusy(false);
    }
  }

  function flashError(err) {
    const line = $("#verdictLine");
    if (line) line.innerHTML = '<b style="color:var(--red)">抓取失败：</b>' + String(err.message || err).slice(0, 160) +
      '。<br>检查一下网络，或者点“刷新数据”重试。';
  }

  // ------------------------------------------------------------- 判决
  function verdictCopy(b, hold) {
    const z = b.now.zone;
    const dBuy = b.now.to_buy_pct;
    const dSell = b.now.to_sell_pct;
    const buyPts = int(b.now.buy_pts);
    const sellPts = int(b.now.sell_pts);
    const v = b.unit;
    const out = { word: "", tag: "", cls: "tone-wait", line: "" };

    if (z === "wait") {
      out.word = hold ? "拿着别动" : "空仓等待";
      out.tag = hold ? "等清仓线" : "不动手";
      out.cls = "tone-wait";
      out.line = hold
        ? `已经在里面就继续拿着，等 ${v} 涨到 <b>${b.now.sell_val}</b>（约 <b>${sellPts}</b> 点）再清。距离还有 <span class="up">${signed(dSell)}%</span>。`
        : `现价 <b>${int(b.now.close)}</b> 点，要再跌 <span class="down">${Math.abs(dBuy).toFixed(1)}%</span>（到 <b>${buyPts}</b> 点）才进买入线。这之前什么都不用做。`;
    } else if (z === "tier1" || z === "tier2" || z === "tier3") {
      const tier = z === "tier1" ? 1 : z === "tier2" ? 2 : 3;
      out.word = hold ? `加第 ${tier} 档` : "该动手了";
      out.tag = `第 ${tier} 档 · ${ZONES[z].label}`;
      out.cls = "tone-buy";
      out.line = `估值 <b>${b.now.val}</b> 已经跌破${tier === 1 ? "买入线" : tier === 2 ? "深入线" : "深水线"} <b>${num(tier === 1 ? b.now.buy_val : tier === 2 ? b.now.deep_val : b.now.deep2_val)}</b>。` +
        `按规则买第 ${tier} 档，越往下跌档位越高、买得越重（最多 7 份）。`;
    } else {
      out.word = hold ? "清仓走人" : "清仓区·别追";
      out.tag = "到线了";
      out.cls = "tone-clear";
      out.line = `估值 <b>${b.now.val}</b> 已经爬到清仓线 <b>${b.now.sell_val}</b> 之上（${b.now.sell_note}）。` +
        (hold ? "按规则一次性清掉，落袋为安。" : "这里不是买点，唯一该做的是把仓位清掉。");
    }
    return out;
  }

  function primaryBlock() {
    const d = state.data || {};
    const order = ["clear", "tier3", "tier2", "tier1", "wait"];
    const blocks = [d.hs300, d.cyb].filter(Boolean);
    if (!blocks.length) return null;
    // 谁的信号更该行动，就用谁当主角
    blocks.sort((a, b) => order.indexOf(a.now.zone) - order.indexOf(b.now.zone));
    return blocks[0];
  }

  function renderStamp() {
    const d = state.data;
    if (!d) return;
    $("#asOf").textContent = d.as_of || d.hs300.now.date;
    const gen = new Date((d.generated_at || "").replace(" ", "T"));
    const ok = !Number.isNaN(gen.getTime());
    $("#genAt").textContent = ok
      ? "取数于 " + gen.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "取数时间未知";
  }

  function renderVerdict() {
    const d = state.data;
    const b = primaryBlock();
    if (!b) return;
    const copy = verdictCopy(b, state.hold);
    const word = $("#verdictWord");
    word.className = "verdict-word " + copy.cls;
    word.innerHTML = copy.word + ' <span class="tag">' + b.name + " · " + copy.tag + "</span>";

    const others = [d.hs300, d.cyb].filter((x) => x && x !== b);
    let line = copy.line;
    if (others.length) {
      const o = others[0];
      const od = o.now.zone === "wait" ? `还差 <span class="down">${Math.abs(o.now.to_buy_pct).toFixed(1)}%</span> 到买入线`
        : o.now.zone === "clear" ? `已过清仓线 <span class="up">${signed(o.now.to_sell_pct)}%</span>`
        : `已在${ZONES[o.now.zone].label}`;
      line += `<br><span style="font-size:14px;color:var(--ink-3)">另一边：${o.name} ${int(o.now.close)} 点 / ${o.unit} ${o.now.val}，${od}</span>`;
    }
    $("#verdictLine").innerHTML = line;

    const nx = [d.hs300, d.cyb].filter(Boolean).map((x) =>
      "<span><em>" + x.name + "</em>跌到 <b>" + int(x.now.buy_pts) + "</b> 点动手 · 涨到 <b>" +
      int(x.now.sell_pts) + "</b> 点清仓</span>").join("");
    $("#nextUp").innerHTML = '<span class="k">下一步只看这两行</span>' + nx;

    $("#verdictStats").innerHTML = [
      ["点位", int(b.now.close) + ' <small>点</small>'],
      [b.unit, num(b.now.val)],
      ["历史分位", num(b.now.val_pct, 1) + ' <small>%</small>'],
      ["买入 / 清仓 点位", int(b.now.buy_pts) + ' <small>/ ' + int(b.now.sell_pts) + "</small>"],
    ].map(([k, v]) => '<div><div class="stat">' + k + '</div><div class="statv">' + v + "</div></div>").join("");
  }

  function renderMini() {
    const d = state.data;
    const host = $("#miniList");
    const rows = [d.hs300, d.cyb].filter(Boolean).map((b) => {
      const m = ZONES[b.now.zone];
      const v = b.now.val;
      const d0 = b.now.deep2_val * 0.97, d1 = b.now.sell_val * 1.04;
      const span = d1 - d0 || 1;
      const segs = [
        [d0, b.now.deep2_val, "z-deep"],
        [b.now.deep2_val, b.now.deep_val, "z-add"],
        [b.now.deep_val, b.now.buy_val, "z-open"],
        [b.now.buy_val, b.now.sell_val, "z-wait"],
        [b.now.sell_val, d1, "z-clear"],
      ];
      const bar = segs.map(([lo, hi, cls]) =>
        '<div class="' + cls + '" style="width:' + (((hi - lo) / span) * 100).toFixed(3) + '%"></div>').join("");
      const pctPos = clamp(((v - d0) / span) * 100, 0, 100);
      return `<div class="mini-row" data-tab="${b === d.hs300 ? "hs300" : "cyb"}">
        <div class="mini-top">
          <div class="mini-name">${b.name}<span>${b.code}</span></div>
          <div class="mini-badge ${m.badge}">${m.label}</div>
        </div>
        <div class="mini-nums">
          <span class="big">${int(b.now.close)}</span>
          <span class="val">${b.unit} ${num(b.now.val)}</span>
          <span class="pct">历史 ${num(b.now.val_pct, 1)}% 分位</span>
        </div>
        <div class="mini-track"><div class="zone-bar">${bar}</div><span class="ptr" style="left:${pctPos.toFixed(2)}%"></span></div>
        <div class="mini-foot">
          <span>买入 ${int(b.now.buy_pts)}（${signed(b.now.to_buy_pct)}%）</span>
          <span>清仓 ${int(b.now.sell_pts)}（${signed(b.now.to_sell_pct)}%）</span>
        </div>
      </div>`;
    }).join("");
    host.innerHTML = rows + '<div class="mini-hint">点任一行，下方标尺、图表、台账一起切过去</div>';
    $$(".mini-row", host).forEach((el) =>
      el.addEventListener("click", () => setTab(el.dataset.tab)));
  }
  // ------------------------------------------------------------- 标尺
  function rulerHTML(b) {
    const n = b.now;
    const d0 = n.deep2_val * 0.94;
    const d1 = n.sell_val * 1.06;
    const span = d1 - d0 || 1;
    const pos = (v) => clamp(((v - d0) / span) * 100, 0, 100);
    const segs = [
      [d0, n.deep2_val, "深水", "z-deep"],
      [n.deep2_val, n.deep_val, "加仓", "z-add"],
      [n.deep_val, n.buy_val, "建仓", "z-open"],
      [n.buy_val, n.sell_val, "观察", "z-wait"],
      [n.sell_val, d1, "清仓", "z-clear"],
    ];
    const bar = segs.map(([lo, hi, label, cls]) =>
      '<div class="' + cls + '" style="width:' + (((hi - lo) / span) * 100).toFixed(3) + '%">' + label + "</div>").join("");
    const ticks = [n.deep2_val, n.deep_val, n.buy_val, n.sell_val]
      .map((v) => '<span style="left:' + pos(v).toFixed(3) + '%">' + num(v) + "</span>").join("");
    const z = ZONES[n.zone];
    const flag = num(n.val) + " · " + z.label;
    return `<div class="ruler card" data-block="${b.code}">
      <div class="ruler-head">
        <h3>${b.name}</h3><span class="unit">${b.unit} · ${b.val_label}</span>
        <span class="now">现价 <b>${int(n.close)}</b> 点 · 估值 <b>${num(n.val)}</b> · 历史 ${num(n.val_pct, 1)}% 分位</span>
      </div>
      <div class="track">
        <div class="needle" style="left:${pos(n.val).toFixed(3)}%">
          <div class="flag">${flag}</div>
          <div class="arrow"></div>
          <div class="stem"></div>
        </div>
        <div class="zone-bar">${bar}</div>
        <div class="ticks">${ticks}</div>
      </div>
      <div class="ruler-foot">
        <div><span class="k">距买入线</span> <b class="down" style="color:var(--green)">${signed(n.to_buy_pct)}%</b> · ${int(n.buy_pts)} 点</div>
        <div><span class="k">距清仓线</span> <b style="color:var(--red)">${signed(n.to_sell_pct)}%</b> · ${int(n.sell_pts)} 点</div>
        <div><span class="k">历史底部中位数</span> <b>${num(n.median_trough_val)}</b></div>
      </div>
    </div>`;
  }

  function renderRulers() {
    const d = state.data;
    const host = $("#rulers");
    host.innerHTML = [d.hs300, d.cyb].filter(Boolean).map(rulerHTML).join("");
    $$(".ruler", host).forEach((el) => {
      const code = el.dataset.block;
      el.style.opacity = (code === "000300" ? "hs300" : "cyb") === state.tab ? "1" : "0.62";
      el.style.cursor = "pointer";
      el.addEventListener("click", () => setTab(code === "000300" ? "hs300" : "cyb"));
    });
  }

  // ------------------------------------------------------------- 图表引擎
  function lineChart(host, cfg) {
    host.innerHTML = "";
    const data = state.data;
    if (!data) return;
    const W = Math.max(340, Math.round(host.clientWidth || 900));
    const H = cfg.height || 420;
    const pad = cfg.pad || { t: 18, r: 20, b: 32, l: 64 };
    const dates = cfg.dates;
    const n = dates.length;
    if (!n) return;

    const series = cfg.series.filter((s) => s.values && s.values.length === n);
    const visible = series.filter((s) => s.visible !== false);
    let vals = [];
    visible.forEach((s) => s.values.forEach((v) => { if (v != null && isFinite(v)) vals.push(v); }));
    if (!vals.length) return;
    let y0 = Math.min.apply(null, vals);
    let y1 = Math.max.apply(null, vals);
    const sp = y1 - y0 || 1;
    y0 -= sp * 0.06;
    y1 += sp * 0.07;

    const xAt = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
    const yAt = (v) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    const fmtY = cfg.formatY || ((v) => num(v, 0));

    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });

    // 网格
    niceTicks(y0, y1, 5).forEach((t) => {
      svg.appendChild(svgEl("line", {
        x1: pad.l, x2: W - pad.r, y1: yAt(t), y2: yAt(t),
        stroke: "rgba(25,23,18,.10)", "stroke-width": 1,
      }));
      const tx = svgEl("text", {
        x: pad.l - 10, y: yAt(t) + 3.5, "text-anchor": "end",
        "font-family": "Bahnschrift, Georgia, serif", "font-size": 10.5, fill: "#8a8172",
      });
      tx.textContent = fmtY(t);
      svg.appendChild(tx);
    });

    // 年份刻度
    const yearIdx = [];
    let lastYear = null;
    for (let i = 0; i < n; i++) {
      const y = dates[i].slice(0, 4);
      if (y !== lastYear) {
        lastYear = y;
        if (i > 0) yearIdx.push(i);
      }
    }
    const room = Math.max(2, Math.floor((W - pad.l - pad.r) / 46));
    const yStep = Math.max(1, Math.ceil(yearIdx.length / room));
    yearIdx.forEach((i, k) => {
      if (k % yStep) return;
      const tx = svgEl("text", {
        x: xAt(i), y: H - 10, "text-anchor": "middle",
        "font-family": "Bahnschrift, Georgia, serif", "font-size": 10.5, fill: "#8a8172",
      });
      tx.textContent = dates[i].slice(0, 4);
      svg.appendChild(tx);
    });

    // 填充带（两条线之间）
    (cfg.bands || []).forEach((band) => {
      const a = series.find((s) => s.key === band.a);
      const b = series.find((s) => s.key === band.b);
      if (!a || !b) return;
      if (a.visible === false || b.visible === false) return;
      let d = "";
      for (let i = 0; i < n; i++) d += (i ? "L" : "M") + xAt(i).toFixed(2) + "," + yAt(a.values[i]).toFixed(2);
      for (let i = n - 1; i >= 0; i--) d += "L" + xAt(i).toFixed(2) + "," + yAt(b.values[i]).toFixed(2);
      svg.appendChild(svgEl("path", { d: d + "Z", fill: band.color, stroke: "none" }));
    });

    // 曲线
    visible.forEach((s) => {
      const pts = s.values.map((v, i) => [xAt(i), yAt(v)]);
      svg.appendChild(svgEl("path", {
        d: pathOf(pts), fill: "none", stroke: s.color,
        "stroke-width": s.width || 1.6,
        "stroke-dasharray": s.dash || "none",
        "stroke-linejoin": "round", "stroke-linecap": "round",
        opacity: s.opacity == null ? 1 : s.opacity,
      }));
    });

    // 买卖标记
    const nearest = (ds) => {
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] < ds) lo = mid + 1; else hi = mid;
      }
      return lo;
    };
    (cfg.markers ? cfg.markers.buys || [] : []).forEach(([ds, p]) => {
      const i = nearest(ds);
      svg.appendChild(svgEl("circle", {
        cx: xAt(i), cy: yAt(p), r: 4.6, fill: "#fbf8f1", stroke: COLOR.green, "stroke-width": 1.6,
      }));
    });
    (cfg.markers ? cfg.markers.sells || [] : []).forEach(([ds, p]) => {
      const i = nearest(ds);
      svg.appendChild(svgEl("rect", {
        x: xAt(i) - 4, y: yAt(p) - 4, width: 8, height: 8, fill: "#fbf8f1",
        stroke: COLOR.red, "stroke-width": 1.6,
      }));
    });
    (cfg.labels || []).forEach((l) => {
      const i = nearest(l.date);
      const buy = l.kind === "buy";
      const tx = svgEl("text", {
        x: xAt(i) + (buy ? -9 : 9), y: yAt(l.price) + (buy ? 20 : -11),
        "text-anchor": buy ? "end" : "start",
        "font-family": '"Noto Sans SC", "Microsoft YaHei", sans-serif',
        "font-size": 11, fill: buy ? COLOR.green : COLOR.red, "letter-spacing": "0.06em",
      });
      tx.textContent = l.text;
      svg.appendChild(tx);
    });

    // 末端小点
    visible.forEach((s) => {
      const v = s.values[n - 1];
      if (v == null) return;
      svg.appendChild(svgEl("circle", { cx: xAt(n - 1), cy: yAt(v), r: 3.2, fill: s.color }));
    });

    // 悬停层
    const cross = svgEl("line", {
      x1: 0, x2: 0, y1: pad.t, y2: H - pad.b,
      stroke: "rgba(25,23,18,.35)", "stroke-width": 1, "stroke-dasharray": "3 3", opacity: 0,
    });
    svg.appendChild(cross);
    const dots = {};
    visible.forEach((s) => {
      const c = svgEl("circle", { cx: 0, cy: 0, r: 3.6, fill: s.color, opacity: 0 });
      dots[s.key] = c;
      svg.appendChild(c);
    });

    host.appendChild(svg);
    const tip = document.createElement("div");
    tip.className = "tip";
    host.appendChild(tip);

    const overlay = svgEl("rect", {
      x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b,
      fill: "transparent", style: "cursor:crosshair",
    });
    svg.appendChild(overlay);

    overlay.addEventListener("mousemove", (ev) => {
      const box = svg.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      let i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1));
      i = clamp(i, 0, n - 1);
      const last = visible[visible.length - 1];
      cross.setAttribute("x1", xAt(i));
      cross.setAttribute("x2", xAt(i));
      cross.setAttribute("opacity", 1);
      const rows = [];
      visible.forEach((s) => {
        const v = s.values[i];
        dots[s.key].setAttribute("cx", xAt(i));
        dots[s.key].setAttribute("cy", yAt(v));
        dots[s.key].setAttribute("opacity", 1);
        rows.push('<div class="row"><span>' + s.label + "</span><span>" + (cfg.tipFormat ? cfg.tipFormat(s.key, v) : num(v)) + "</span></div>");
      });
      tip.innerHTML = '<div class="d">' + dates[i] + "</div>" + rows.join("");
      tip.style.opacity = 1;
      tip.style.left = ((xAt(i) / W) * box.width) + "px";
      tip.style.top = ((yAt(last.values[i]) / H) * box.height) + "px";
    });
    overlay.addEventListener("mouseleave", () => {
      cross.setAttribute("opacity", 0);
      Object.values(dots).forEach((c) => c.setAttribute("opacity", 0));
      tip.style.opacity = 0;
    });
  }
  // ------------------------------------------------------------- 主图
  const LEGEND_ITEMS = [
    { key: "close", label: "实际点位", color: COLOR.indigo, swatch: "line" },
    { key: "sell", label: "清仓线", color: COLOR.ochre, swatch: "dash" },
    { key: "buy", label: "买入线", color: COLOR.green, swatch: "dash" },
    { key: "deep", label: "深入线", color: COLOR.plum, swatch: "dash" },
    { key: "deep2", label: "深水线", color: COLOR.greenSoft, swatch: "dash" },
  ];

  function mainSeries(b) {
    const s = b.series;
    const lg = state.legend[state.tab];
    return [
      { key: "close", label: "实际点位", color: COLOR.indigo, width: 1.7, values: s.close, visible: !!lg.close },
      { key: "sell", label: "清仓线", color: COLOR.ochre, width: 1.7, dash: "11 5", values: s.lines.sell, visible: !!lg.sell },
      { key: "buy", label: "买入线", color: COLOR.green, width: 1.7, dash: "9 5", values: s.lines.buy, visible: !!lg.buy },
      { key: "deep", label: "深入线", color: "#6d3455", width: 1.6, dash: "5 4", values: s.lines.deep, visible: !!lg.deep },
      { key: "deep2", label: "深水线", color: COLOR.greenSoft, width: 1.3, dash: "3 7", opacity: 0.9, values: s.lines.deep2, visible: !!lg.deep2 },
    ];
  }

  function renderLegend() {
    const lg = state.legend[state.tab];
    const host = $("#mainLegend");
    host.innerHTML = LEGEND_ITEMS.map((it) => {
      const on = !!lg[it.key];
      return '<button data-key="' + it.key + '" data-on="' + on + '" style="color:' + it.color + '">' +
        '<i class="' + (it.swatch === "dash" ? "dash" : "") + '" style="background:' + (it.swatch === "dash" ? "none" : it.color) +
        ";color:" + it.color + '"></i><span style="color:var(--ink-2)">' + it.label + "</span></button>";
    }).join("");
    $$("button", host).forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.key;
        lg[k] = lg[k] ? 0 : 1;
        renderLegend();
        renderMain();
      });
    });
  }

  function renderMain() {
    const d = state.data;
    const b = d && d[state.tab];
    if (!b) return;
    lineChart($("#mainChartWrap"), {
      dates: b.series.dates,
      height: 434,
      series: mainSeries(b),
      bands: [{ a: "buy", b: "deep2", color: "rgba(44,85,69,.075)" }],
      markers: b.markers,
      labels: b.labels,
      formatY: (v) => num(v, 0),
      tipFormat: (k, v) => (k === "close" ? int(v) + " 点" : num(v, 2)),
    });
  }

  // ------------------------------------------------------------- 辅助图
  function quantile(arr, q) {
    const a = arr.filter((v) => v != null).slice().sort((x, y) => x - y);
    if (!a.length) return 0;
    const i = (a.length - 1) * q;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return a[lo] + (a[hi] - a[lo]) * (i - lo);
  }

  function renderAux() {
    const d = state.data;
    if (d.spread) {
      const sp = d.spread;
      const q80 = quantile(sp.series.spread, 0.8);
      lineChart($("#spreadChart"), {
        dates: sp.series.dates,
        height: 216,
        pad: { t: 14, r: 16, b: 28, l: 52 },
        series: [
          { key: "spread", label: "股债利差", color: COLOR.indigo, width: 1.6, values: sp.series.spread },
          { key: "q80", label: "历史 80% 分位", color: COLOR.red, width: 1, dash: "4 4", opacity: 0.55,
            values: sp.series.spread.map(() => q80) },
        ],
        formatY: (v) => num(v, 1),
        tipFormat: (k, v) => num(v, 2) + " %",
      });
      $("#spreadNow").innerHTML = "现在 <b>" + num(sp.now.spread) + "</b> % · 历史 <b>" + num(sp.now.pct, 0) + "</b>% 分位";
      $("#spreadNote").textContent =
        "现在 " + num(sp.now.spread) + "%，比历史上 " + num(sp.now.pct, 0) + "% 的时候都高（越高＝股票相对债券越便宜）。十年国债 " + num(sp.now.y10) + "%。";
    }
    if (d.vs_bond) {
      const vb = d.vs_bond;
      lineChart($("#bondChart"), {
        dates: vb.series.dates,
        height: 216,
        pad: { t: 14, r: 16, b: 28, l: 52 },
        series: [
          { key: "tri", label: "沪深300全收益", color: COLOR.indigo, width: 1.5, values: vb.series.tri },
          { key: "bond", label: "中证全债", color: COLOR.ochre, width: 1.5, values: vb.series.bond },
        ],
        bands: [{ a: "tri", b: "bond", color: "rgba(30,58,76,.06)" }],
        formatY: (v) => num(v, 0),
        tipFormat: (k, v) => num(v, 1),
      });
      const ratios = vb.series.tri.map((v, i) => v / vb.series.bond[i]);
      const cur = ratios[ratios.length - 1];
      const rp = (ratios.filter((r) => r <= cur).length / ratios.length) * 100;
      $("#bondNow").innerHTML = "股/债比价 · 历史 <b>" + rp.toFixed(0) + "</b>% 分位";
      $("#bondNote").textContent = "现在股债比价处在历史 " + rp.toFixed(0) + "% 分位——" +
        (rp < 20 ? "属于极端便宜的一档，正是左边那套规则的进场时机。"
          : rp > 80 ? "股票相对债券已经偏贵。"
            : "既不算便宜，也谈不上贵。") +
        " 注意两条线都从 2011 年起按 100 算，蓝线在橙线下方只说明这十几年股票跑输债券，不代表现在就该买——真正的信号是上面的分位。";
    }
  }

  // ------------------------------------------------------------- 红利低波
  function renderDividend() {
    const dv = state.data.dividend;
    if (!dv) return;
    $("#dyBig").innerHTML = num(dv.yield) + "<small> %</small>";
    const w = clamp(((dv.yield - 3) / 3) * 100, 0, 100);
    const bar = $("#dyBar");
    bar.querySelector("i").style.width = w.toFixed(1) + "%";
    bar.querySelector(".mark").style.left = "66.7%";
    const gap = Math.abs(dv.gap);
    $("#dyNote").textContent = dv.name + "（" + dv.code + "）· 股息率 · " + dv.as_of;
    $("#dySub").innerHTML = dv.ok
      ? '已过 <b style="color:var(--green)">5%</b> 门槛，空仓的钱可以放这里吃股息，等于白拿一份底仓收益。'
      : '还差 <b style="color:var(--red)">' + num(gap) + '</b> 个百分点到 5% 门槛。没到门槛时它自己也谈不上便宜，钱先放货币/短债等机会。';
  }

  // ------------------------------------------------------------- 台账
  function renderTables() {
    const b = state.data[state.tab];
    if (!b) return;
    const zig = b.unit;
    const rows = b.troughs.map((t) =>
      '<tr class="' + (t.used ? "" : "pending") + '">' +
      '<td class="dim">' + t.date + "</td>" +
      "<td>" + int(t.close) + "</td>" +
      "<td>" + num(t.val) + "</td>" +
      '<td class="dim">' + (t.used ? "计入中位数" : "刚跌下来，等确认") + "</td></tr>").join("");
    $("#troughTable").innerHTML =
      '<table class="data"><caption>' + b.name + " · 历史大底与当天 " + zig + "（中位数 " + num(b.now.median_trough_val) + "）</caption>" +
      "<thead><tr><th>日期</th><th>点位</th><th>" + zig + "</th><th>备注</th></tr></thead><tbody>" + rows + "</tbody></table>";

    const trs = b.trades.map((t) =>
      "<tr><td>" + t.entry + "</td><td>" + t.exit + "</td>" +
      "<td>" + num(t.months, 1) + "</td><td>" + t.units + "</td>" +
      "<td>" + int(t.avg_price) + "</td><td>" + int(t.exit_price) + "</td>" +
      '<td class="' + (t.ret >= 0 ? "pos" : "neg") + '">' + signed(t.ret) + "%</td></tr>").join("");
    const open = b.open_position
      ? '<tr><td>' + b.open_position.entry + '</td><td class="dim">持仓中</td>' +
        '<td class="dim">——</td><td>' + b.open_position.units + "</td>" +
        "<td>" + int(b.open_position.avg) + '</td><td class="dim">——</td>' +
        '<td class="' + (b.open_position.floating >= 0 ? "pos" : "neg") + '">' + signed(b.open_position.floating) + "%</td></tr>"
      : "";
    $("#tradeTable").innerHTML =
      '<table class="data"><caption>' + b.name + " · 机械回放（按月，不含分红与手续费）</caption>" +
      "<thead><tr><th>买入</th><th>清仓</th><th>月数</th><th>份数</th><th>加权成本</th><th>卖出点位</th><th>收益</th></tr></thead>" +
      "<tbody>" + trs + open + "</tbody></table>";
  }

  // ------------------------------------------------------------- 渲染总控
  function render() {
    $$("#mainTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
    $$("#tableTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
    renderStamp();
    renderVerdict();
    renderMini();
    renderRulers();
    renderLegend();
    renderMain();
    renderAux();
    renderDividend();
    renderTables();
  }

  function setTab(tab) {
    if (tab === state.tab) return;
    state.tab = tab;
    $$("#mainTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $$("#tableTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    renderRulers();
    renderLegend();
    renderMain();
    renderTables();
  }

  // ------------------------------------------------------------- 交互绑定
  function bind() {
    $("#refreshBtn").addEventListener("click", () => load(false));

    // 深度刷新：忽略当天缓存，强制重抓（约 30 秒）
    const deep = document.createElement("button");
    deep.className = "btn ghost";
    deep.textContent = "深度刷新";
    deep.title = "忽略今天的本地缓存，全部重新抓一遍，约 20~40 秒";
    deep.addEventListener("click", () => load(true));
    $("#refreshBtn").parentNode.insertBefore(deep, $("#refreshBtn"));

    $$("#holdToggle button").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(Number(btn.dataset.hold) === state.hold));
      btn.addEventListener("click", () => {
        state.hold = Number(btn.dataset.hold);
        localStorage.setItem("desk.hold", String(state.hold));
        $$("#holdToggle button").forEach((b) =>
          b.setAttribute("aria-pressed", String(Number(b.dataset.hold) === state.hold)));
        renderVerdict();
      });
    });

    $$("#mainTabs button").forEach((btn) =>
      btn.addEventListener("click", () => setTab(btn.dataset.tab)));
    $$("#tableTabs button").forEach((btn) =>
      btn.addEventListener("click", () => setTab(btn.dataset.tab)));

    let t = null;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (!state.data) return;
        renderMain();
        renderAux();
      }, 200);
    });

  }

  bind();
  load(false);
})();