// store.js
// Single source of truth for persisted data. Everything lives in
// chrome.storage.local; nothing leaves the machine.

// Retention cap per feed. Only regular read items count toward it; unread and
// starred are always kept. Older items pulled on demand land as read, so this
// also bounds how far back you can scroll before the oldest get pruned.
export const MAX_ENTRIES_PER_FEED = 200;

// ---- write lock --------------------------------------------------------------
// Every mutator does a read-modify-write on shared keys. Popup and the service
// worker are separate JS realms, so an in-memory queue alone cannot serialize
// them. We combine:
//   1. a per-realm promise chain (and reentrancy depth) so nested calls like
//      mergeEntries -> setFeedMeta do not deadlock, and
//   2. a chrome.storage.session lock so popup marks and background merges
//      cannot clobber each other.
const LOCK_KEY = "_writeLock";
const LOCK_TTL_MS = 8000;
const LOCK_WAIT_MS = 15000;

let writeChain = Promise.resolve();
let lockDepth = 0;
let heldLockToken = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireSessionLock() {
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const now = Date.now();
    const { [LOCK_KEY]: lock } = await chrome.storage.session.get(LOCK_KEY);
    if (!lock || now - lock.ts > LOCK_TTL_MS) {
      await chrome.storage.session.set({ [LOCK_KEY]: { token, ts: now } });
      const { [LOCK_KEY]: check } = await chrome.storage.session.get(LOCK_KEY);
      if (check?.token === token) {
        heldLockToken = token;
        return;
      }
    }
    await sleep(15 + Math.random() * 35);
  }
  throw new Error("Could not acquire storage write lock");
}

async function releaseSessionLock() {
  const token = heldLockToken;
  heldLockToken = null;
  if (!token) return;
  const { [LOCK_KEY]: lock } = await chrome.storage.session.get(LOCK_KEY);
  if (lock?.token === token) {
    await chrome.storage.session.remove(LOCK_KEY);
  }
}

/** Run `fn` under the cross-context write lock. Re-entrant within one realm. */
export async function withWriteLock(fn) {
  if (lockDepth > 0) return fn();

  let releaseChain;
  const gate = new Promise((r) => {
    releaseChain = r;
  });
  const prev = writeChain;
  writeChain = writeChain.then(() => gate);
  await prev;

  lockDepth++;
  try {
    await acquireSessionLock();
    try {
      return await fn();
    } finally {
      await releaseSessionLock();
    }
  } finally {
    lockDepth--;
    releaseChain();
  }
}

// A stable identity for an item based on its link, so read/starred state sticks
// even when a feed's guid drifts or carries a per-fetch token. Strips common
// tracking params, lowercases the origin, drops trailing slashes. The fragment
// is KEPT: some feeds permalink each item as an anchor on one page, so dropping
// it would collapse every item into a single entry.
function normLink(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|igshid|ref$|ref_)/i.test(p)) u.searchParams.delete(p);
    }
    return (
      u.origin.toLowerCase() +
      u.pathname.replace(/\/+$/, "") +
      (u.search || "") +
      (u.hash || "")
    );
  } catch {
    return String(url).trim();
  }
}

export const DEFAULT_SETTINGS = {
  notifications: false,
  intervalMinutes: 30,
};

export async function getFeeds() {
  const { feeds = [] } = await chrome.storage.local.get("feeds");
  return feeds;
}

export async function getEntries() {
  const { entries = [] } = await chrome.storage.local.get("entries");
  return entries;
}

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function setSettings(patch) {
  return withWriteLock(async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  });
}

export async function addFeed({ url, title, iconUrl }) {
  return withWriteLock(async () => {
    const feeds = await getFeeds();
    if (feeds.some((f) => f.url === url)) {
      throw new Error("That feed is already added.");
    }
    const feed = {
      id: crypto.randomUUID(),
      url,
      title: title || url,
      iconUrl: iconUrl || null,
      addedAt: Date.now(),
    };
    feeds.push(feed);
    await chrome.storage.local.set({ feeds });
    return feed;
  });
}

// Update mutable feed metadata (e.g. icon discovered on a later refresh).
export async function setFeedMeta(feedId, patch) {
  return withWriteLock(async () => {
    const feeds = await getFeeds();
    const f = feeds.find((x) => x.id === feedId);
    if (!f) return;
    let changed = false;
    for (const k of [
      "title",
      "iconUrl",
      "pageScheme",
      "deepestPage",
      "exhausted",
      "initialized",
      "pruneWatermark",
    ]) {
      if (patch[k] != null && patch[k] !== f[k]) {
        f[k] = patch[k];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ feeds });
  });
}

export async function renameFeed(feedId, title) {
  return withWriteLock(async () => {
    const feeds = await getFeeds();
    const feed = feeds.find((f) => f.id === feedId);
    if (feed) {
      feed.title = title;
      await chrome.storage.local.set({ feeds });
    }
  });
}

// Edit a feed's title and/or URL. Keeps the feed id (and its entries) stable.
export async function editFeed(feedId, { title, url }) {
  return withWriteLock(async () => {
    const feeds = await getFeeds();
    const feed = feeds.find((f) => f.id === feedId);
    if (!feed) return;
    if (url && feeds.some((f) => f.id !== feedId && f.url === url)) {
      throw new Error("Another feed already uses that URL.");
    }
    if (title != null) feed.title = title.trim() || feed.title;
    if (url) feed.url = url.trim();
    await chrome.storage.local.set({ feeds });
  });
}

