// background.js (service worker, type: module)
import {
  parseFeed,
  discoverFeedUrl,
  looksLikeFeed,
  pickIconFromHtml,
} from "./parser.js";
import {
  getFeeds,
  getEntries,
  getSettings,
  addFeed,
  setFeedMeta,
  mergeEntries,
  unreadCount,
} from "./store.js";

const ALARM_NAME = "feedwatch-refresh";
const FETCH_TIMEOUT_MS = 15000;
const SCHEMA = 3; // bump when the stored entry/cursor shape changes
const BACKFILL_PAGES = 5; // pages to pull when a feed is sparse
const BACKFILL_THRESHOLD = 15; // below this many stored items, backfill

// ---- lifecycle -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await migrate();
  await setupAlarm();
  await refreshAll();
});

chrome.runtime.onStartup.addListener(async () => {
  await migrate();
  await setupAlarm();
  await refreshAll();
});

// One-time cleanup when the entry id scheme changes: keep feeds, drop entries
// so they repopulate cleanly on the next fetch.
async function migrate() {
  const { schemaVersion } = await chrome.storage.local.get("schemaVersion");
  if (schemaVersion !== SCHEMA) {
    await chrome.storage.local.set({ entries: [], schemaVersion: SCHEMA });
  }
}

async function setupAlarm() {
  const { intervalMinutes } = await getSettings();
  const period = Math.max(1, intervalMinutes || 30);
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: period,
    delayInMinutes: period,
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshAll();
});

// Keep the badge correct whenever entries change from any context (popup, etc).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.entries) updateBadge();
  if (area === "local" && changes.settings) setupAlarm();
});

// ---- messaging -------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "refreshNow") {
        const result = await refreshAll();
        sendResponse({ ok: true, ...result });
      } else if (msg.type === "addFeed") {
        const feed = await resolveAndAddFeed(msg.url);
        await refreshFeed(feed);
        await updateBadge();
        sendResponse({ ok: true, feed });
      } else if (msg.type === "reloadFeed") {
        const feed = (await getFeeds()).find((f) => f.id === msg.feedId);
        if (feed) {
          await refreshFeed(feed);
          await updateBadge();
        }
        sendResponse({ ok: true });
      } else if (msg.type === "loadOlder") {
        const feed = (await getFeeds()).find((f) => f.id === msg.feedId);
        const result = feed
          ? await loadOlder(feed)
          : { added: 0, exhausted: true };
        sendResponse({ ok: true, ...result });
      } else {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err) });
    }
  })();
  return true; // keep the channel open for the async response
});

// ---- fetching --------------------------------------------------------------

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Takes a URL the user pasted (feed URL or a site URL), returns a saved feed.
async function resolveAndAddFeed(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const text = await fetchText(url);
  let feedUrl = url;
  let feedText = text;

  if (!looksLikeFeed(text)) {
    const discovered = discoverFeedUrl(text, url);
    if (!discovered) {
      throw new Error("No RSS or Atom feed found at that URL.");
    }
    feedUrl = discovered;
    feedText = await fetchText(feedUrl);
    if (!looksLikeFeed(feedText)) {
      throw new Error("Discovered link is not a valid feed.");
    }
  }

  const parsed = parseFeed(feedText, feedUrl);
  return addFeed({
    url: feedUrl,
    title: parsed.title || feedUrl,
    iconUrl: parsed.iconUrl || null,
  });
}

// Query-param paging (WordPress default, e.g. Datadog): ?paged=N
function pagedQuery(url, page) {
  try {
    const u = new URL(url);
    u.searchParams.set("paged", String(page));
    return u.href;
  } catch {
    return url + (url.includes("?") ? "&" : "?") + "paged=" + page;
  }
}

