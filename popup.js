// popup.js
import {
  getFeeds,
  getEntries,
  getSettings,
  setSettings,
  removeFeed,
  editFeed,
  markRead,
  toggleStar,
  markAllRead,
} from "./store.js";

const $ = (id) => document.getElementById(id);

const state = {
  view: "home", // home | feed | settings
  feedId: null, // null = all posts
  filter: "all", // all | unread | starred
  search: "",
  limit: 20, // entries rendered in feed view (grows on scroll)
  total: 0, // total entries available in current feed view
  editFeedId: null,
  loadingOlder: false, // fetching older pages from the source
  feedExhausted: false, // no more older pages available for this feed
};

const PAGE = 20;

const FILTERS = ["all", "unread", "starred"];
const FILTER_LABELS = { all: "All", unread: "Unread", starred: "Starred" };

// ---------- helpers ----------

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"}`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo`;
  return `${Math.floor(mo / 12)}y`;
}

const AVATAR_COLORS = ["#7c5cff", "#e0578f", "#2f9e6f", "#e0913a", "#3a86c8", "#9b59b6"];
function avatarFor(title) {
  const letter = (title || "?").trim().charAt(0).toUpperCase() || "?";
  let h = 0;
  for (const c of title || "") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { letter, color: AVATAR_COLORS[h % AVATAR_COLORS.length] };
}

// Avatar element: uses the feed's own icon when available, falls back to a
// colored monogram (also on image load failure). `cls` sizes it via CSS.
function avatarNode(feed, cls) {
  const wrap = el("span", "avatar" + (cls ? " " + cls : ""));
  const setLetter = () => {
    const av = avatarFor(feed ? feed.title : "?");
    wrap.textContent = av.letter;
    wrap.style.background = av.color;
  };
  if (feed && feed.iconUrl) {
    const img = document.createElement("img");
    img.className = "avatar-img";
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      wrap.innerHTML = "";
      setLetter();
    });
    img.src = feed.iconUrl;
    wrap.style.background = "transparent";
    wrap.appendChild(img);
  } else {
    setLetter();
  }
  return wrap;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// Resolve any leftover HTML entities (e.g. &rsquo;) via the DOM. Safe: the value
// is read back as text and assigned with textContent, never parsed as markup.
const _decoder = document.createElement("textarea");
function decodeHtml(s) {
  if (!s) return s;
  _decoder.innerHTML = s;
  return _decoder.value;
}

function icon(paths) {
  const svg = `<svg viewBox="0 0 24 24">${paths}</svg>`;
  const span = document.createElement("span");
  span.innerHTML = svg; // static markup only, never feed content
  return span.firstChild;
}

const ICONS = {
  open: '<path d="M14 5h5v5M19 5l-7 7M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  star: '<path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9 6.8 19l1-5.8L3.6 9.1l5.8-.8L12 3Z" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  starFill: '<path d="m12 3 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9 6.8 19l1-5.8L3.6 9.1l5.8-.8L12 3Z" fill="currentColor" stroke="currentColor" stroke-width="1.6"/>',
  check: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m8 12 2.5 2.5L16 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

// ---------- data selectors ----------

async function loadAll() {
  const [feeds, entries, settings] = await Promise.all([
    getFeeds(),
    getEntries(),
    getSettings(),
  ]);
  return { feeds, entries, settings };
}

function unreadByFeed(entries) {
  const map = {};
  for (const e of entries) if (!e.read) map[e.feedId] = (map[e.feedId] || 0) + 1;
  return map;
}

function visibleEntries(entries, feeds) {
  const feedName = Object.fromEntries(feeds.map((f) => [f.id, f.title]));
  let list = entries.filter((e) => feeds.some((f) => f.id === e.feedId));
  if (state.feedId) list = list.filter((e) => e.feedId === state.feedId);
  if (state.filter === "unread") list = list.filter((e) => !e.read);
  if (state.filter === "starred") list = list.filter((e) => e.starred);
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    list = list.filter(
      (e) =>
        (e.title || "").toLowerCase().includes(q) ||
        (e.summary || "").toLowerCase().includes(q)
    );
  }
  list.sort(
    (a, b) => (b.publishedAt || b.fetchedAt) - (a.publishedAt || a.fetchedAt)
  );
  return { list, feedName };
}

