"use strict";
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable */
      }
    },
    clear() {
      try {
        localStorage.removeItem("emn_settings");
        localStorage.removeItem("emn_links");
      } catch {
        /* ignore */
      }
    },
  };

  // ---------- data ----------
  const ENGINES = {
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=" },
    mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q=" },
    bing: { name: "Bing (unreliable)", url: "https://www.bing.com/search?q=" },
    google: { name: "Google (often blocked)", url: "https://www.google.com/search?q=" },
    brave: { name: "Brave (often blocked)", url: "https://search.brave.com/search?q=" },
  };


  const DEFAULT_LINKS = [
    { title: "YouTube", url: "https://www.youtube.com" },
    { title: "TikTok", url: "https://www.tiktok.com" },
    { title: "Google", url: "https://www.google.com" },
    { title: "Wikipedia", url: "https://www.wikipedia.org" },
    { title: "Reddit", url: "https://www.reddit.com" },
  ];

  const settings = Object.assign({ engine: "duckduckgo" }, store.get("emn_settings", {}));
  if (!ENGINES[settings.engine]) settings.engine = "duckduckgo";

  let links = store.get("emn_links", null);
  if (!Array.isArray(links)) links = DEFAULT_LINKS.map((l) => ({ ...l }));

  const DEFAULT_ICON =
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0b0b"/>' +
        '<text x="32" y="45" font-size="40" font-family="Arial,sans-serif" font-weight="800" text-anchor="middle" fill="#14b8a6">E</text></svg>'
    );
  const MAX_TABS = 20;
  const tabs = [];
  let cur = null;
  let seq = 0;

  // ---------- helpers ----------
  const hostOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  const engineUrl = (q) => ENGINES[settings.engine].url + encodeURIComponent(q);

  function resolve(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[\w.-]+:\d+/.test(v)) return engineUrl(v);
    if (!/\s/.test(v) && v.includes(".")) return "https://" + v;
    return engineUrl(v);
  }

  const curTab = () => tabs.find((t) => t.id === cur) || null;

  // ---------- engine boot (service worker + transport) ----------
  let bootPromise = null;

  function setStatus(kind, text) {
    const s = $("status");
    s.className = kind;
    s.textContent = text;
    $("set-status").textContent = text;
  }

  function showBanner(title, text) {
    $("banner-title").textContent = title;
    $("banner-text").textContent = text;
    $("banner").hidden = false;
  }

  function waitForActive(worker, ms) {
    return new Promise((resolveWait) => {
      if (!worker || worker.state === "activated") return resolveWait();
      const done = () => {
        if (worker.state === "activated") {
          worker.removeEventListener("statechange", done);
          resolveWait();
        }
      };
      worker.addEventListener("statechange", done);
      setTimeout(resolveWait, ms);
    });
  }

  let scramjet = null;
  const PREFIX = "/scramjet/";
  const PROXIED_BASE = location.origin + PREFIX;

  function withTimeout(promise, ms, message) {
    return new Promise((resolveT, rejectT) => {
      const timer = setTimeout(() => rejectT(new Error(message)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolveT(v);
        },
        (e) => {
          clearTimeout(timer);
          rejectT(e);
        }
      );
    });
  }

  async function bootEngine() {
    if (typeof BareMux === "undefined") {
      throw new Error("The BareMux script didn't load from /baremux/index.js.");
    }
    if (typeof $scramjetLoadController !== "function") {
      throw new Error("Scramjet didn't load from /scram/scramjet.all.js. Check the server log.");
    }
    if (!("serviceWorker" in navigator)) {
      throw new Error("This browser blocks service workers. Use https and a normal (non-private) window.");
    }

    // Remove the old Ultraviolet worker left behind by earlier versions of Emnity.
    try {
      for (const r of await navigator.serviceWorker.getRegistrations()) {
        if (r.scope.indexOf("/uv/") !== -1) await r.unregister();
      }
    } catch {
      /* ignore */
    }

    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await waitForActive(reg.installing || reg.waiting || reg.active, 8000);

    const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
    const wispUrl = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";
    await withTimeout(
      connection.setTransport("/libcurl/index.mjs", [{ wisp: wispUrl }]),
      15000,
      "The connection worker didn't respond. Clear this site's data (padlock, then Site settings, then Delete data) and reload."
    );

    const { ScramjetController } = $scramjetLoadController();
    scramjet = new ScramjetController({
      prefix: PREFIX,
      files: {
        wasm: "/scram/scramjet.wasm.wasm",
        all: "/scram/scramjet.all.js",
        sync: "/scram/scramjet.sync.js",
      },
    });
    await withTimeout(
      Promise.resolve(scramjet.init()),
      15000,
      "Scramjet didn't finish starting. Clear this site's data and reload."
    );
  }

  function boot() {
    if (bootPromise) return bootPromise;
    setStatus("wait", "starting");
    $("banner").hidden = true;
    bootPromise = bootEngine().then(
      () => {
        setStatus("ok", "ready");
      },
      (err) => {
        bootPromise = null;
        setStatus("bad", "error");
        showBanner("Engine failed to start.", err && err.message ? err.message : String(err));
        throw err;
      }
    );
    return bootPromise;
  }

  // ---------- tabs ----------
  function prepareFrame(tab, frame) {
    frame.setAttribute("allow", "autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture; web-share");
    frame.setAttribute("allowfullscreen", "");
    frame.title = "Page";
    frame.addEventListener("load", () => {
      sync(tab);
      tab.loading = false;
      render();
    });
  }

  function newTab(raw) {
    if (tabs.length >= MAX_TABS) return curTab();
    const frame = document.createElement("iframe");
    const tab = { id: ++seq, url: "", title: "New tab", icon: "", badIcon: "", loading: false, frame, sj: null };
    prepareFrame(tab, frame);
    $("views").appendChild(frame);
    tabs.push(tab);
    cur = tab.id;
    render();
    if (raw) go(tab, raw);
    return tab;
  }

  // Give a tab its Scramjet frame once the engine is ready.
  function attachScramjet(tab) {
    if (tab.sj) return;
    const sj = scramjet.createFrame(tab.frame);
    const el = sj && sj.frame;
    if (el && el !== tab.frame) {
      // The library made its own iframe; use that one instead.
      tab.frame.replaceWith(el);
      tab.frame = el;
      prepareFrame(tab, el);
    }
    tab.sj = sj;
  }

  async function go(tab, raw) {
    if (!tab) tab = newTab();
    const url = resolve(raw);
    if (!url) return;
    try {
      await boot();
      attachScramjet(tab);
    } catch (err) {
      showBanner("Couldn't open that page.", err && err.message ? err.message : String(err));
      return;
    }
    tab.url = url;
    tab.title = hostOf(url);
    tab.loading = true;
    cur = tab.id;
    if (tab.sj && typeof tab.sj.go === "function") tab.sj.go(url);
    else tab.frame.src = PREFIX + encodeURIComponent(url);
    render();
  }

  // Turn a proxied address back into the real one (or return "" if it isn't one).
  function normalize(s) {
    s = String(s || "");
    if (s.indexOf(PROXIED_BASE) === 0) {
      try {
        s = decodeURIComponent(s.slice(PROXIED_BASE.length));
      } catch {
        return "";
      }
    }
    return /^https?:\/\//i.test(s) ? s : "";
  }

  function realUrl(tab, w) {
    try {
      const u = tab.sj && tab.sj.url;
      const n = u ? normalize(u.href || u) : "";
      if (n) return n;
    } catch {
      /* fall through */
    }
    try {
      return normalize(w.location.href);
    } catch {
      return "";
    }
  }

  // Find the page's icon and return a URL that loads through the proxy.
  function findIcon(w, pageUrl) {
    const prox = (abs) => PROXIED_BASE + encodeURIComponent(abs);
    try {
      const link = w.document && w.document.querySelector('link[rel~="icon"]');
      const raw = link && link.href;
      if (raw) {
        if (raw.startsWith("data:")) return raw;
        if (raw.startsWith(PROXIED_BASE)) return raw;
        if (/^https?:\/\//i.test(raw)) return prox(raw);
      }
      if (pageUrl) return prox(new URL("/favicon.ico", pageUrl).href);
    } catch {
      /* page not ready */
    }
    return "";
  }

  // Read the real address and title back out of the proxied page.
  function sync(tab) {
    let changed = false;
    try {
      const w = tab.frame.contentWindow;
      if (!w || w.location.href === "about:blank") return false;
      const real = realUrl(tab, w);
      if (real && real !== tab.url) {
        tab.url = real;
        changed = true;
      }
      if (!tab.url) return changed;
      const title = (w.document && w.document.title) || hostOf(tab.url);
      if (title !== tab.title) {
        tab.title = title;
        changed = true;
      }
      let icon = findIcon(w, tab.url);
      if (icon && icon === tab.badIcon) icon = "";
      if (icon !== tab.icon) {
        tab.icon = icon;
        changed = true;
      }
    } catch {
      /* cross-origin or not ready */
    }
    return changed;
  }

  function select(id) {
    cur = id;
    render();
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    tabs[i].frame.remove();
    tabs.splice(i, 1);
    if (!tabs.length) {
      newTab();
      return;
    }
    if (cur === id) cur = tabs[Math.max(0, i - 1)].id;
    render();
  }

  function goHome(tab) {
    if (!tab) return;
    tab.url = "";
    tab.title = "New tab";
    tab.icon = "";
    tab.loading = false;
    tab.frame.src = "about:blank";
    render();
  }

  // ---------- rendering ----------
  function render() {
    const strip = $("tabs");
    strip.textContent = "";
    for (const t of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === cur ? " on" : "");
      el.setAttribute("role", "tab");
      let lead;
      if (t.url && t.icon && !t.loading) {
        lead = document.createElement("img");
        lead.className = "fav";
        lead.alt = "";
        lead.src = t.icon;
        lead.addEventListener("error", () => {
          t.badIcon = t.icon;
          t.icon = "";
          render();
        });
      } else {
        lead = document.createElement("i");
        lead.className = "dot" + (t.loading ? " spin" : "");
      }
      const label = document.createElement("span");
      label.textContent = t.url ? t.title : "New tab";
      const x = document.createElement("b");
      x.textContent = "×";
      x.title = "Close tab";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(t.id);
      });
      el.addEventListener("click", () => select(t.id));
      el.addEventListener("auxclick", (e) => {
        if (e.button === 1) closeTab(t.id);
      });
      el.append(lead, label, x);
      strip.append(el);
      t.frame.style.display = t.id === cur && t.url ? "block" : "none";
    }
    const c = curTab();
    $("start").style.display = c && !c.url ? "flex" : "none";
    if (document.activeElement !== $("addr")) $("addr").value = c && c.url ? c.url : "";
    $("load").className = c && c.loading ? "on" : "";
    $("star").classList.toggle("on", !!(c && c.url && links.some((l) => l.url === c.url)));
    $("star").textContent = c && c.url && links.some((l) => l.url === c.url) ? "★" : "☆";
    document.title = c && c.url ? c.title + " - Emnity" : "Emnity";
    // Mirror the current page's icon onto the real browser tab.
    const fav = $("favicon");
    const want = c && c.url && c.icon && !c.loading ? c.icon : DEFAULT_ICON;
    if (fav.getAttribute("href") !== want) fav.setAttribute("href", want);
  }

  function renderLinks() {
    const bar = $("bookmarks");
    bar.textContent = "";
    bar.style.display = links.length ? "flex" : "none";
    for (const l of links) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.title = l.url;
      const letter = document.createElement("span");
      letter.className = "l";
      letter.textContent = (l.title || "?").charAt(0).toUpperCase();
      const name = document.createElement("span");
      name.textContent = l.title;
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "×";
      x.title = "Remove";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        removeLink(l.url);
      });
      chip.addEventListener("click", () => go(curTab(), l.url));
      chip.append(letter, name, x);
      bar.append(chip);
    }

    const tiles = $("tiles");
    tiles.textContent = "";
    for (const l of links) {
      const tile = document.createElement("button");
      tile.className = "tile";
      const ic = document.createElement("div");
      ic.className = "ic";
      ic.textContent = (l.title || "?").charAt(0).toUpperCase();
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = l.title;
      tile.append(ic, t);
      tile.addEventListener("click", () => go(curTab(), l.url));
      tiles.append(tile);
    }
    const add = document.createElement("button");
    add.className = "tile add";
    const aic = document.createElement("div");
    aic.className = "ic";
    aic.textContent = "+";
    const at = document.createElement("span");
    at.className = "t";
    at.textContent = "Add shortcut";
    add.append(aic, at);
    add.addEventListener("click", () => {
      const raw = prompt("Website address (for example example.com)");
      const url = raw ? resolve(raw) : "";
      if (!url || /\s/.test(raw.trim())) return;
      addLink(hostOf(url), url);
    });
    tiles.append(add);
    $("set-count").textContent = String(links.length);
  }

  function saveLinks() {
    store.set("emn_links", links);
    renderLinks();
    render();
  }

  function addLink(title, url) {
    if (links.some((l) => l.url === url)) return;
    links.push({ title, url });
    saveLinks();
  }

  function removeLink(url) {
    links = links.filter((l) => l.url !== url);
    saveLinks();
  }

  // ---------- wiring ----------
  function fillEngines() {
    const sel = $("eng");
    for (const [key, e] of Object.entries(ENGINES)) {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = e.name;
      sel.append(o);
    }
    sel.value = settings.engine;
    sel.addEventListener("change", () => {
      settings.engine = sel.value;
      store.set("emn_settings", settings);
    });
  }

  $("plus").addEventListener("click", () => newTab());

  $("addr").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      go(curTab(), e.target.value);
      e.target.blur();
    }
  });
  $("addr").addEventListener("focus", (e) => e.target.select());

  $("sform").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("sq").value;
    $("sq").value = "";
    go(curTab(), v);
  });

  $("back").addEventListener("click", () => {
    try {
      curTab().frame.contentWindow.history.back();
    } catch {
      /* ignore */
    }
  });
  $("fwd").addEventListener("click", () => {
    try {
      curTab().frame.contentWindow.history.forward();
    } catch {
      /* ignore */
    }
  });
  $("reload").addEventListener("click", () => {
    const t = curTab();
    if (!t || !t.url) return;
    t.loading = true;
    render();
    try {
      t.frame.contentWindow.location.reload();
    } catch {
      go(t, t.url);
    }
  });
  $("home").addEventListener("click", () => goHome(curTab()));

  $("star").addEventListener("click", () => {
    const t = curTab();
    if (!t || !t.url) return;
    if (links.some((l) => l.url === t.url)) removeLink(t.url);
    else addLink(t.title && t.title !== t.url ? t.title.slice(0, 24) : hostOf(t.url), t.url);
  });

  $("retry").addEventListener("click", () => boot().catch(() => {}));

  $("gear").addEventListener("click", () => $("settings").showModal());
  $("reset-links").addEventListener("click", () => {
    links = DEFAULT_LINKS.map((l) => ({ ...l }));
    saveLinks();
  });
  $("reset-all").addEventListener("click", () => {
    if (!confirm("Clear your shortcuts and settings?")) return;
    store.clear();
    location.reload();
  });

  document.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "t") {
      e.preventDefault();
      newTab();
    } else if (k === "w") {
      e.preventDefault();
      if (cur !== null) closeTab(cur);
    } else if (k === "l") {
      e.preventDefault();
      $("addr").focus();
    }
  });

  // Keep tab titles and addresses fresh for pages that change them without reloading.
  setInterval(() => {
    let changed = false;
    for (const t of tabs) if (t.url && sync(t)) changed = true;
    if (changed) render();
  }, 1500);

  // ---------- start ----------
  fillEngines();
  renderLinks();
  newTab();
  boot().catch(() => {});
})();