// Path paging (WordPress pretty permalinks, e.g. github.blog):
// .../changelog/feed/ -> .../changelog/page/N/feed/
function pagedPath(url, page) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^(.*\/)feed\/?$/);
    if (m) {
      u.pathname = `${m[1]}page/${page}/feed/`;
    } else {
      u.pathname = u.pathname.replace(/\/?$/, "/") + `page/${page}/`;
    }
    return u.href;
  } catch {
    return url;
  }
}

// Fetch page 1, then keep pulling older pages until a page yields no new items
// or we hit maxPages. Handles feeds that page by rel=next, ?paged=N, or
// /page/N/ paths by trying each until one returns fresh items, then locking to
// that scheme. The fresh-items guard also stops feeds that ignore paging.
async function fetchFeedPages(feedUrl, maxPages) {
  const first = parseFeed(await fetchText(feedUrl), feedUrl);
  const items = [...first.items];
  const seen = new Set(items.map((i) => i.key));
  let next = first.next;
  let scheme = null; // "query" | "path" once discovered
  let deepest = 1; // highest page actually fetched with fresh items

  for (let page = 2; page <= maxPages; page++) {
    let candidates;
    if (next) candidates = [["next", next]];
    else if (scheme === "query") candidates = [["query", pagedQuery(feedUrl, page)]];
    else if (scheme === "path") candidates = [["path", pagedPath(feedUrl, page)]];
    else candidates = [["query", pagedQuery(feedUrl, page)], ["path", pagedPath(feedUrl, page)]];

    let advanced = false;
    for (const [kind, url] of candidates) {
      let parsed;
      try {
        parsed = parseFeed(await fetchText(url), url);
      } catch {
        continue;
      }
      const fresh = parsed.items.filter((i) => !seen.has(i.key));
      if (fresh.length === 0) continue;
      for (const i of fresh) {
        seen.add(i.key);
        items.push(i);
      }
      next = parsed.next;
      if (!scheme && kind !== "next") scheme = kind;
      deepest = page;
      advanced = true;
      break;
    }
    if (!advanced) break;
  }

  return {
    title: first.title,
    iconUrl: first.iconUrl,
    siteLink: first.siteLink,
    items,
    scheme,
    pages: deepest,
  };
}

// When a feed carries no <image>/<icon>, fall back to the site favicon the way
// a browser tab does: read the homepage's <link rel="icon">, else /favicon.ico.
async function discoverSiteIcon(siteOrFeedUrl) {
  let origin;
  try {
    origin = new URL(siteOrFeedUrl).origin;
  } catch {
    return null;
  }
  try {
    const html = await fetchText(origin + "/");
    const found = pickIconFromHtml(html, origin);
    if (found) return found;
  } catch {
    /* fall through to the well-known path */
  }
  return origin + "/favicon.ico";
}

async function refreshFeed(feed) {
  const stored = (await getEntries()).filter((e) => e.feedId === feed.id).length;
  const backfilling = stored < BACKFILL_THRESHOLD;
  const maxPages = backfilling ? BACKFILL_PAGES : 1;

  // First time we ever sync this feed: its existing archive is history, not news.
  // Import it read so adding a feed does not dump hundreds onto the badge. Items
  // that appear on later polls are genuinely new and land unread.
  const firstSync = stored === 0 && !feed.initialized;

  const parsed = await fetchFeedPages(feed.url, maxPages);

  if (parsed.iconUrl) {
    await setFeedMeta(feed.id, { iconUrl: parsed.iconUrl });
  } else if (!feed.iconUrl) {
    // one-time favicon lookup while the feed has no icon yet
    const fav = await discoverSiteIcon(parsed.siteLink || feed.url);
    if (fav) await setFeedMeta(feed.id, { iconUrl: fav });
  }

  // Record how deep the backfill reached so on-demand paging can continue from
  // there. Only on a real multi-page fetch; a page-1 poll must not reset it.
  if (backfilling && parsed.pages > 1) {
    await setFeedMeta(feed.id, {
      pageScheme: parsed.scheme || feed.pageScheme || null,
      deepestPage: Math.max(feed.deepestPage || 1, parsed.pages),
    });
  }

  const items = parsed.items.map((it) => ({
    id: `${feed.id}::${it.key}`,
    title: it.title,
    link: it.link,
    author: it.author,
    publishedAt: it.publishedAt,
    summary: it.summary,
    ...(firstSync ? { read: true } : {}),
  }));

  const newCount = await mergeEntries(feed.id, items);
  if (firstSync) await setFeedMeta(feed.id, { initialized: true });

  // Drift detector: on an established feed, a poll where essentially every
  // fetched item counts as "new" means item identity is not stable between
  // fetches (changing guid/link), not that the source published that much.
  if (!firstSync && stored > 0 && items.length > 3 && newCount >= items.length) {
    console.warn(
      `FeedWatch: ${feed.title} reported ${newCount}/${items.length} items as new. ` +
        `Item ids look unstable between fetches. Sample id: ${items[0]?.id}`
    );
  }

  return { feed, newCount: firstSync ? 0 : newCount, error: null };
}