// ---------- rendering ----------

async function render() {
  const data = await loadAll();
  $("view-home").classList.toggle("hidden", state.view !== "home");
  $("view-feed").classList.toggle("hidden", state.view !== "feed");
  $("view-settings").classList.toggle("hidden", state.view !== "settings");
  $("view-edit").classList.toggle("hidden", state.view !== "edit");

  if (state.view === "home") renderHome(data);
  else if (state.view === "feed") renderFeed(data);
  else if (state.view === "settings") renderSettings(data);
  else if (state.view === "edit") renderEdit(data);
}

function renderHome({ feeds, entries }) {
  const counts = unreadByFeed(entries);
  const total = entries.filter((e) => !e.read).length;
  $("total-count").textContent = total;

  const container = $("home-list");
  container.innerHTML = "";

  if (feeds.length === 0) {
    const empty = el("div", "empty");
    empty.appendChild(icon('<circle cx="6" cy="18" r="1.6" fill="currentColor"/><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'));
    empty.appendChild(el("div", null, "No feeds yet."));
    const hint = el("div", null, "Add one with the + button.");
    hint.style.marginTop = "6px";
    hint.style.fontSize = "12px";
    empty.appendChild(hint);
    container.appendChild(empty);
    return;
  }

  // All posts row
  const all = el("div", "feed-row all-posts");
  const allIcon = icon('<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>');
  allIcon.classList.add("list-icon");
  all.appendChild(allIcon);
  all.appendChild(el("span", "name", "All posts"));
  if (total > 0) all.appendChild(el("span", "count", String(total)));
  all.addEventListener("click", () => openFeed(null));
  container.appendChild(all);

  // Per-feed rows
  for (const f of feeds) {
    const row = el("div", "feed-row");
    row.appendChild(avatarNode(f, "feed-row-avatar"));
    row.appendChild(el("span", "name", f.title));
    const c = counts[f.id] || 0;
    if (c > 0) row.appendChild(el("span", "count", String(c)));

    const dots = el("button", "dots");
    dots.title = "Feed options";
    dots.appendChild(
      icon('<circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/>')
    );
    dots.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const r = dots.getBoundingClientRect();
      openFeedMenu(f, r.right, r.bottom);
    });
    row.appendChild(dots);

    row.addEventListener("click", () => openFeed(f.id));
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      openFeedMenu(f, ev.clientX, ev.clientY);
    });
    container.appendChild(row);
  }
}

function renderFeed({ feeds, entries }) {
  const feed = state.feedId ? feeds.find((f) => f.id === state.feedId) : null;

  // header avatar
  if (feed) {
    const fresh = avatarNode(feed);
    fresh.id = "feed-avatar";
    fresh.style.display = "grid";
    $("feed-avatar").replaceWith(fresh);
    $("feed-name").textContent = feed.title;
  } else {
    const cur = $("feed-avatar");
    cur.replaceChildren();
    cur.style.display = "none";
    $("feed-name").textContent = "All posts";
  }
  $("filter-label").textContent = FILTER_LABELS[state.filter];

  const { list } = visibleEntries(entries, feeds);
  state.total = list.length;
  // Source-paging only applies to a single feed. "All posts" pages stored only.
  state.feedExhausted = feed ? !!feed.exhausted : true;
  const unread = list.filter((e) => !e.read).length;
  $("feed-count").textContent = unread > 0 ? String(unread) : "";

  const feedById = Object.fromEntries(feeds.map((f) => [f.id, f]));
  const scroller = $("feed-list");
  const prevScroll = scroller.scrollTop;
  scroller.innerHTML = "";

  if (list.length === 0) {
    const empty = el("div", "empty");
    empty.appendChild(
      el("div", null, state.search ? "No matching posts." : "Nothing here.")
    );
    scroller.appendChild(empty);
    return;
  }

  for (const e of list.slice(0, state.limit)) {
    scroller.appendChild(renderEntry(e, feedById[e.feedId]));
  }

  if (state.limit < list.length) {
    const more = el("button", "load-more", "Load more");
    more.addEventListener("click", () => {
      state.limit += PAGE;
      render();
    });
    scroller.appendChild(more);
  } else if (feed && !state.feedExhausted) {
    const older = el(
      "button",
      "load-more",
      state.loadingOlder ? "Loading older posts…" : "Load older posts"
    );
    older.disabled = state.loadingOlder;
    older.addEventListener("click", loadOlderFromSource);
    scroller.appendChild(older);
  } else if (feed && state.feedExhausted) {
    scroller.appendChild(el("div", "list-end", "No older posts"));
  }

  scroller.scrollTop = prevScroll;
}

