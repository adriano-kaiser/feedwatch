# FeedWatch

A private RSS/Atom reader as a Chrome extension. No accounts, no servers, no
telemetry. It polls your feeds on a schedule, badges the unread count on the
toolbar icon, and lets you read, search, star, and mark items read. All data
lives in `chrome.storage.local` on your machine.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the FeedWatch icon so you can see the badge

## Add feeds

Click the **+** button (or the gear, then the field at the bottom of Settings)
and paste either:

- a direct feed URL (RSS 2.0 or Atom), or
- a normal site URL. FeedWatch will try to auto-discover the feed via the
  page's `<link rel="alternate" type="application/rss+xml">`.

Tip: paste the same feed URLs you already use elsewhere.

## What it does

- **30-minute polling** via `chrome.alarms` (change to 15/30/60/120 min in
  Settings). Works while the popup is closed.
- **Big count on the icon.** Instead of Chrome's tiny fixed-size badge, the
  unread count is drawn onto the toolbar icon so it stays readable on Retina.
  The plain RSS icon returns when everything is read.
- **History backfill.** Most feeds only return the latest ~10 items per request.
  When a feed is new or sparse, FeedWatch pulls older pages (`rel="next"` or
  `?paged=N`) so you get a fuller list immediately, then accumulates more over
  time (kept up to 200 per feed; unread and starred items are never pruned).
- **Feed icons, tab-favicon fallback.** Uses the feed's declared image
  (`<image>` / `<icon>`). If the feed has none, it reads the site's own favicon
  the way a browser tab does (`<link rel="icon">`, else `/favicon.ico`), so
  feeds like Datadog release notes still get an icon.
- **Per-feed view** with unread counts, a back button, and a filter that cycles
  All / Unread / Starred. Renders 20 entries and loads more as you scroll (plus
  a Load more button).
- **Mark as read / unread** per item, plus **Mark all read** for one feed or
  everything.
- **Search** across titles and summaries.
- **Star** items to keep them.
- Optional **desktop notifications** when new items arrive (off by default).

## Why you can trust it

- The only network requests are `fetch()` calls to the feed URLs you add. There
  is no analytics, no third party, no phone-home. Read `background.js`, it is
  the only file that touches the network.
- Storage is local only (`chrome.storage.local`). Nothing is synced or uploaded.
- Feed content is rendered with `textContent`, not `innerHTML`, so a malicious
  feed cannot inject script into the popup.

## Tightening permissions (optional)

`manifest.json` requests `host_permissions: ["<all_urls>"]` so you can add any
feed without re-prompting. If you prefer least privilege, replace it with the
specific feed origins you use, e.g.:

```json
"host_permissions": ["https://github.blog/*", "https://www.datadoghq.com/*"]
```

You will then need to add the origin here whenever you add a feed on a new
domain. `notifications` can also be removed from `permissions` if you never want
desktop notifications.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker: polling, fetch, badge, notifications |
| `parser.js` | Dependency-free RSS/Atom parser (no DOMParser needed) |
| `store.js` | `chrome.storage.local` data layer |
| `popup.html` / `popup.css` / `popup.js` | The reader UI |