// ---- on-demand older pages (scroll to bottom) ------------------------------

const OLDER_NEW_PAGES = 3; // reveal ~3 pages of older items per trigger
const OLDER_FETCH_CAP = 10; // hard cap on requests per trigger

// Pull the next older pages for one feed, continuing from its stored cursor.
// Uses ?paged=N or /page/N/ paging (detected once, remembered on the feed).
// Older items land as read so they don't inflate the unread badge.
async function loadOlder(feed) {
  if (feed.exhausted) return { added: 0, exhausted: true };

  const prefix = `${feed.id}::`;
  const seen = new Set(
    (await getEntries())
      .filter((e) => e.feedId === feed.id)
      .map((e) => e.id.slice(prefix.length))
  );

  let scheme = feed.pageScheme || null;
  let page = feed.deepestPage || 1;
  let exhausted = false;
  const collected = [];
  let newPages = 0;
  let fetches = 0;

  while (newPages < OLDER_NEW_PAGES && fetches < OLDER_FETCH_CAP) {
    const targets =
      scheme === "query"
        ? [["query", pagedQuery(feed.url, page + 1)]]
        : scheme === "path"
        ? [["path", pagedPath(feed.url, page + 1)]]
        : [
            ["query", pagedQuery(feed.url, page + 1)],
            ["path", pagedPath(feed.url, page + 1)],
          ];

    let parsed = null;
    let usedKind = null;
    for (const [kind, url] of targets) {
      if (fetches >= OLDER_FETCH_CAP) break;
      fetches++;
      try {
        const p = parseFeed(await fetchText(url), url);
        const hasFresh = p.items.some((it) => !seen.has(it.key));
        // Known scheme: accept any non-empty page so we can advance over pages
        // we already have. Still detecting: only accept a page with genuinely
        // new items, so a feed that ignores the paging param (and returns page
        // 1 again) doesn't lock the wrong scheme.
        if (p.items.length > 0 && (scheme || hasFresh)) {
          parsed = p;
          usedKind = kind;
          break;
        }
      } catch {
        /* 404 or fetch error: try the other scheme */
      }
    }

    if (!parsed) {
      exhausted = true; // nothing paged back -> end of the feed
      break;
    }
    if (!scheme) scheme = usedKind;
    page += 1;

    const fresh = parsed.items.filter((it) => !seen.has(it.key));
    if (fresh.length > 0) {
      for (const it of fresh) {
        seen.add(it.key);
        collected.push(it);
      }
      newPages += 1;
    }
  }

  if (collected.length > 0) {
    const items = collected.map((it) => ({
      id: `${feed.id}::${it.key}`,
      title: it.title,
      link: it.link,
      author: it.author,
      publishedAt: it.publishedAt,
      summary: it.summary,
      read: true, // older history: keep the unread badge clean
    }));
    await mergeEntries(feed.id, items);
  }

  await setFeedMeta(feed.id, {
    pageScheme: scheme || null,
    deepestPage: page,
    exhausted,
  });

  return { added: collected.length, exhausted };
}