// Ask the background to pull the next older pages for the current feed, then
// reveal them. Older items arrive marked read, so the badge stays put.
async function loadOlderFromSource() {
  if (!state.feedId || state.loadingOlder || state.feedExhausted) return;
  state.loadingOlder = true;
  render(); // swap the button to "Loading older posts…"
  try {
    const res = await chrome.runtime.sendMessage({
      type: "loadOlder",
      feedId: state.feedId,
    });
    if (res?.added > 0) state.limit += res.added; // show the new older items
    if (res?.exhausted) state.feedExhausted = true;
  } catch {
    /* leave the button; the user can retry */
  } finally {
    state.loadingOlder = false;
    render();
  }
}

function renderEntry(e, feed) {
  const row = el("div", "entry" + (e.read ? " read" : ""));
  row.tabIndex = 0;

  const title = el("div", "entry-title", decodeHtml(e.title));
  row.appendChild(title);

  // Surface the target URL so it is visible on hover and inspectable in the
  // DOM. Also makes a missing link obvious instead of a dead click.
  row.dataset.link = e.link || "";
  row.title = e.link || "No link in this feed item";
  if (!e.link) row.classList.add("no-link");

  if (e.summary) row.appendChild(el("div", "entry-summary", decodeHtml(e.summary)));

  const meta = el("div", "entry-meta");
  const src = el("span", "src");
  src.appendChild(avatarNode(feed, "meta-avatar"));
  if (feed) src.appendChild(el("span", "src-name", feed.title));
  meta.appendChild(src);
  if (feed && (e.publishedAt || e.fetchedAt)) meta.appendChild(el("span", "sep", "·"));
  if (e.publishedAt || e.fetchedAt) {
    meta.appendChild(el("span", null, timeAgo(e.publishedAt || e.fetchedAt)));
  }
  row.appendChild(meta);

  if (!e.read) row.appendChild(el("span", "dot"));

  // hover actions
  const actions = el("div", "entry-actions");
  const openBtn = actionBtn(ICONS.open, "Open", (ev) => {
    ev.stopPropagation();
    openEntry(e);
  });
  const starBtn = actionBtn(
    e.starred ? ICONS.starFill : ICONS.star,
    e.starred ? "Unstar" : "Star",
    async (ev) => {
      ev.stopPropagation();
      await toggleStar(e.id);
    }
  );
  if (e.starred) starBtn.classList.add("starred");
  const readBtn = actionBtn(
    ICONS.check,
    e.read ? "Mark as unread" : "Mark as read",
    async (ev) => {
      ev.stopPropagation();
      await markRead(e.id, !e.read);
    }
  );
  actions.append(openBtn, starBtn, readBtn);
  row.appendChild(actions);

  // click body: open + mark read
  row.addEventListener("click", () => openEntry(e));
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") openEntry(e);
  });
  return row;
}

function actionBtn(pathMarkup, title, onClick) {
  const btn = el("button", "act");
  btn.title = title;
  btn.appendChild(icon(pathMarkup));
  btn.addEventListener("click", onClick);
  return btn;
}