export async function removeFeed(feedId) {
  return withWriteLock(async () => {
    const feeds = (await getFeeds()).filter((f) => f.id !== feedId);
    const entries = (await getEntries()).filter((e) => e.feedId !== feedId);
    await chrome.storage.local.set({ feeds, entries });
  });
}

// Used by the service worker when the entry id scheme changes: keep feeds,
// drop entries so they repopulate cleanly on the next fetch.
export async function resetEntries(schemaVersion) {
  return withWriteLock(async () => {
    await chrome.storage.local.set({ entries: [], schemaVersion });
  });
}

// Merge freshly fetched items into storage. Preserves read/starred state for
// entries we already had, matching first by id and then by normalized link so
// a drifting guid can't resurrect read items as new. Also collapses any
// duplicates a previous drift may have created. Returns the count of new items.
export async function mergeEntries(feedId, items) {
  return withWriteLock(async () => {
    const entries = await getEntries();
    const feedRec = (await getFeeds()).find((f) => f.id === feedId);
    const prevWatermark = feedRec?.pruneWatermark || 0;
    const mine = entries.filter((e) => e.feedId === feedId);
    const others = entries.filter((e) => e.feedId !== feedId);

    const byId = new Map(mine.map((e) => [e.id, e]));
    const byLink = new Map();
    for (const e of mine) {
      const nl = normLink(e.link);
      if (nl && !byLink.has(nl)) byLink.set(nl, e);
    }

    const matched = new Set(); // ids of existing entries already consumed
    let newCount = 0;
    const now = Date.now();
    const merged = [];

    for (const item of items) {
      const nl = normLink(item.link);
      // Match by exact id (the parsed key, ideally a stable permalink), then by
      // normalized link so a drifting guid can't resurrect a read item as new.
      let prev = byId.get(item.id);
      if (!prev && nl) prev = byLink.get(nl);

      if (prev && !matched.has(prev.id)) {
        matched.add(prev.id);
        // Keep the existing identity and user state; refresh content fields.
        merged.push({
          ...prev,
          title: item.title,
          link: item.link,
          author: item.author,
          publishedAt: item.publishedAt ?? prev.publishedAt,
          summary: item.summary,
        });
      } else if (prev) {
        // another incoming item pointing at the same stored entry: skip
        continue;
      } else {
        // If this item is older than the newest thing we previously pruned, it is
        // history the user already had (and likely already read), not news. Import
        // it read so the retention cap cannot manufacture unread items every poll.
        const ts = item.publishedAt || 0;
        const isPrunedHistory = prevWatermark > 0 && ts > 0 && ts <= prevWatermark;
        if (!isPrunedHistory) newCount++;
        merged.push({
          ...item,
          feedId,
          read: item.read ?? isPrunedHistory,
          starred: false,
          fetchedAt: now,
        });
      }
    }

    // Existing entries not seen in this fetch: keep them (feeds drop old items).
    for (const e of mine) if (!matched.has(e.id)) merged.push(e);

    // Newest first, then collapse duplicates that share a normalized link (or id
    // when there is no link). This cleans up any dupes a prior mismatch wrote,
    // without merging distinct items that happen to share a title. If any copy was
    // read or starred, the survivor inherits that so nothing resurfaces.
    merged.sort(
      (a, b) => (b.publishedAt || b.fetchedAt) - (a.publishedAt || a.fetchedAt)
    );
    const canon = new Map();
    const order = [];
    for (const e of merged) {
      const idk = normLink(e.link) || e.id;
      const ex = canon.get(idk);
      if (!ex) {
        canon.set(idk, e);
        order.push(idk);
      } else {
        ex.read = ex.read || e.read;
        ex.starred = ex.starred || e.starred;
      }
    }

    // Cap, but never drop unread or starred items. Anything dropped here is old
    // read history; record how recent the newest dropped item was so that when
    // the feed serves it again we re-import it as read instead of as news.
    const kept = [];
    let readCount = 0;
    let droppedWatermark = 0;
    for (const idk of order) {
      const e = canon.get(idk);
      if (!e.read || e.starred || readCount < MAX_ENTRIES_PER_FEED) {
        kept.push(e);
        if (e.read && !e.starred) readCount++;
      } else {
        const ts = e.publishedAt || e.fetchedAt || 0;
        if (ts > droppedWatermark) droppedWatermark = ts;
      }
    }

    await chrome.storage.local.set({ entries: [...others, ...kept] });
    if (droppedWatermark > prevWatermark) {
      await setFeedMeta(feedId, { pruneWatermark: droppedWatermark });
    }
    return newCount;
  });
}

export async function markRead(entryId, read) {
  return withWriteLock(async () => {
    const entries = await getEntries();
    const e = entries.find((x) => x.id === entryId);
    if (e) {
      e.read = read;
      await chrome.storage.local.set({ entries });
    }
  });
}

export async function toggleStar(entryId) {
  return withWriteLock(async () => {
    const entries = await getEntries();
    const e = entries.find((x) => x.id === entryId);
    if (e) {
      e.starred = !e.starred;
      await chrome.storage.local.set({ entries });
    }
  });
}

// Mark all read, optionally scoped to one feed.
export async function markAllRead(feedId = null) {
  return withWriteLock(async () => {
    const entries = await getEntries();
    for (const e of entries) {
      if (feedId === null || e.feedId === feedId) e.read = true;
    }
    await chrome.storage.local.set({ entries });
  });
}

export async function unreadCount(entries) {
  const list = entries || (await getEntries());
  return list.filter((e) => !e.read).length;
}