async function refreshAll() {
  const feeds = await getFeeds();

  // Sequential, not parallel: each refresh does a read-modify-write on the
  // shared entries list, so concurrent writes would clobber each other (and
  // could drop read state). A few feeds cost little done in order.
  let totalNew = 0;
  const newByFeed = [];
  for (const feed of feeds) {
    try {
      const { newCount } = await refreshFeed(feed);
      totalNew += newCount;
      if (newCount > 0) newByFeed.push({ title: feed.title, count: newCount });
    } catch (err) {
      console.warn(`Feed failed: ${feed?.url}`, err);
    }
  }

  await updateBadge();
  if (totalNew > 0) await maybeNotify(totalNew, newByFeed);
  return { totalNew };
}

// ---- badge (custom-drawn icon) + notifications ----------------------------

// Chrome's native badge font is fixed and small. We draw our own: the RSS icon
// as the background, with a red rounded badge in the corner holding the count,
// sized larger than the native badge so it reads on Retina.
function drawBase(ctx, S) {
  const r = S * 0.22;
  ctx.beginPath();
  ctx.roundRect(0.5, 0.5, S - 1, S - 1, r);
  ctx.fillStyle = "#7c5cff";
  ctx.fill();

  // RSS glyph: dot + two arcs, lower-left.
  const cx = S * 0.3;
  const cy = S * 0.72;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, S * 0.075, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = S * 0.09;
  for (const rad of [0.3, 0.52]) {
    ctx.beginPath();
    ctx.arc(cx, cy, S * rad, -Math.PI / 2, 0);
    ctx.stroke();
  }
}

function drawTile(S, label) {
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, S, S);
  drawBase(ctx, S);

  if (label) {
    const H = S * 0.72; // badge height (same as before)
    const m = S * 0.02;

    let fs = H * 0.9; // number a bit larger, fills more of the badge
    const fit = () => (ctx.font = `700 ${fs}px "Helvetica Neue",Arial, sans-serif`);
    fit();
    while (ctx.measureText(label).width > S * 0.68 && fs > 6) {
      fs -= 1;
      fit();
    }

    const textW = ctx.measureText(label).width;
    const W = Math.max(H, textW + S * 0.2);
    const x1 = S - m - W;
    const y1 = S - m - H;

    ctx.beginPath();
    ctx.roundRect(x1, y1, W, H, H / 2);
    ctx.fillStyle = "#ff3b30";
    ctx.fill();
    ctx.lineWidth = Math.max(1, S * 0.02);
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x1 + W / 2, y1 + H / 2 + S * 0.02);
  }
  return ctx.getImageData(0, 0, S, S);
}

function countIcon(count) {
  const label = count > 99 ? "99+" : String(count);
  const imageData = {};
  for (const s of [16, 32, 48, 128]) imageData[String(s)] = drawTile(s, label);
  return imageData;
}

async function updateBadge() {
  const count = await unreadCount();
  await chrome.action.setBadgeText({ text: "" }); // we draw our own number
  if (count > 0) {
    await chrome.action.setIcon({ imageData: countIcon(count) });
    await chrome.action.setTitle({ title: `FeedWatch — ${count} unread` });
  } else {
    await chrome.action.setIcon({
      path: { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" },
    });
    await chrome.action.setTitle({ title: "FeedWatch" });
  }
}

async function maybeNotify(totalNew, newByFeed) {
  const { notifications } = await getSettings();
  if (!notifications) return;

  const lines = newByFeed
    .slice(0, 5)
    .map((f) => `${f.title}: ${f.count}`)
    .join("\n");

  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${totalNew} new item${totalNew === 1 ? "" : "s"}`,
    message: lines || "New items in your feeds",
    priority: 0,
  });
}

chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.();
});