async function openEntry(e) {
  if (!e.read) await markRead(e.id, true);
  const url = (e.link || "").trim();
  if (/^https?:\/\//i.test(url)) {
    chrome.tabs.create({ url });
  } else {
    // Nothing openable: say so rather than swallowing the click.
    console.warn("FeedWatch: entry has no usable link", { id: e.id, link: e.link });
  }
}

function renderSettings({ feeds, settings }) {
  $("set-notifications").checked = !!settings.notifications;
  $("set-interval").value = String(settings.intervalMinutes || 30);

  const list = $("feed-manage-list");
  list.innerHTML = "";
  if (feeds.length === 0) {
    list.appendChild(el("div", "empty", "No feeds added."));
  }
  for (const f of feeds) {
    const row = el("div", "manage-row");
    row.appendChild(avatarNode(f, "feed-row-avatar"));
    row.appendChild(el("span", "name", f.title));
    const rm = el("button", "rm");
    rm.title = "Remove feed";
    rm.appendChild(
      icon('<path d="M6 7h12M9 7V5h6v2m-8 0 1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>')
    );
    rm.addEventListener("click", async () => {
      if (confirm(`Remove "${f.title}"?`)) await removeFeed(f.id);
    });
    row.appendChild(rm);
    list.appendChild(row);
  }
}

// ---------- navigation ----------

function openFeed(feedId) {
  state.view = "feed";
  state.feedId = feedId;
  state.search = "";
  state.limit = PAGE;
  state.loadingOlder = false;
  state.feedExhausted = false;
  $("feed-search").value = "";
  render();
}

function goHome() {
  state.view = "home";
  state.feedId = null;
  state.filter = "all";
  render();
}

function openSettings() {
  state.view = "settings";
  $("add-error").textContent = "";
  render();
}

// ---------- per-feed context menu ----------

let openMenuEl = null;
function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
    document.removeEventListener("click", closeMenu);
    document.removeEventListener("keydown", onMenuKey);
  }
}
function onMenuKey(e) {
  if (e.key === "Escape") closeMenu();
}

function openFeedMenu(feed, x, y) {
  closeMenu();
  const menu = el("div", "context-menu");
  const add = (label, fn, cls) => {
    const b = el("button", cls || null, label);
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      closeMenu();
      await fn();
    });
    menu.appendChild(b);
  };

  add("Mark feed as read", () => markAllRead(feed.id));
  add("Open all unread", () => openAllUnread(feed.id));
  add("Reload feed", () =>
    chrome.runtime.sendMessage({ type: "reloadFeed", feedId: feed.id })
  );
  menu.appendChild(el("div", "divider"));
  add("Edit feed", () => openEdit(feed.id));
  add("Delete feed", async () => {
    if (confirm(`Delete "${feed.title}"?`)) await removeFeed(feed.id);
  }, "danger");

  document.body.appendChild(menu);
  // keep within the popup viewport
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 220;
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - mw - 6)) + "px";
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - mh - 6)) + "px";

  openMenuEl = menu;
  setTimeout(() => {
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", onMenuKey);
  }, 0);
}

async function openAllUnread(feedId) {
  const entries = (await getEntries())
    .filter((e) => e.feedId === feedId && !e.read && e.link)
    .sort((a, b) => (b.publishedAt || b.fetchedAt) - (a.publishedAt || a.fetchedAt));
  if (entries.length === 0) return;
  if (entries.length > 10 && !confirm(`Open ${entries.length} tabs?`)) return;
  for (const e of entries) {
    chrome.tabs.create({ url: e.link, active: false });
    await markRead(e.id, true);
  }
}

// ---------- edit feed ----------

function openEdit(feedId) {
  state.editFeedId = feedId;
  state.view = "edit";
  $("edit-error").textContent = "";
  render();
}

function renderEdit({ feeds }) {
  const feed = feeds.find((f) => f.id === state.editFeedId);
  if (!feed) {
    goHome();
    return;
  }
  $("edit-title").value = feed.title || "";
  $("edit-url").value = feed.url || "";
}

