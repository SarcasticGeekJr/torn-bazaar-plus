// ==UserScript==
// @name         Bazaar Plus
// @namespace    https://github.com/SarcasticGeekJr/torn-bazaar-plus
// @version      2.1.0
// @description  Cheapest bazaar listings for any item, with filters, buy calculator, flip profit, price history, deal finder, watchlist and undercut alerts, item info, seller status and a price helper when you list items. Built for Torn PDA, works in Tampermonkey too.
// @author       SarcasticGeekJr
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      weav3r.dev
// @connect      api.torn.com
// @run-at       document-end
// @homepageURL  https://github.com/SarcasticGeekJr/torn-bazaar-plus
// @supportURL   https://github.com/SarcasticGeekJr/torn-bazaar-plus/issues
// @updateURL    https://raw.githubusercontent.com/SarcasticGeekJr/torn-bazaar-plus/main/bazaar-plus.user.js
// @downloadURL  https://raw.githubusercontent.com/SarcasticGeekJr/torn-bazaar-plus/main/bazaar-plus.user.js
// ==/UserScript==

/*
 * Data sources
 *   - Bazaar listings: TornW3B (https://weav3r.dev), a public, no-key API used by most bazaar scripts.
 *     Note: TornW3B does not track $1 listings.
 *   - Official Torn API (optional, a Public key is enough; Torn PDA fills it in automatically):
 *       v2 /market/{id}/itemmarket   lowest Item Market price
 *       v2 /market/{id}/bazaar       which bazaars are open
 *       v2 /torn/{id}/items          item description, effect, circulation, shop prices
 *       v1 /user/{id}?selections=profile   seller status and last action
 *       v1 /user/?selections=bazaar        your own bazaar, for undercut alerts
 *
 * Rules: this script only reads data, shows it, and can type a price into a box for you.
 * It never buys, lists or confirms anything. Every action in the game is still yours.
 */