async function saveEdit() {
  const feed = (await getFeeds()).find((f) => f.id === state.editFeedId);
  if (!feed) return goHome();
  const title = $("edit-title").value.trim();
  const url = $("edit-url").value.trim();
  const errEl = $("edit-error");
  if (!url) {
    errEl.textContent = "A feed URL is required.";
    return;
  }
  try {
    const urlChanged = url !== feed.url;
    await editFeed(state.editFeedId, { title, url });
    if (urlChanged) {
      chrome.runtime.sendMessage({ type: "reloadFeed", feedId: state.editFeedId });
    }
    goHome();
  } catch (err) {
    errEl.textContent = String(err.message || err);
  }
}

// ---------- add feed ----------

async function addFeedFlow() {
  const input = $("add-feed-input");
  const url = input.value.trim();
  const errEl = $("add-error");
  const btn = $("btn-add-confirm");
  if (!url) return;
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Adding...";
  try {
    const res = await chrome.runtime.sendMessage({ type: "addFeed", url });
    if (!res?.ok) throw new Error(res?.error || "Could not add feed.");
    input.value = "";
    await render();
  } catch (err) {
    errEl.textContent = String(err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add";
  }
}

// ---------- wire up ----------

function init() {
  // home header
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-add").addEventListener("click", () => {
    openSettings();
    setTimeout(() => $("add-feed-input").focus(), 50);
  });
  $("btn-mark-all").addEventListener("click", () => markAllRead(null));
  $("seg-all").addEventListener("click", () => {
    state.filter = "all";
    openFeed(null);
  });
  $("seg-star").addEventListener("click", () => {
    state.filter = "starred";
    openFeed(null);
  });

  // feed view
  $("btn-back").addEventListener("click", goHome);
  $("btn-filter").addEventListener("click", () => {
    const i = FILTERS.indexOf(state.filter);
    state.filter = FILTERS[(i + 1) % FILTERS.length];
    state.limit = PAGE;
    render();
  });
  $("btn-feed-mark-all").addEventListener("click", () =>
    markAllRead(state.feedId)
  );

  // settings
  $("btn-settings-back").addEventListener("click", goHome);

  // edit feed
  $("btn-edit-back").addEventListener("click", goHome);
  $("btn-edit-cancel").addEventListener("click", goHome);
  $("btn-edit-save").addEventListener("click", saveEdit);
  $("edit-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveEdit();
  });
  $("btn-refresh").addEventListener("click", async () => {
    const b = $("btn-refresh");
    b.textContent = "Checking...";
    await chrome.runtime.sendMessage({ type: "refreshNow" });
    b.textContent = "Check now";
  });
  $("set-notifications").addEventListener("change", (e) =>
    setSettings({ notifications: e.target.checked })
  );
  $("set-interval").addEventListener("change", (e) =>
    setSettings({ intervalMinutes: parseInt(e.target.value, 10) })
  );
  $("btn-add-confirm").addEventListener("click", addFeedFlow);
  $("add-feed-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFeedFlow();
  });

  // search
  $("home-search").addEventListener("input", (e) => {
    const q = e.target.value;
    if (q.trim()) {
      openFeed(null); // switch into all-posts view
      state.search = q;
      state.limit = PAGE;
      $("feed-search").value = q;
      render();
    }
  });
  $("feed-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    state.limit = PAGE;
    render();
  });

  // infinite scroll: reveal more stored items, then pull older from the source
  $("feed-list").addEventListener("scroll", () => {
    if (state.view !== "feed") return;
    const s = $("feed-list");
    const nearBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 160;
    if (!nearBottom) return;
    if (state.limit < state.total) {
      state.limit += PAGE;
      render();
    } else if (state.feedId && !state.loadingOlder && !state.feedExhausted) {
      loadOlderFromSource();
    }
  });

  // live updates from background / other contexts
  chrome.storage.onChanged.addListener((changes, area) => {
    if (state.view === "edit") return; // don't clobber the edit form
    if (area === "local" && (changes.entries || changes.feeds || changes.settings)) {
      render();
    }
  });

  render();
  // fresh check on open (fire and forget)
  chrome.runtime.sendMessage({ type: "refreshNow" }).catch(() => {});
}

init();