(function () {
  "use strict";

  if (window.__bazaarPlusLoaded) return;
  window.__bazaarPlusLoaded = true;

  // ---------------------------------------------------------------- config
  const PDA_KEY = "###PDA-APIKEY###"; // Torn PDA replaces this with your key at runtime
  const W3B = "https://weav3r.dev/api/marketplace";
  const TORN = "https://api.torn.com";
  const MIN = 60 * 1000;
  const LIST_TTL = 10 * MIN; // full item list (lowest price of every item)
  const ITEM_TTL = 30 * 1000; // one item's listings
  const MONITOR_INTERVAL = 10 * MIN; // watchlist + undercut check
  const HIGHLIGHT_TTL = 3 * MIN; // how long a "highlight this item" request stays valid
  const HIST_BUCKET = 30 * MIN; // at most one price-history point per item per 30 min
  const HIST_KEEP = 120 * 24 * 60 * MIN;

  const DEFAULTS = {
    apiKey: "",
    minQty: 1,
    maxPrice: 0,
    maxAge: 0, // minutes, 0 = any
    sort: "price",
    hideOwn: true,
    autoRefresh: false,
    marketBadge: true,
    priceHelper: true,
    undercut: true,
    alertPopup: true,
    alertVibrate: true,
    fee: 5, // Item Market sales fee, % (Torn's standard fee since June 2025)
    anon: false, // I list anonymously on the Item Market (+10%)
    anonWaived: false, // 5* Car Dealership / Property Broker special removes the anonymous fee
    undercutBy: 1, // $ under the cheapest when the price helper fills a price
    fab: null, // { right, bottom } in px once dragged
    deals: { minPct: 10, maxPrice: 0, minMv: 1000, type: "", sort: "pct" },
    hidden: {}, // seller id -> name
    watch: {}, // item id -> { name, target }
    recent: [], // item ids
  };

  // ---------------------------------------------------------------- storage
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("bzp_" + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("bzp_" + k, JSON.stringify(v));
      } catch {}
    },
  };
  const S = Object.assign({}, DEFAULTS, store.get("settings", {}));
  S.deals = Object.assign({}, DEFAULTS.deals, S.deals);
  const save = () => store.set("settings", S);
  const apiKey = () => (S.apiKey || (PDA_KEY.includes("#") ? "" : PDA_KEY)).trim();
  const myId = (() => {
    const m = document.cookie.match(/(?:^|;\s*)uid=(\d+)/);
    return m ? +m[1] : 0;
  })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- http
  function httpGet(url) {
    if (typeof window.PDA_httpGet === "function") return pdaGet(url);
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((res, rej) =>
        GM_xmlhttpRequest({
          method: "GET",
          url,
          timeout: 15000,
          onload: (r) => {
            if (r.status < 200 || r.status >= 300) return rej(new Error("HTTP " + r.status));
            try {
              res(JSON.parse(r.responseText));
            } catch (e) {
              rej(e);
            }
          },
          onerror: () => rej(new Error("Network error")),
          ontimeout: () => rej(new Error("Timed out")),
        })
      );
    }
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  // Torn PDA silently drops a GET for a URL it already fetched in the last 2s and resolves with
  // undefined, so wait out that window and try again instead of treating it as a response.
  async function pdaGet(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await window.PDA_httpGet(url, {});
      if (r && r.status != null) {
        const status = +r.status;
        if (status < 200 || status >= 300) throw new Error("HTTP " + status);
        return JSON.parse(r.responseText);
      }
      await sleep(2100);
    }
    throw new Error("Torn PDA didn't return a response");
  }

  const memo = new Map(); // url -> { t, p, done }
  function cached(url, ttl, force) {
    const hit = memo.get(url);
    // A request for this URL still in flight is reused even when forced, so a refresh never fires a duplicate.
    if (hit && (!hit.done || (!force && Date.now() - hit.t < ttl))) return hit.p;
    const entry = { t: Date.now(), done: false };
    entry.p = httpGet(url).then(
      (d) => {
        entry.done = true;
        return d;
      },
      (e) => {
        if (memo.get(url) === entry) memo.delete(url);
        throw e;
      }
    );
    memo.set(url, entry);
    return entry.p;
  }

  // Official Torn API. path like "/v2/market/206/itemmarket" or "/user/123?selections=profile".
  async function torn(path, ttl, force) {
    const key = apiKey();
    if (!key) throw new Error("no API key");
    const sep = path.includes("?") ? "&" : "?";
    const d = await cached(`${TORN}${path}${sep}key=${encodeURIComponent(key)}&comment=BazaarPlus`, ttl, force);
    if (d && d.error) {
      memo.delete(`${TORN}${path}${sep}key=${encodeURIComponent(key)}&comment=BazaarPlus`);
      throw new Error(d.error.error || "Torn API error " + d.error.code);
    }
    return d;
  }

  // ---------------------------------------------------------------- data
  let itemList = null; // [{ item_id, item_name, market_price, lowest_price, total_bazaars, type }]
  let itemListAt = 0;
  async function loadItems(force) {
    const c = store.get("items", null);
    if (!force && c && Date.now() - c.t < LIST_TTL) {
      itemListAt = c.t;
      return (itemList = c.items);
    }
    try {
      const d = await cached(W3B, LIST_TTL, force);
      itemList = (d.items || []).filter((i) => i.item_id > 0);
      itemListAt = Date.now();
      store.set("items", { t: itemListAt, items: itemList });
      for (const id of Object.keys(S.watch)) {
        const it = itemById(+id);
        if (it && it.lowest_price) recordHistory(+id, it.lowest_price, it.market_price);
      }
    } catch (e) {
      if (c) {
        itemList = c.items; // stale is better than nothing
        itemListAt = c.t;
      } else throw e;
    }
    return itemList;
  }
  let byId = null;
  const itemById = (id) => {
    if (!itemList) return undefined;
    if (!byId || byId.src !== itemList) byId = { src: itemList, map: new Map(itemList.map((i) => [i.item_id, i])) };
    return byId.map.get(id);
  };
  const itemName = (id) => (itemById(id) || {}).item_name || "Item #" + id;
  const loadListings = (id, force) => cached(`${W3B}/${id}`, ITEM_TTL, force);

  async function loadItemMarket(id, force) {
    const d = await torn(`/v2/market/${id}/itemmarket?offset=0`, ITEM_TTL, force);
    const ls = (d.itemmarket && d.itemmarket.listings) || [];
    return ls.length ? ls.reduce((m, l) => (l.price < m.price ? l : m)) : { price: 0, amount: 0 };
  }
  // seller id -> is_open, for bazaars Torn lists as selling this item
  async function loadBazaarOpen(id, force) {
    const d = await torn(`/v2/market/${id}/bazaar`, 2 * MIN, force);
    const map = {};
    for (const b of (d.bazaar && d.bazaar.specialized) || []) map[b.id] = b.is_open;
    return map;
  }
  async function loadItemInfo(id) {
    const c = store.get("info_" + id, null);
    if (c && Date.now() - c.t < 24 * 60 * MIN) return c.info;
    const d = await torn(`/v2/torn/${id}/items`, 60 * MIN);
    const info = (d.items || [])[0] || null;
    if (info) store.set("info_" + id, { t: Date.now(), info });
    return info;
  }
  const loadProfile = (pid, force) => torn(`/user/${pid}?selections=profile`, MIN, force);
  async function loadMyBazaar(force) {
    const d = await torn(`/user/?selections=bazaar`, 3 * MIN, force);
    return (d.bazaar || []).map((it) => ({
      id: +(it.ID ?? it.id ?? it.item_id ?? 0),
      name: it.name || "",
      qty: +(it.quantity ?? it.amount ?? 1),
      price: +(it.price ?? it.cost ?? 0),
      mv: +(it.market_price ?? it.market_value ?? 0),
    }));
  }

  // ---------------------------------------------------------------- price history (stored on this device)
  function recordHistory(id, low, mv) {
    if (!low) return;
    const now = Date.now();
    let h = store.get("h_" + id, []);
    const last = h[h.length - 1];
    if (last && now - last[0] < HIST_BUCKET) h[h.length - 1] = [last[0], low, mv || last[2] || 0];
    else h.push([now, low, mv || 0]);
    h = h.filter((p) => now - p[0] < HIST_KEEP).slice(-400);
    store.set("h_" + id, h);
  }
  // lowest price about `ms` ago, if history reaches back that far
  function priceAgo(h, ms) {
    const target = Date.now() - ms;
    if (!h.length || h[0][0] > target + ms * 0.15) return null;
    let best = h[0];
    for (const p of h) if (Math.abs(p[0] - target) < Math.abs(best[0] - target)) best = p;
    return best[1];
  }
  function sparkline(h, days) {
    const pts = h.filter((p) => Date.now() - p[0] < days * 24 * 60 * MIN);
    if (pts.length < 2) return "";
    const W = 300,
      H = 64,
      t0 = pts[0][0],
      t1 = pts[pts.length - 1][0] || t0 + 1;
    const vals = pts.map((p) => p[1]);
    const mvs = pts.map((p) => p[2]).filter(Boolean);
    let lo = Math.min(...vals, ...mvs),
      hi = Math.max(...vals, ...mvs);
    if (hi === lo) (hi += 1), (lo -= 1);
    const x = (t) => ((t - t0) / (t1 - t0 || 1)) * (W - 4) + 2;
    const y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
    const line = pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ");
    const mvLine = pts.filter((p) => p[2]).map((p) => `${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" aria-label="Lowest price history">
      ${mvLine ? `<polyline points="${mvLine}" fill="none" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : ""}
      <polyline points="${line}" fill="none" stroke="var(--g)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>
    <div class="muted small">low ${short(Math.min(...vals))} · high ${short(Math.max(...vals))}${mvLine ? " · dashed line = market value" : ""}</div>`;
  }

  // ---------------------------------------------------------------- formatting
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
  const short = (n) => {
    if (n == null || !isFinite(n)) return "—";
    const a = Math.abs(n),
      s = n < 0 ? "-$" : "$";
    if (a >= 1e9) return s + (a / 1e9).toFixed(2).replace(/\.?0+$/, "") + "b";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2).replace(/\.?0+$/, "") + "m";
    if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return s + Math.round(a);
  };
  const ago = (sec) => {
    if (!sec) return "?";
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 60) return "<1m";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  };
  // "1.5m", "250k", "1,200,000" -> number
  const parseMoney = (s) => {
    s = String(s || "").toLowerCase().replace(/[$,\s]/g, "");
    const m = s.match(/^(\d*\.?\d+)([kmb])?$/);
    if (!m) return 0;
    return Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1));
  };
  const pct = (p, mv) => (mv > 0 && p > 0 ? ((p - mv) / mv) * 100 : null);
  const pctTxt = (v) => (v == null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`);
  const pctPill = (v, invert) => {
    if (v == null) return "";
    const good = invert ? v >= 5 : v <= -5,
      bad = invert ? v <= -5 : v >= 5;
    return `<span class="pill ${good ? "good" : bad ? "bad" : "even"}">${pctTxt(v)}</span>`;
  };
  const img = (id) => `https://www.torn.com/images/items/${id}/medium.png`;
  const bazaarUrl = (pid) => `https://www.torn.com/bazaar.php?userId=${pid}#/`;
  const profileUrl = (pid) => `https://www.torn.com/profiles.php?XID=${pid}`;
  const marketUrl = (id) => `https://www.torn.com/page.php?sid=ItemMarket#/market/view=search&itemID=${id}`;
  // Item Market fees: the sales fee, plus 10% when listing anonymously unless a company special waives it.
  const anonFee = () => (S.anon && !S.anonWaived ? 10 : 0);
  const feePct = () => (+S.fee || 0) + anonFee();
  const feeLabel = () => (anonFee() ? `Torn's fees (${+S.fee || 0}% sale + ${anonFee()}% anonymous)` : `Torn's ${feePct()}% sales fee`);
  const feeShort = () => (anonFee() ? `the ${feePct()}% fees` : `the ${feePct()}% fee`);
  const afterFee = (price) => Math.floor(price * (1 - feePct() / 100));
  // Profit from buying at `cost` and listing on the Item Market $1 under `imLow`, after fees.
  const flipProfit = (cost, imLow) => (imLow > 1 ? afterFee(imLow - 1) - cost : null);

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      ta.remove();
      return ok;
    }
  }

  // ---------------------------------------------------------------- bazaar page highlight
  // When you open a bazaar from Bazaar Plus, the item you were looking at gets outlined there.
  function highlightOnBazaar() {
    if (!/\/bazaar\.php/.test(location.pathname)) return;
    const req = store.get("highlight", null);
    if (!req || Date.now() - req.t > HIGHLIGHT_TTL) return;
    const owner = +(new URLSearchParams(location.search).get("userId") || 0);
    if (owner && req.seller && owner !== req.seller) return;
    let tries = 0;
    const timer = setInterval(() => {
      const imgs = [...document.querySelectorAll(`img[src*="/images/items/${req.id}/"]`)];
      if (imgs.length || ++tries > 40) clearInterval(timer);
      imgs.forEach((im, i) => {
        const box = im.closest("[class*='item___'], [class*='itemDescription'], li, [class*='row']") || im.parentElement;
        box.style.outline = "3px solid #7fdc6f";
        box.style.outlineOffset = "2px";
        box.style.borderRadius = "6px";
        if (i === 0) box.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }, 500);
  }

  // ---------------------------------------------------------------- UI shell
  const host = document.createElement("div");
  host.id = "bazaar-plus";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style>
    <button class="fab" data-act="toggle" title="Bazaar Plus (drag to move)"><span class="fab-ico">🛒</span><span class="fab-badge" hidden></span></button>
    <div class="scrim" data-act="close" hidden></div>
    <section class="panel" hidden role="dialog" aria-label="Bazaar Plus">
      <header class="top">
        <button class="ib" data-act="back" title="Back" hidden>‹</button>
        <div class="title">Bazaar Plus</div>
        <button class="ib" data-act="settings" title="Settings">⚙</button>
        <button class="ib" data-act="close" title="Close">✕</button>
      </header>
      <div class="body"></div>
    </section>
    <div class="alert" hidden role="alert"></div>
    <div class="helper" hidden></div>
    <div class="toast" hidden></div>`;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const body = () => $(".body");

  const view = {
    name: "home",
    id: 0,
    data: null,
    market: undefined,
    marketErr: null,
    open: null, // seller id -> is_open
    info: undefined,
    infoErr: null,
    infoOpen: false,
    sellers: {}, // seller id -> { loading, data, err }
    histDays: 7,
    buy: 0,
    q: "",
    timer: 0,
    contextId: 0,
    refreshing: false,
    mine: null, // { items, err, at }
    stack: [],
  };

  function open() {
    $(".panel").hidden = false;
    $(".scrim").hidden = false;
    render();
  }
  function close() {
    $(".panel").hidden = true;
    $(".scrim").hidden = true;
    stopAuto();
  }
  const isOpen = () => !$(".panel").hidden;

  let toastT = 0;
  function toast(msg, kind, ms = 2200) {
    const t = $(".toast");
    t.textContent = msg;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastT);
    if (ms) toastT = setTimeout(() => (t.hidden = true), ms);
  }

  function go(name, id, noPush) {
    stopAuto();
    if (!noPush && view.name !== name) view.stack.push(view.name === "item" ? { name: "item", id: view.id } : { name: view.name });
    if (view.stack.length > 20) view.stack.shift();
    view.name = name;
    if (name === "item") {
      view.id = id;
      view.data = null;
      view.market = undefined;
      view.marketErr = null;
      view.open = null;
      view.info = undefined;
      view.infoErr = null;
      view.infoOpen = false;
      view.sellers = {};
      view.buy = 0;
      S.recent = [id, ...S.recent.filter((x) => x !== id)].slice(0, 12);
      save();
    }
    render();
    body().scrollTop = 0;
    if (name === "item") fetchItem(false);
    if (name === "mine") fetchMine(false);
  }
  function back() {
    const prev = view.stack.pop() || { name: "home" };
    if (prev.name === "item") go("item", prev.id, true);
    else go(prev.name, 0, true);
  }

  function render() {
    $("[data-act=back]").hidden = view.name === "home";
    const titles = { settings: "Settings", deals: "Deal finder", mine: "My bazaar", item: itemName(view.id) };
    $(".title").textContent = titles[view.name] || "Bazaar Plus";
    ({ home: renderHome, item: renderItem, settings: renderSettings, deals: renderDeals, mine: renderMine })[view.name]();
  }

  // ---------------------------------------------------------------- home / search
  function renderHome() {
    const watched = Object.entries(S.watch);
    const under = (view.mine && view.mine.items ? view.mine.items.filter((m) => m.under).length : 0) || undercutCount();
    body().innerHTML = `
      <div class="search">
        <input class="q" type="search" placeholder="Search items… (e.g. xanax, feathery)" value="${esc(view.q)}" autocomplete="off" enterkeyhint="search">
      </div>
      <div class="results"></div>
      ${view.contextId ? `<button class="ctx" data-act="item" data-id="${view.contextId}">On this page: <b>${esc(itemName(view.contextId))}</b> →</button>` : ""}
      <div class="tiles">
        <button class="tile" data-act="deals"><span>🔥</span><b>Deal finder</b><small>items under market value</small></button>
        ${mineTile(under)}
      </div>
      ${watched.length ? `<h3>★ Watchlist</h3><div class="list watch">${watched.map(([id, w]) => watchRow(+id, w)).join("")}</div>` : ""}
      ${S.recent.length ? `<h3>Recent</h3><div class="chips">${S.recent.map((id) => `<button class="chip" data-act="item" data-id="${id}">${esc(itemName(id))}</button>`).join("")}</div>` : ""}
      ${!watched.length && !S.recent.length ? `<p class="muted hint">Type an item name to see every tracked bazaar selling it, cheapest first. Tap ☆ on an item to watch it with a target price.</p>` : ""}
      <p class="foot muted">Bazaar data: TornW3B (weav3r.dev). Prices move fast, so check in the bazaar before you buy.</p>`;
    const q = $(".q");
    q.addEventListener("input", () => {
      view.q = q.value;
      renderResults();
    });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = $(".results [data-act=item]");
        if (first) first.click();
      }
    });
    if (!itemList)
      loadItems()
        .then(() => view.name === "home" && renderHome())
        .catch((e) => ($(".results").innerHTML = `<p class="err">Couldn't load the item list (${esc(e.message)}). <button class="link" data-act="retryItems">Retry</button></p>`));
    renderResults();
    if (!matchMedia("(pointer: coarse)").matches) q.focus();
  }

  const mineTile = (under) =>
    `<button class="tile ${under ? "warn" : ""}" data-act="mine"><span>🏪</span><b>My bazaar</b><small>${apiKey() ? (under ? `${under} undercut` : "prices vs cheapest") : "needs API key"}</small></button>`;

  function watchRow(id, w) {
    const it = itemById(id);
    const low = it ? it.lowest_price : 0;
    const hit = low && w.target && low <= w.target;
    const h = store.get("h_" + id, []);
    const d1 = priceAgo(h, 24 * 60 * MIN);
    return `<button class="row wrow ${hit ? "hit" : ""}" data-act="item" data-id="${id}">
      <img src="${img(id)}" alt="" loading="lazy">
      <span class="nm">${esc(w.name || itemName(id))}<small>${w.target ? "target " + short(w.target) : "no target"}${d1 && low ? " · 24h " + pctTxt(pct(low, d1)) : ""}</small></span>
      <span class="rt"><b>${low ? money(low) : "—"}</b><small>${hit ? `<span class="g">✓ at target</span>` : it && it.market_price ? "MV " + short(it.market_price) : ""}</small></span>
    </button>`;
  }

  function renderResults() {
    const box = $(".results");
    if (!box) return;
    const q = view.q.trim().toLowerCase();
    if (!q || !itemList) return (box.innerHTML = "");
    const words = q.split(/\s+/);
    const scored = [];
    for (const it of itemList) {
      const n = it.item_name.toLowerCase();
      if (String(it.item_id) === q) scored.push([0, it]);
      else if (words.every((w) => n.includes(w))) scored.push([n === q ? 0 : n.startsWith(q) ? 1 : n.split(/\s+/).some((p) => p.startsWith(words[0])) ? 2 : 3, it]);
    }
    scored.sort((a, b) => a[0] - b[0] || (b[1].total_bazaars || 0) - (a[1].total_bazaars || 0));
    const top = scored.slice(0, 25).map((x) => x[1]);
    box.innerHTML = top.length ? `<div class="list">${top.map(itemRow).join("")}</div>` : `<p class="muted hint">No items match “${esc(view.q)}”.</p>`;
  }
  const itemRow = (it, extra) => `<button class="row" data-act="item" data-id="${it.item_id}">
        <img src="${img(it.item_id)}" alt="" loading="lazy">
        <span class="nm">${esc(it.item_name)}<small>${esc(it.type || "")}${it.total_bazaars ? " · " + it.total_bazaars + " bazaars" : ""}</small></span>
        <span class="rt"><b>${it.lowest_price ? money(it.lowest_price) : "—"}</b><small>${extra || (it.market_price ? "MV " + short(it.market_price) : "")}</small></span>
      </button>`;

  // ---------------------------------------------------------------- deal finder
  function renderDeals() {
    const f = S.deals;
    if (!itemList) {
      body().innerHTML = `<div class="spin"></div>`;
      loadItems()
        .then(() => view.name === "deals" && renderDeals())
        .catch((e) => (body().innerHTML = `<p class="err">Couldn't load prices (${esc(e.message)}). <button class="link" data-act="retryItems">Retry</button></p>`));
      return;
    }
    const types = [...new Set(itemList.map((i) => i.type).filter(Boolean))].sort();
    const rows = itemList
      .filter((i) => i.lowest_price > 1 && i.market_price >= Math.max(1, f.minMv) && (!f.maxPrice || i.lowest_price <= f.maxPrice) && (!f.type || i.type === f.type))
      .map((i) => ({ i, off: ((i.market_price - i.lowest_price) / i.market_price) * 100, gain: i.market_price - i.lowest_price }))
      .filter((r) => r.off >= f.minPct)
      .sort(f.sort === "gain" ? (a, b) => b.gain - a.gain : (a, b) => b.off - a.off)
      .slice(0, 100);
    body().innerHTML = `
      <div class="filters">
        <label>Min % off<input class="df" data-f="minPct" type="number" inputmode="numeric" value="${f.minPct}"></label>
        <label>Max price<input class="df" data-f="maxPrice" inputmode="decimal" placeholder="any" value="${f.maxPrice ? short(f.maxPrice).slice(1) : ""}"></label>
        <label>Category<select class="df" data-f="type"><option value="">All</option>${types.map((t) => `<option ${f.type === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      </div>
      <div class="filters two">
        <label>Min market value<input class="df" data-f="minMv" inputmode="decimal" value="${short(f.minMv).slice(1)}"></label>
        <div class="sorts slim">${[["pct", "% off"], ["gain", "$ off"]].map(([k, t]) => `<button class="seg ${f.sort === k ? "on" : ""}" data-act="dealSort" data-k="${k}">${t}</button>`).join("")}</div>
      </div>
      <div class="count muted small">${rows.length}${rows.length === 100 ? "+" : ""} deals · prices from ${ago(itemListAt / 1000)} ago <button class="link small" data-act="reloadDeals">refresh</button></div>
      <div class="list">${
        rows.length
          ? rows.map((r) => itemRow(r.i, `<span class="g">${r.off.toFixed(0)}% off</span> · MV ${short(r.i.market_price)}`)).join("")
          : `<p class="muted hint">Nothing matches. Try a lower % or a different category.</p>`
      }</div>
      <p class="foot muted">Uses each item's cheapest tracked bazaar price, which may be only 1 unit, a closed bazaar or already sold. Tap an item to check its listings.</p>`;
    $$(".df").forEach((el) =>
      el.addEventListener("change", () => {
        const k = el.dataset.f;
        f[k] = k === "type" ? el.value : k === "minPct" ? parseFloat(el.value) || 0 : parseMoney(el.value);
        save();
        renderDeals();
      })
    );
  }

  // ---------------------------------------------------------------- my bazaar / undercut
  // An item is undercut when the cheapest tracked bazaar price is below yours. The cheapest can't be yours then.
  function markUndercut(items) {
    for (const m of items) {
      const it = itemById(m.id);
      m.low = it ? it.lowest_price : 0;
      m.mvW = it ? it.market_price : 0;
      m.under = !!(m.low && m.price && m.low < m.price);
    }
    return items;
  }
  function undercutCount() {
    const last = store.get("mine", null);
    return last ? markUndercut(last.items).filter((m) => m.under).length : 0;
  }
  async function fetchMine(force) {
    if (!apiKey()) return render();
    try {
      await loadItems(force && Date.now() - itemListAt > MIN).catch(() => {}); // a list from the last minute is fresh enough
      const items = markUndercut(await loadMyBazaar(force));
      view.mine = { items, at: Date.now() };
      store.set("mine", { t: Date.now(), items: items.map(({ id, name, qty, price, mv }) => ({ id, name, qty, price, mv })) });
    } catch (e) {
      view.mine = { err: e.message };
    }
    if (view.name === "mine") render();
    const tile = view.name === "home" && $("[data-act=mine]");
    if (tile) tile.outerHTML = mineTile(view.mine.items ? view.mine.items.filter((m) => m.under).length : 0);
    updateBadge();
  }
  function renderMine() {
    if (!apiKey()) {
      body().innerHTML = `<p class="hint">Undercut alerts need a Torn API key (Public is enough) to read your bazaar. <button class="link" data-act="settings">Add one in settings</button>.</p>`;
      return;
    }
    const m = view.mine;
    if (!m) return void (body().innerHTML = `<div class="spin"></div>`);
    if (m.err) return void (body().innerHTML = `<p class="err">Couldn't read your bazaar (${esc(m.err)}). <button class="link" data-act="refreshMine">Retry</button></p>`);
    const items = [...m.items].sort((a, b) => b.under - a.under || (b.price - b.low) - (a.price - a.low));
    body().innerHTML = `
      <div class="count muted small">${items.length} item(s) in your bazaar · ${items.filter((i) => i.under).length} undercut · checked ${ago(m.at / 1000)} ago <button class="link small" data-act="refreshMine">refresh</button></div>
      <div class="list">${
        items.length
          ? items
              .map(
                (i) => `<button class="row ${i.under ? "under" : ""}" data-act="item" data-id="${i.id}">
          <img src="${img(i.id)}" alt="" loading="lazy">
          <span class="nm">${esc(i.name || itemName(i.id))}<small>you: ${money(i.price)} × ${i.qty}</small></span>
          <span class="rt"><b class="${i.under ? "r" : "g"}">${i.low ? money(i.low) : "—"}</b><small>${i.under ? `undercut by ${short(i.price - i.low)}` : i.low ? "you're cheapest" : "no data"}</small></span>
        </button>`
              )
              .join("")
          : `<p class="muted hint">Your bazaar is empty.</p>`
      }</div>
      <p class="foot muted">Compared with TornW3B's cheapest tracked price, refreshed every ${MONITOR_INTERVAL / MIN} minutes. Turn alerts on or off in settings.</p>`;
  }

  // ---------------------------------------------------------------- item view
  // manual = the user tapped refresh: show progress, keep the old listings on failure, confirm on success.
  async function fetchItem(force, manual) {
    const id = view.id;
    const still = () => view.name === "item" && view.id === id;
    if (manual) {
      if (view.refreshing) return;
      view.refreshing = true;
      toast("Refreshing…", "busy", 0);
      if (view.data) renderItem();
    }
    const t0 = Date.now();
    const done = async (ok, msg) => {
      if (manual) {
        await sleep(Math.max(0, 600 - (Date.now() - t0))); // let the spinner be seen
        view.refreshing = false;
        if (still()) renderItem();
        toast(msg, ok ? "ok" : "bad", ok ? 1800 : 3500);
      }
    };
    try {
      const d = await loadListings(id, force);
      if (!still()) return void (view.refreshing = false);
      view.data = d;
      view.updated = Date.now();
      const real = realListings(d.listings || []);
      if (real.length) recordHistory(id, Math.min(...real.map((l) => l.price)), d.market_price);
      if (!manual) renderItem();
    } catch (e) {
      if (!still()) return void (view.refreshing = false);
      if (manual && view.data) return done(false, "Refresh failed: " + e.message); // keep what we had
      view.refreshing = false;
      body().innerHTML = `<p class="err">Couldn't load listings (${esc(e.message)}). <button class="link" data-act="refresh">Retry</button></p>`;
      return;
    }
    if (apiKey()) {
      const m = Promise.all([
        loadItemMarket(id, force).then(
          (v) => ((view.market = v), (view.marketErr = null)),
          (e) => (view.marketErr = e.message)
        ),
        loadBazaarOpen(id, force).then(
          (v) => (view.open = v),
          () => {}
        ),
      ]).then(() => !manual && still() && renderItem());
      if (manual) await m;
    }
    if (S.autoRefresh) startAuto();
    await done(true, "Refreshed ✓");
  }
  function startAuto() {
    stopAuto();
    view.timer = setInterval(() => isOpen() && view.name === "item" && fetchItem(true), 30000);
  }
  function stopAuto() {
    clearInterval(view.timer);
    view.timer = 0;
  }

  const realListings = (all) => all.filter((l) => !S.hidden[l.player_id] && !(S.hideOwn && myId && l.player_id === myId));
  function filtered(all) {
    const now = Date.now() / 1000;
    return realListings(all).filter(
      (l) => l.quantity >= (S.minQty || 1) && (!S.maxPrice || l.price <= S.maxPrice) && (!S.maxAge || (l.content_updated && now - l.content_updated <= S.maxAge * 60))
    );
  }
  const SORTS = {
    price: (a, b) => a.price - b.price || b.quantity - a.quantity,
    qty: (a, b) => b.quantity - a.quantity || a.price - b.price,
    fresh: (a, b) => (b.content_updated || 0) - (a.content_updated || 0) || a.price - b.price,
    total: (a, b) => b.price * b.quantity - a.price * a.quantity,
  };

  // Cheapest way to buy n units: walk listings by price, take what each one has.
  function plan(listings, n) {
    const take = new Map();
    let left = n,
      cost = 0;
    for (const l of [...listings].sort(SORTS.price)) {
      if (left <= 0) break;
      const t = Math.min(left, l.quantity);
      take.set(l, t);
      cost += t * l.price;
      left -= t;
    }
    return { take, cost, got: n - left, sellers: take.size };
  }

  const STATE_CLS = { Okay: "g", Hospital: "r", Jail: "r", Federal: "r", Fallen: "r", Traveling: "a", Abroad: "a" };
  function sellerBox(pid) {
    const s = view.sellers[pid];
    if (!s) return "";
    if (s.loading) return `<div class="sbox muted small">Loading player…</div>`;
    if (s.err) return `<div class="sbox err small">${esc(s.err)}</div>`;
    const p = s.data,
      st = p.status || {},
      la = p.last_action || {};
    const open = view.open && pid in view.open ? view.open[pid] : null;
    return `<div class="sbox small">
      <div><span class="${STATE_CLS[st.state] || ""}">● ${esc(st.description || st.state || "?")}</span>${st.details ? ` <span class="muted">${esc(st.details)}</span>` : ""}</div>
      <div class="muted">Last action: ${esc(la.relative || "?")}${la.status ? ` (${esc(la.status)})` : ""} · Level ${esc(p.level ?? "?")}${open === false ? ` · <span class="r">bazaar closed</span>` : open ? ` · <span class="g">bazaar open</span>` : ""}</div>
    </div>`;
  }

  function infoBox() {
    if (!view.infoOpen) return "";
    if (!apiKey()) return `<div class="infobox small">Item info needs a Torn API key. <button class="link small" data-act="settings">Add one</button></div>`;
    if (view.infoErr) return `<div class="infobox small err">${esc(view.infoErr)}</div>`;
    const i = view.info;
    if (!i) return `<div class="infobox small muted">Loading…</div>`;
    const v = i.value || {};
    const rows = [
      ["Type", [i.type, i.sub_type].filter(Boolean).join(" · ")],
      ["Effect", i.effect],
      ["Requirement", i.requirement],
      ["Circulation", i.circulation != null ? (+i.circulation).toLocaleString() : ""],
      ["Shop price", v.buy_price ? money(v.buy_price) + (v.vendor ? ` at ${v.vendor.name}${v.vendor.country && v.vendor.country !== "Torn" ? ", " + v.vendor.country : ""}` : "") : ""],
      ["Sells to shop for", v.sell_price ? money(v.sell_price) : ""],
      ["Tradable", i.is_tradable === false ? "No" : ""],
    ].filter((r) => r[1]);
    return `<div class="infobox small">
      ${i.description ? `<p>${esc(i.description)}</p>` : ""}
      <dl>${rows.map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join("")}</dl>
    </div>`;
  }

  // Explains the buy-in-a-bazaar, resell-on-the-Item-Market sum line by line.
  function flipBox(cost, imLow, profit) {
    const sell = imLow - 1,
      fee = sell - afterFee(sell),
      gap = sell - cost;
    const close = Math.abs(profit) <= cost * 0.01;
    const cls = close ? "even" : profit > 0 ? "pos" : "neg";
    let verdict;
    if (close)
      verdict = `<b class="a">About break-even: around ${money(Math.abs(profit))} ${profit >= 0 ? "profit" : "loss"} per item.</b> It's probably not worth the risk, since one cheaper listing would wipe it out.`;
    else if (profit > 0)
      verdict = `<b class="g">You'd make ${money(profit)} per item.</b> Prices can change before you resell, so check the Item Market price again before buying.`;
    else if (gap <= 0)
      verdict = `<b class="r">You'd lose ${money(-profit)} per item.</b> The Item Market is already cheaper than the cheapest bazaar, so there's nothing to flip right now.`;
    else
      verdict = `<b class="r">You'd lose ${money(-profit)} per item.</b> The gap between the two markets (${money(gap)}) is smaller than the fee, so this isn't worth it right now.`;
    return `<div class="flip ${cls}">
      <div class="flip-h">Flip check: buy here, resell on the Item Market</div>
      <dl class="flip-rows">
        <dt>Buy 1 from the cheapest bazaar</dt><dd>${money(cost)}</dd>
        <dt>Sell on the Item Market for <small>($1 under the cheapest listing)</small></dt><dd>${money(sell)}</dd>
        <dt>${feeLabel()}</dt><dd class="r">−${money(fee)}</dd>
        <dt>You'd receive</dt><dd><b>${money(sell - fee)}</b></dd>
      </dl>
      <div class="flip-v">${verdict}</div>
    </div>`;
  }

  function renderItem() {
    const id = view.id;
    const base = itemById(id) || {};
    if (!view.data) {
      body().innerHTML = `<div class="ihead"><img src="${img(id)}" alt=""><div><div class="iname">${esc(itemName(id))}</div><div class="muted">Loading bazaar listings…</div></div></div><div class="spin"></div>`;
      return;
    }
    const d = view.data;
    const mv = d.market_price || base.market_price || 0;
    const all = (d.listings || []).slice();
    const shown = filtered(all).sort(SORTS[S.sort] || SORTS.price);
    // Headline numbers ignore your own bazaar and sellers you hid, but not the other filters.
    const real = realListings(all);
    const cheapest = real.length ? Math.min(...real.map((l) => l.price)) : 0;
    const totalQty = all.reduce((s, l) => s + l.quantity, 0);
    const im = view.market;
    const imLow = im && im.price ? im.price : 0;
    const w = S.watch[id];
    const p = view.buy > 0 ? plan(shown, view.buy) : null;
    const cheap5 = [...real].sort(SORTS.price).slice(0, 5);
    const avg5 = cheap5.length ? cheap5.reduce((s, l) => s + l.price, 0) / cheap5.length : 0;
    const h = store.get("h_" + id, []);
    const d1 = priceAgo(h, 24 * 60 * MIN),
      d7 = priceAgo(h, 7 * 24 * 60 * MIN);
    const flip1 = cheapest ? flipProfit(cheapest, imLow) : null;
    const flipN = p && p.got && imLow ? flipProfit(0, imLow) * p.got - p.cost : null;

    body().innerHTML = `
      <div class="ihead">
        <img src="${img(id)}" alt="">
        <div class="grow">
          <div class="iname">${esc(d.item_name || itemName(id))}</div>
          <div class="muted small">#${id}${base.type ? " · " + esc(base.type) : ""} · updated ${ago((view.updated || Date.now()) / 1000)}${S.autoRefresh ? " · live" : ""}</div>
        </div>
        <button class="ib star ${w ? "on" : ""}" data-act="watch" title="${w ? "Remove from watchlist" : "Add to watchlist"}">${w ? "★" : "☆"}</button>
        <button class="ib ${view.refreshing ? "spinning" : ""}" data-act="refresh" title="Refresh" ${view.refreshing ? "disabled" : ""}>⟳</button>
      </div>

      <div class="stats">
        <div class="stat"><span>Lowest bazaar</span><b class="g">${money(cheapest || null)}</b>${pctPill(pct(cheapest, mv))}
          ${cheapest ? `<button class="mini" data-act="copy" data-v="${cheapest}">copy</button>` : ""}</div>
        <div class="stat"><span>Market value</span><b>${money(mv || null)}</b><small>avg of 5 cheapest ${short(avg5)}</small></div>
        <div class="stat"><span>Item Market</span>${
          !apiKey()
            ? `<button class="link small" data-act="settings">add API key</button>`
            : view.marketErr
              ? `<small class="err">${esc(view.marketErr)}</small>`
              : im === undefined
                ? `<small class="muted">loading…</small>`
                : imLow
                  ? `<b>${money(imLow)}</b><button class="mini" data-act="copy" data-v="${imLow}">copy</button>${cheapest ? (cheapest < imLow ? `<small class="g">bazaar ${short(imLow - cheapest)} cheaper</small>` : `<small class="r">market ${short(cheapest - imLow)} cheaper</small>`) : ""}`
                  : `<small class="muted">none listed</small>`
        }</div>
        <div class="stat"><span>Supply</span><b>${totalQty.toLocaleString()}</b><small>${all.length} bazaars</small></div>
      </div>

      ${
        imLow && cheapest
          ? flipBox(cheapest, imLow, flip1)
          : ""
      }

      <div class="hist">
        <div class="hist-top">
          <b>Price history</b>
          <span class="muted small">${d1 && cheapest ? `24h ${pctTxt(pct(cheapest, d1))}` : ""}${d7 && cheapest ? ` · 7d ${pctTxt(pct(cheapest, d7))}` : ""}</span>
          <span class="grow"></span>
          ${[7, 30, 120].map((n) => `<button class="seg mini2 ${view.histDays === n ? "on" : ""}" data-act="histDays" data-k="${n}">${n}d</button>`).join("")}
        </div>
        ${sparkline(h, view.histDays) || `<p class="muted small">History is saved on this device each time you check this item (or every ${MONITOR_INTERVAL / MIN} min if it's on your watchlist). Check back later to see a chart.</p>`}
      </div>

      ${w ? `<div class="target">★ Target price <input class="tgt" inputmode="decimal" placeholder="e.g. 800k" value="${w.target ? short(w.target).slice(1) : ""}"> ${w.target && cheapest && cheapest <= w.target ? `<span class="pill good">hit!</span>` : ""}</div>` : ""}

      <div class="calc">
        <label>Buy <input class="buy" type="number" min="0" inputmode="numeric" placeholder="qty" value="${view.buy || ""}"></label>
        <div class="calc-out">${
          p
            ? p.got < view.buy
              ? `<span class="r">Only ${p.got.toLocaleString()} available</span> · ${money(p.cost)}`
              : `<b>${money(p.cost)}</b> · avg ${money(p.cost / p.got)} · ${p.sellers} seller${p.sellers > 1 ? "s" : ""}${mv ? " · " + pctPill(pct(p.cost / p.got, mv)) : ""}${flipN != null ? `<div class="calc-flip"><b>If you resell all ${p.got.toLocaleString()} on the Item Market:</b> <span class="${flipN > 0 ? "g" : "r"}">you'd ${flipN > 0 ? "make" : "lose"} ${money(Math.abs(flipN))} in total</span>, after ${feeShort()}.</div>` : ""}`
            : `<span class="muted">Enter a quantity to see the cheapest total</span>`
        }</div>
      </div>

      <button class="disclose" data-act="info">${view.infoOpen ? "▾" : "▸"} Item info</button>
      ${infoBox()}

      <div class="filters">
        <label>Min qty<input class="f" data-f="minQty" type="number" min="1" inputmode="numeric" value="${S.minQty || 1}"></label>
        <label>Max price<input class="f" data-f="maxPrice" inputmode="decimal" placeholder="any" value="${S.maxPrice ? short(S.maxPrice).slice(1) : ""}"></label>
        <label>Updated<select class="f" data-f="maxAge">
          ${[[0, "any time"], [15, "≤ 15 min"], [60, "≤ 1 hour"], [360, "≤ 6 hours"], [1440, "≤ 24 hours"]].map(([v, t]) => `<option value="${v}" ${+S.maxAge === v ? "selected" : ""}>${t}</option>`).join("")}
        </select></label>
      </div>
      <div class="sorts">
        ${[["price", "Cheapest"], ["qty", "Most qty"], ["fresh", "Newest"], ["total", "Biggest"]].map(([k, t]) => `<button class="seg ${S.sort === k ? "on" : ""}" data-act="sort" data-k="${k}">${t}</button>`).join("")}
      </div>

      <div class="count muted small">${shown.length}${shown.length !== all.length ? ` of ${all.length}` : ""} listings${Object.keys(S.hidden).length ? ` · ${Object.keys(S.hidden).length} hidden seller(s) <button class="link small" data-act="unhideAll">show</button>` : ""}</div>
      <div class="cards">${
        shown.length
          ? shown
              .map((l) => {
                const t = p && p.take.get(l);
                const deal = imLow && l.price < imLow;
                const closed = view.open && view.open[l.player_id] === false;
                return `<div class="card ${t ? "pick" : ""} ${closed ? "closed" : ""}">
            <div class="crow">
              <div class="c1">
                <div class="price">${money(l.price)} ${pctPill(pct(l.price, mv))}${deal ? ` <span class="pill deal">below market</span>` : ""}${closed ? ` <span class="pill bad">closed</span>` : ""}</div>
                <div class="seller"><a href="${profileUrl(l.player_id)}" target="_blank" rel="noopener">${esc(l.player_name)}</a> <span class="muted">[${l.player_id}]</span></div>
                <div class="meta muted small">qty <b>${l.quantity.toLocaleString()}</b> · total ${short(l.price * l.quantity)} · ${ago(l.content_updated)} ago${t ? ` · <span class="g">buy ${t.toLocaleString()}</span>` : ""}</div>
              </div>
              <div class="c2">
                <a class="btn" href="${bazaarUrl(l.player_id)}" data-act="openBazaar" data-seller="${l.player_id}">Open ↗</a>
                <div class="c2b">
                  <button class="ib sm" data-act="copy" data-v="${l.price}" title="Copy price">⧉</button>
                  <button class="ib sm ${view.sellers[l.player_id] ? "on" : ""}" data-act="seller" data-seller="${l.player_id}" title="Seller status">ⓘ</button>
                  <button class="ib sm" data-act="hide" data-seller="${l.player_id}" data-name="${esc(l.player_name)}" title="Hide this seller">⊘</button>
                </div>
              </div>
            </div>
            ${sellerBox(l.player_id)}
          </div>`;
              })
              .join("")
          : `<p class="muted hint">${all.length ? "No listings match your filters." : "Nobody has this listed in a tracked bazaar right now."}</p>`
      }</div>
      <p class="foot muted">TornW3B tracks the cheapest listings it has seen and skips $1 listings. Always confirm the price in the bazaar. <a href="${marketUrl(id)}">Open on Item Market ↗</a></p>`;

    const buy = $(".buy");
    buy.addEventListener("change", () => {
      view.buy = Math.max(0, parseInt(buy.value, 10) || 0);
      renderItem();
    });
    $$(".f").forEach((el) =>
      el.addEventListener("change", () => {
        const f = el.dataset.f;
        S[f] = f === "maxPrice" ? parseMoney(el.value) : Math.max(f === "minQty" ? 1 : 0, parseInt(el.value, 10) || 0);
        save();
        renderItem();
      })
    );
    const tgt = $(".tgt");
    if (tgt)
      tgt.addEventListener("change", () => {
        S.watch[id].target = parseMoney(tgt.value);
        save();
        renderItem();
        monitor(false);
      });
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    const key = apiKey();
    const tog = (k, label) => `<label class="tog"><input type="checkbox" data-s="${k}" ${S[k] ? "checked" : ""}> ${label}</label>`;
    body().innerHTML = `
      <div class="form">
        <label class="blk">Torn API key <small class="muted">(Public is enough, optional)</small>
          <input class="key" type="password" autocomplete="off" placeholder="${!S.apiKey && key ? "using Torn PDA key" : "16 characters"}" value="${esc(S.apiKey)}">
        </label>
        <p class="muted small">Used for Item Market prices, item info, seller status and your own bazaar. Stored on this device and only sent to api.torn.com.${PDA_KEY.includes("#") ? "" : " In Torn PDA your key is used automatically if this is empty."}</p>

        <h3>Listings</h3>
        ${tog("hideOwn", "Hide my own bazaar")}
        ${tog("autoRefresh", "Auto-refresh listings every 30s while open")}
        ${tog("marketBadge", "On the Item Market, show the lowest bazaar price on the 🛒 button")}

        <h3>Selling</h3>
        ${tog("priceHelper", "Price helper when I type a price on my bazaar or the Item Market")}
        <label class="tog">Undercut by $<input class="num" data-n="undercutBy" type="number" min="0" inputmode="numeric" value="${S.undercutBy}"></label>
        <label class="tog col"><span><input type="checkbox" data-s="anon" ${S.anon ? "checked" : ""}> <b>I sell anonymously on the Item Market</b></span>
          <small class="muted">Adds Torn's 10% anonymous fee to the flip numbers (15% in total).</small></label>
        <label class="tog col"><span><input type="checkbox" data-s="anonWaived" ${S.anonWaived ? "checked" : ""}> <b>I have the 5★ Car Dealership or 5★ Property Broker special</b></span>
          <small class="muted">These remove the 10% anonymous fee. Only matters if the switch above is on.</small></label>
        <label class="tog col"><span class="feerow"><b>Item Market sales fee</b><input class="num" data-n="fee" type="number" min="0" max="50" step="0.5" inputmode="decimal" value="${S.fee}"><b>%</b></span>
          <small class="muted">Torn's standard fee since June 2025. Only change this if Torn changes it.</small></label>
        <p class="muted small">Fees used for flip numbers right now: <b class="feenow">${feePct()}%</b></p>

        <h3>Alerts</h3>
        ${tog("undercut", "Check my bazaar for undercuts (every 10 min, needs API key)")}
        ${tog("alertPopup", "Pop-up when a watched item hits my target or I'm undercut")}
        ${tog("alertVibrate", "Vibrate with the pop-up")}
        <button class="btn ghost" data-act="testAlert">Test alert</button>

        <h3>Hidden sellers</h3>
        ${
          Object.keys(S.hidden).length
            ? `<div class="chips">${Object.entries(S.hidden).map(([pid, n]) => `<button class="chip" data-act="unhide" data-seller="${pid}">${esc(n)} ✕</button>`).join("")}</div>`
            : `<p class="muted small">None. Tap ⊘ on a listing to hide a seller (for example someone who never sells).</p>`
        }
        <h3>Other</h3>
        <button class="btn ghost" data-act="resetFab">Reset 🛒 button position</button>
        <button class="btn ghost" data-act="clearRecent">Clear recent</button>
        <button class="btn ghost" data-act="reloadItems">Reload item list</button>
        <button class="btn ghost" data-act="clearHistory">Clear price history</button>
        <p class="muted small">Tip: drag the 🛒 button to move it.</p>
      </div>`;
    $(".key").addEventListener("change", (e) => {
      S.apiKey = e.target.value.trim();
      save();
      memo.clear();
      toast("Saved");
    });
    $$("[data-s]").forEach((el) =>
      el.addEventListener("change", () => {
        S[el.dataset.s] = el.checked;
        save();
        const fn = $(".feenow");
        if (fn) fn.textContent = feePct() + "%";
        if (el.dataset.s === "marketBadge") onRoute();
        if (el.dataset.s === "undercut") monitor(true);
      })
    );
    $$("[data-n]").forEach((el) =>
      el.addEventListener("change", () => {
        S[el.dataset.n] = Math.max(0, parseFloat(el.value) || 0);
        save();
        const fn = $(".feenow");
        if (fn) fn.textContent = feePct() + "%";
        toast("Saved");
      })
    );
  }

  // ---------------------------------------------------------------- actions
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const seller = +el.dataset.seller || 0;
    switch (act) {
      case "toggle":
        if (fabDragged) return;
        if (isOpen()) return close();
        if (view.contextId && view.name === "home") go("item", view.contextId);
        open();
        if (view.name === "item" && view.data) fetchItem(false);
        break;
      case "close":
        close();
        break;
      case "back":
        back();
        break;
      case "settings":
      case "deals":
      case "mine":
        go(act);
        break;
      case "item":
        go("item", +el.dataset.id);
        if (!isOpen()) open();
        break;
      case "refresh":
        fetchItem(true, true);
        break;
      case "refreshMine":
        view.mine = null;
        renderMine();
        fetchMine(true);
        break;
      case "reloadDeals":
        loadItems(true)
          .then(() => toast("Prices updated", "ok"))
          .catch((er) => toast("Failed: " + er.message, "bad"))
          .then(() => view.name === "deals" && renderDeals());
        break;
      case "dealSort":
        S.deals.sort = el.dataset.k;
        save();
        renderDeals();
        break;
      case "sort":
        S.sort = el.dataset.k;
        save();
        renderItem();
        break;
      case "histDays":
        view.histDays = +el.dataset.k;
        renderItem();
        break;
      case "copy":
        toast((await copyText(el.dataset.v)) ? `Copied ${money(+el.dataset.v)}` : "Couldn't copy", "ok", 1500);
        break;
      case "info":
        view.infoOpen = !view.infoOpen;
        renderItem();
        if (view.infoOpen && view.info === undefined && apiKey()) {
          const id = view.id;
          loadItemInfo(id)
            .then((i) => (view.info = i || null), (er) => (view.infoErr = er.message))
            .then(() => view.name === "item" && view.id === id && renderItem());
        }
        break;
      case "seller":
        if (view.sellers[seller]) {
          delete view.sellers[seller];
          return renderItem();
        }
        if (!apiKey()) return toast("Seller status needs an API key", "bad");
        view.sellers[seller] = { loading: true };
        renderItem();
        loadProfile(seller)
          .then((d) => (view.sellers[seller] = { data: d }), (er) => (view.sellers[seller] = { err: er.message }))
          .then(() => view.name === "item" && renderItem());
        break;
      case "watch":
        if (S.watch[view.id]) delete S.watch[view.id];
        else S.watch[view.id] = { name: (view.data && view.data.item_name) || itemName(view.id), target: 0 };
        save();
        renderItem();
        updateBadge();
        break;
      case "hide":
        S.hidden[seller] = el.dataset.name || "#" + seller;
        save();
        renderItem();
        toast("Seller hidden");
        break;
      case "unhide":
        delete S.hidden[seller];
        save();
        renderSettings();
        break;
      case "unhideAll":
        S.hidden = {};
        save();
        renderItem();
        break;
      case "openBazaar":
        // Remember what we were looking at so the bazaar page can outline it. Navigation itself is the normal link.
        store.set("highlight", { id: view.id, seller, t: Date.now() });
        break;
      case "clearRecent":
        S.recent = [];
        save();
        toast("Cleared");
        break;
      case "clearHistory":
        Object.keys(localStorage)
          .filter((k) => k.startsWith("bzp_h_"))
          .forEach((k) => localStorage.removeItem(k));
        toast("History cleared");
        break;
      case "resetFab":
        S.fab = null;
        save();
        placeFab();
        toast("Button moved back");
        break;
      case "testAlert":
        showAlert([{ key: "test", id: 206, text: "Test alert: this is how alerts look" }]);
        break;
      case "reloadItems":
      case "retryItems":
        loadItems(true)
          .then(() => toast(`Loaded ${itemList.length} items`))
          .catch((er) => toast("Failed: " + er.message))
          .then(() => render());
        break;
      // alert banner
      case "alertView":
        alertQueue = [];
        hideAlert();
        go("item", +el.dataset.id);
        open();
        break;
      case "alertMine":
        alertQueue = alertQueue.filter((q) => !q.mine);
        $(".alert").hidden = true;
        go("mine");
        open();
        break;
      case "alertClose":
        hideAlert();
        break;
      // price helper
      case "fill":
        fillPrice(+el.dataset.v);
        break;
      case "helperClose":
        hideHelper(true);
        break;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // ---------------------------------------------------------------- draggable button
  let fabDragged = false;
  function placeFab() {
    const fab = $(".fab");
    const p = S.fab;
    if (!p) {
      fab.style.right = "14px";
      fab.style.bottom = "84px";
      return;
    }
    fab.style.right = Math.min(Math.max(4, p.right), innerWidth - 56) + "px";
    fab.style.bottom = Math.min(Math.max(4, p.bottom), innerHeight - 56) + "px";
  }
  function setupDrag() {
    const fab = $(".fab");
    let start = null;
    fab.addEventListener("pointerdown", (e) => {
      const r = fab.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom, moved: false };
      fabDragged = false;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      if (!start.moved && Math.hypot(dx, dy) < 8) return;
      start.moved = true;
      S.fab = { right: start.right - dx, bottom: start.bottom - dy };
      placeFab();
    });
    const end = () => {
      if (start && start.moved) {
        fabDragged = true; // swallow the click that follows a drag
        setTimeout(() => (fabDragged = false), 50);
        save();
      }
      start = null;
    };
    fab.addEventListener("pointerup", end);
    fab.addEventListener("pointercancel", end);
    addEventListener("resize", placeFab);
    placeFab();
  }

  // ---------------------------------------------------------------- alerts (watchlist targets + undercuts)
  let alertQueue = [];
  function showAlert(list, vibrate = true) {
    alertQueue = [...list, ...alertQueue.filter((q) => !list.some((l) => l.key === q.key))];
    if (!alertQueue.length) return;
    const a = $(".alert");
    const one = alertQueue[0];
    list = alertQueue;
    a.innerHTML = `<div class="al-txt">🔔 ${esc(one.text)}${list.length > 1 ? `<small>+${list.length - 1} more</small>` : ""}</div>
      <div class="al-btns">
        ${one.mine ? `<button class="btn sm" data-act="alertMine">View</button>` : `<button class="btn sm" data-act="alertView" data-id="${one.id}">View</button>`}
        <button class="ib sm" data-act="alertClose" title="Dismiss">✕</button>
      </div>`;
    a.hidden = false;
    if (vibrate && S.alertVibrate && navigator.vibrate) {
      try {
        navigator.vibrate([180, 90, 180]);
      } catch {}
    }
  }
  function hideAlert() {
    alertQueue.shift();
    if (alertQueue.length) showAlert([], false);
    else $(".alert").hidden = true;
  }

  let monitoring = false;
  async function monitor(forceFetch) {
    if (monitoring) return;
    monitoring = true;
    try {
      const last = store.get("monitorAt", 0);
      const due = forceFetch || Date.now() - last > MONITOR_INTERVAL;
      const hasWatch = Object.keys(S.watch).length > 0;
      const doUnder = S.undercut && apiKey();
      if (!hasWatch && !doUnder) return updateBadge();
      await loadItems(Date.now() - itemListAt > MONITOR_INTERVAL / 2).catch(() => {}); // reuse a list that's still fresh
      if (doUnder && (due || !view.mine)) await fetchMine(due);
      if (due) store.set("monitorAt", Date.now());

      const active = [];
      for (const [id, w] of Object.entries(S.watch)) {
        const it = itemById(+id);
        if (w.target && it && it.lowest_price && it.lowest_price <= w.target)
          active.push({ key: `w:${id}:${w.target}`, id: +id, text: `${it.item_name} is ${money(it.lowest_price)} (target ${short(w.target)})` });
      }
      if (doUnder && view.mine && view.mine.items)
        for (const m of view.mine.items.filter((x) => x.under))
          active.push({ key: `u:${m.id}:${m.price}:${m.low}`, id: m.id, mine: true, text: `Undercut: ${m.name || itemName(m.id)} at ${money(m.low)} (yours ${money(m.price)})` });

      // Alert only for things that weren't already alerted; forget ones that stopped being true.
      const seen = store.get("notified", {});
      const fresh = active.filter((a) => !seen[a.key]);
      const now = {};
      for (const a of active) now[a.key] = seen[a.key] || Date.now();
      store.set("notified", now);
      if (fresh.length && S.alertPopup) showAlert(fresh);
      updateBadge();
    } finally {
      monitoring = false;
    }
  }

  // ---------------------------------------------------------------- price helper (your bazaar / Item Market listing)
  // When you focus a price box next to an item, show the cheapest prices and offer to type one in for you.
  let helperInput = null,
    helperItem = 0,
    helperHideT = 0,
    helperState = null,
    helperFilled = 0;
  function isSellPage() {
    if (/\/bazaar\.php/.test(location.pathname)) return !new URLSearchParams(location.search).get("userId") || +new URLSearchParams(location.search).get("userId") === myId;
    return /sid=ItemMarket/i.test(location.search) && /add|sell|listing/i.test(location.hash);
  }
  function itemIdNear(el) {
    let n = el;
    for (let depth = 0; n && depth < 10; depth++, n = n.parentElement) {
      const ids = new Set(
        [...n.querySelectorAll("img[src*='/images/items/']")].map((im) => (im.getAttribute("src").match(/\/images\/items\/(\d+)\//) || [])[1]).filter(Boolean)
      );
      if (ids.size === 1) return +[...ids][0];
      if (ids.size > 1) return 0; // walked up into a list of several items
    }
    return 0;
  }
  function looksLikePrice(inp) {
    const t = (inp.type || "").toLowerCase();
    if (!["text", "number", "tel", ""].includes(t)) return false;
    const hint = [inp.name, inp.id, inp.className, inp.placeholder, inp.getAttribute("aria-label"), inp.dataset && inp.dataset.name].join(" ").toLowerCase();
    if (/qty|quantity|amount/.test(hint) && !/price/.test(hint)) return false;
    return /price|cost|\$/.test(hint) || /\$/.test((inp.parentElement && inp.parentElement.textContent) || "");
  }
  async function onFocusIn(e) {
    if (!S.priceHelper || !isSellPage()) return;
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement) || inp === host || !looksLikePrice(inp)) return;
    const id = itemIdNear(inp);
    if (!id) return;
    clearTimeout(helperHideT);
    if (id !== helperItem) helperFilled = 0;
    helperInput = inp;
    helperItem = id;
    renderHelper(null);
    try {
      const [d, im] = await Promise.all([loadListings(id), apiKey() ? loadItemMarket(id).catch(() => null) : null]);
      if (helperItem !== id) return;
      const real = (d.listings || []).filter((l) => !(myId && l.player_id === myId) && !S.hidden[l.player_id]);
      renderHelper({ low: real.length ? Math.min(...real.map((l) => l.price)) : 0, mv: d.market_price, im: im && im.price });
    } catch (er) {
      if (helperItem === id) renderHelper({ err: er.message });
    }
  }
  function renderHelper(s) {
    const box = $(".helper");
    const name = itemName(helperItem);
    const by = S.undercutBy || 0;
    if (!s) box.innerHTML = `<div class="hl-top"><b>${esc(name)}</b><span class="muted small">loading prices…</span><button class="ib sm" data-act="helperClose">✕</button></div>`;
    else if (s.err) box.innerHTML = `<div class="hl-top"><b>${esc(name)}</b><span class="err small">${esc(s.err)}</span><button class="ib sm" data-act="helperClose">✕</button></div>`;
    else {
      helperState = s;
      const onMarket = /sid=ItemMarket/i.test(location.search);
      const price = helperFilled || (s.im > by ? s.im - by : s.low > by ? s.low - by : 0);
      const receive = onMarket && anonFee() && price ? `<div class="hl-recv">You'll receive about <b>${money(afterFee(price))}</b> after ${feeShort()}${helperFilled ? "" : ` (at ${money(price)})`}.</div>` : "";
      const btn = (v, label) => (v > by ? `<button class="btn sm" data-act="fill" data-v="${v - by}">${label}: ${money(v - by)}</button>` : "");
      box.innerHTML = `<div class="hl-top"><b>${esc(name)}</b><span class="muted small">bazaar ${short(s.low || null)} · market ${short(s.im || null)} · MV ${short(s.mv || null)}</span><button class="ib sm" data-act="helperClose">✕</button></div>
        <div class="hl-btns">${btn(s.low, "Under bazaar")}${btn(s.im, "Under market")}${s.mv ? `<button class="btn sm ghost" data-act="fill" data-v="${s.mv}">Market value: ${money(s.mv)}</button>` : ""}</div>${receive}`;
    }
    const r = helperInput && helperInput.getBoundingClientRect();
    box.classList.toggle("bottom", !!r && r.top < innerHeight / 2);
    box.hidden = false;
  }
  function hideHelper(now) {
    clearTimeout(helperHideT);
    const doHide = () => {
      $(".helper").hidden = true;
      helperItem = 0;
    };
    if (now) doHide();
    else helperHideT = setTimeout(doHide, 15000);
  }
  // Types the price into the box the way a person would, so Torn's page notices the change. Nothing is submitted.
  function fillPrice(v) {
    const inp = helperInput;
    if (!inp || !inp.isConnected) return toast("Tap the price box again", "bad");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(inp, String(v));
    for (const type of ["input", "change", "keyup"]) inp.dispatchEvent(new Event(type, { bubbles: true }));
    inp.focus();
    helperFilled = v;
    if (helperState) renderHelper(helperState);
    toast(`Price set to ${money(v)}. Check it, then confirm yourself.`, "ok", 2600);
  }

  // ---------------------------------------------------------------- page awareness
  // Item Market URLs look like page.php?sid=ItemMarket#/market/view=search&itemID=206&itemName=Xanax
  function currentMarketItem() {
    if (!/sid=ItemMarket/i.test(location.search)) return 0;
    const m = location.hash.match(/itemID=(\d+)/i);
    return m ? +m[1] : 0;
  }
  let routeSeq = 0;
  async function onRoute() {
    const id = currentMarketItem();
    view.contextId = id;
    const seq = ++routeSeq;
    if (!id || !S.marketBadge) return updateBadge();
    try {
      const d = await loadListings(id);
      if (seq !== routeSeq) return;
      const ls = filtered(d.listings || []);
      const low = ls.length ? Math.min(...ls.map((l) => l.price)) : 0;
      setBadge(low ? short(low) : "none", "price");
    } catch {
      if (seq === routeSeq) updateBadge();
    }
    if (isOpen() && view.name === "home") renderHome();
  }

  function setBadge(text, kind) {
    const b = $(".fab-badge");
    b.hidden = !text;
    b.textContent = text || "";
    b.className = "fab-badge " + (kind || "");
  }
  function updateBadge() {
    if (view.contextId && S.marketBadge) return; // the price badge wins on the Item Market
    const hits = Object.entries(S.watch).filter(([id, w]) => {
      const it = itemById(+id);
      return w.target && it && it.lowest_price && it.lowest_price <= w.target;
    }).length;
    const under = S.undercut && apiKey() && view.mine && view.mine.items ? view.mine.items.filter((m) => m.under).length : 0;
    setBadge(hits || under ? [hits ? "★" + hits : "", under ? "↓" + under : ""].filter(Boolean).join(" ") : "", "warn");
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    document.body.appendChild(host);
    setupDrag();
    highlightOnBazaar();
    loadItems()
      .catch(() => {})
      .then(() => {
        updateBadge();
        onRoute();
        monitor(false);
      });
    setInterval(() => monitor(false), MONITOR_INTERVAL);
    window.addEventListener("hashchange", onRoute);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener(
      "focusout",
      (e) => {
        if (e.target === helperInput) hideHelper(false);
      },
      true
    );
    // Torn's SPA pages sometimes change the URL with pushState instead of a hash change.
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        hideHelper(true);
        onRoute();
      }
    }, 1000);
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);

  // ---------------------------------------------------------------- styles
  function CSS() {
    return `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
button { font: inherit; cursor: pointer; }
[hidden] { display: none !important; }
:host {
  --bg: #1d1f22; --bg2: #26292d; --bg3: #30343a; --line: #3a3f46; --text: #e9ecef; --muted: #9aa3ad;
  --acc: #74c0fc; --g: #7fdc6f; --r: #ff8787; --amber: #ffd43b;
}
.fab { position: fixed; right: 14px; bottom: 84px; z-index: 2147483000; width: 52px; height: 52px; border-radius: 50%;
  border: 1px solid var(--line); background: var(--bg2); color: var(--text); box-shadow: 0 4px 14px rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center; font-size: 24px; -webkit-tap-highlight-color: transparent;
  touch-action: none; user-select: none; -webkit-user-select: none; }
.fab:active { transform: scale(.95); }
.fab-badge { position: absolute; top: -6px; right: -6px; min-width: 22px; padding: 2px 6px; border-radius: 11px;
  font-size: 11px; font-weight: 700; background: var(--acc); color: #0b1a26; white-space: nowrap; }
.fab-badge.price { background: var(--g); color: #0b260f; right: auto; left: 50%; transform: translateX(-50%); top: auto; bottom: -10px; }
.fab-badge.warn { background: var(--amber); color: #2b2200; }
.scrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,.45); }
.panel { position: fixed; z-index: 2147483002; left: 0; right: 0; bottom: 0; height: 88vh; height: 88dvh;
  background: var(--bg); color: var(--text); border-radius: 16px 16px 0 0; border: 1px solid var(--line);
  display: flex; flex-direction: column; box-shadow: 0 -8px 30px rgba(0,0,0,.5); font-size: 14px; line-height: 1.35; }
@media (min-width: 760px) { .panel { left: auto; top: 0; height: 100vh; width: 440px; border-radius: 0; } }
.top { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px; border-bottom: 1px solid var(--line); }
.title { flex: 1; font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ib { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; min-width: 36px; height: 36px; font-size: 17px; padding: 0 8px; }
.ib.sm { min-width: 30px; height: 30px; font-size: 14px; padding: 0 6px; }
.ib.on { border-color: var(--acc); color: var(--acc); }
.ib.star.on { color: var(--amber); border-color: var(--line); }
.ib.spinning { animation: sp .8s linear infinite; opacity: .7; }
.ib:disabled { cursor: default; }
.body { flex: 1; overflow-y: auto; padding: 12px; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 16px 2px 8px; }
.muted { color: var(--muted); } .small { font-size: 12px; } .g { color: var(--g); } .r { color: var(--r); } .a { color: var(--amber); } .err { color: var(--r); }
.hint { padding: 8px 4px; } .foot { font-size: 11px; margin-top: 18px; text-align: center; }
.foot a { color: var(--acc); }
input, select { font: inherit; font-size: 16px; color: var(--text); background: var(--bg2); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; width: 100%; outline: none; }
input:focus, select:focus { border-color: var(--acc); }
.search { position: sticky; top: -12px; margin: -12px -12px 8px; padding: 12px; background: var(--bg); z-index: 2; }
.list { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: var(--bg2); border: 1px solid var(--line);
  color: var(--text); border-radius: 12px; padding: 8px 10px; }
.row img { width: 42px; height: 30px; object-fit: contain; flex: none; }
.row .nm { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.row small, .stat small { display: block; font-weight: 400; font-size: 11px; color: var(--muted); }
.row .rt { text-align: right; flex: none; }
.row .rt b:not(.r):not(.g) { color: var(--text); }
.wrow.hit { border-color: var(--amber); }
.row.under { border-color: var(--r); }
.ctx { display: block; width: 100%; margin: 4px 0 4px; padding: 10px; border-radius: 12px; border: 1px dashed var(--acc); background: transparent; color: var(--acc); text-align: left; }
.tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 12px; padding: 10px; }
.tile span { font-size: 20px; } .tile small { color: var(--muted); font-size: 11px; }
.tile.warn { border-color: var(--r); } .tile.warn small { color: var(--r); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { background: var(--bg2); border: 1px solid var(--line); color: var(--text); border-radius: 999px; padding: 6px 12px; font-size: 13px; }
.ihead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.ihead img { width: 60px; height: 44px; object-fit: contain; flex: none; }
.grow { flex: 1; min-width: 0; }
.iname { font-weight: 700; font-size: 17px; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.stat { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; min-width: 0; }
.stat > span:not(.pill) { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.stat b { font-size: 17px; margin-right: 4px; }
.mini { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; font-size: 10px; padding: 0 5px; margin-left: 2px; vertical-align: middle; }
.pill { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 999px; vertical-align: middle; }
.pill.good { background: rgba(127,220,111,.15); color: var(--g); } .pill.bad { background: rgba(255,135,135,.15); color: var(--r); }
.pill.even { background: var(--bg3); color: var(--muted); } .pill.deal { background: rgba(116,192,252,.15); color: var(--acc); }
.flip { margin-top: 10px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg2); font-size: 13px; display: grid; gap: 2px; }
.flip.pos { border-color: rgba(127,220,111,.5); }
.flip.neg { border-color: rgba(255,135,135,.45); }
.flip.even { border-color: rgba(255,212,59,.5); }
.flip-h { font-weight: 700; margin-bottom: 4px; }
.flip-rows { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; margin: 0; }
.flip-rows dt { color: var(--muted); } .flip-rows dt small { font-size: 11px; }
.flip-rows dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.flip-rows dt:nth-last-of-type(1), .flip-rows dd:nth-last-of-type(1) { border-top: 1px solid var(--line); padding-top: 3px; }
.flip-v { margin-top: 6px; line-height: 1.4; }
.calc-flip { margin-top: 4px; }
.tog.col { flex-direction: column; align-items: stretch; gap: 3px; }
.tog.col > span { display: flex; align-items: center; gap: 10px; }
.tog .feerow input.num { margin-left: auto; }
.hl-recv { margin-top: 8px; font-size: 13px; color: var(--amber); }
.hist { margin-top: 10px; padding: 8px 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg2); }
.hist-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.seg.mini2 { flex: none; padding: 2px 6px; font-size: 11px; border: 1px solid var(--line); }
.spark { width: 100%; height: 64px; display: block; }
.target { margin-top: 10px; display: flex; align-items: center; gap: 8px; color: var(--amber); font-size: 13px; }
.target input { width: 120px; }
.calc { margin-top: 10px; display: flex; align-items: center; gap: 10px; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; }
.calc label { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.calc input { width: 84px; }
.calc-out { flex: 1; font-size: 13px; }
.disclose { margin-top: 10px; width: 100%; text-align: left; background: none; border: 0; color: var(--acc); padding: 4px 2px; font-weight: 600; }
.infobox { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; }
.infobox p { margin: 0 0 6px; }
.infobox dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; }
.infobox dt { color: var(--muted); } .infobox dd { margin: 0; }
.filters { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 8px; margin-top: 10px; }
.filters.two { grid-template-columns: 1fr 1fr; align-items: end; }
.filters label { font-size: 11px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
.filters input, .filters select { padding: 7px 8px; }
.sorts { display: flex; gap: 4px; margin-top: 10px; background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 3px; }
.sorts.slim { margin-top: 0; }
.seg { flex: 1; background: transparent; border: 0; color: var(--muted); border-radius: 9px; padding: 7px 4px; font-size: 13px; }
.seg.on { background: var(--bg3); color: var(--text); font-weight: 700; }
.count { margin: 10px 2px 6px; }
.cards { display: flex; flex-direction: column; gap: 6px; }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: 12px; padding: 9px 10px; }
.card.pick { border-color: var(--g); background: rgba(127,220,111,.06); }
.card.closed { opacity: .6; }
.crow { display: flex; align-items: center; gap: 8px; }
.c1 { flex: 1; min-width: 0; }
.price { font-weight: 800; font-size: 16px; }
.seller { margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seller a { color: var(--acc); text-decoration: none; }
.meta { margin-top: 2px; }
.c2 { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: none; }
.c2b { display: flex; gap: 4px; }
.sbox { margin-top: 8px; padding-top: 7px; border-top: 1px dashed var(--line); display: grid; gap: 2px; }
.btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: 10px; border: 0;
  background: var(--acc); color: #0b1a26; font-weight: 700; text-decoration: none; font-size: 14px; }
.btn.sm { height: 30px; padding: 0 10px; font-size: 13px; }
.btn.ghost { background: var(--bg2); color: var(--text); border: 1px solid var(--line); margin: 0 6px 6px 0; }
.link { background: none; border: 0; color: var(--acc); padding: 0; text-decoration: underline; }
.form .blk { display: flex; flex-direction: column; gap: 6px; font-weight: 600; }
.tog { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.tog input[type=checkbox] { width: 20px; height: 20px; flex: none; }
.tog input.num { width: 90px; margin-left: auto; }
.spin { width: 28px; height: 28px; margin: 30px auto; border-radius: 50%; border: 3px solid var(--line); border-top-color: var(--acc); animation: sp .8s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483005; background: var(--bg3); color: var(--text);
  padding: 8px 14px; border-radius: 10px; border: 1px solid var(--line); font-size: 13px; max-width: calc(100vw - 32px); }
.toast.busy { color: var(--acc); border-color: var(--acc); }
.toast.ok { color: var(--g); border-color: var(--g); }
.toast.bad { color: var(--r); border-color: var(--r); }
.alert, .helper { position: fixed; left: 8px; right: 8px; top: 8px; z-index: 2147483004; background: var(--bg); color: var(--text);
  border: 1px solid var(--amber); border-radius: 14px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-size: 14px; }
@media (min-width: 760px) { .alert, .helper { left: auto; width: 420px; } }
.alert { display: flex; align-items: center; gap: 10px; }
.al-txt { flex: 1; min-width: 0; } .al-txt small { display: block; color: var(--muted); font-size: 11px; }
.al-btns { display: flex; gap: 6px; flex: none; }
.helper { border-color: var(--acc); }
.helper.bottom { top: auto; bottom: 8px; }
.hl-top { display: flex; align-items: center; gap: 8px; }
.hl-top span { flex: 1; min-width: 0; }
.hl-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.hl-btns .btn.ghost { margin: 0; }
`;
  }
})();
