// parser.js
// Minimal RSS 2.0 / Atom parser. MV3 service workers have no DOMParser,
// so this works purely on strings. Handles CDATA, entity decoding,
// Atom <link href>, next-page links, and the common date/author variants.

// Common HTML named entities seen in WordPress and other feeds.
const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022",
  middot: "\u00B7", copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  deg: "\u00B0", euro: "\u20AC", pound: "\u00A3", cent: "\u00A2",
  sect: "\u00A7", para: "\u00B6", laquo: "\u00AB", raquo: "\u00BB",
  times: "\u00D7", divide: "\u00F7", frac12: "\u00BD", frac14: "\u00BC",
  frac34: "\u00BE", eacute: "\u00E9", egrave: "\u00E8", ecirc: "\u00EA",
  agrave: "\u00E0", acirc: "\u00E2", ccedil: "\u00E7", uuml: "\u00FC",
  ouml: "\u00F6", auml: "\u00E4", szlig: "\u00DF", ntilde: "\u00F1",
  iacute: "\u00ED", oacute: "\u00F3", uacute: "\u00FA", aacute: "\u00E1",
};

function cp(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

function decodeEntities(str) {
  if (!str) return "";
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      NAMED[name] ?? NAMED[name.toLowerCase()] ?? m
    );
}

// Strip HTML tags to get a plain-text preview for the entry list.
function stripHtml(str) {
  return decodeEntities(str || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// First matching <tag>...</tag> block, returns inner content (raw).
function firstTag(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}

// Atom <link ... href="..."> (prefers rel="alternate" or no rel). Also matches
// the namespaced <atom:link ...> form some RSS feeds use for item permalinks.
function atomLink(block) {
  const links = block.match(/<(?:atom:)?link\b[^>]*>/gi) || [];
  let fallback = null;
  for (const raw of links) {
    const href = (raw.match(/href=["']([^"']*)["']/i) || [])[1];
    if (!href) continue;
    const rel = (raw.match(/rel=["']([^"']*)["']/i) || [])[1];
    if (!rel || rel.toLowerCase() === "alternate") return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }
  return fallback;
}

function parseDate(raw) {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : t;
}

// Stable per-item key, independent of which URL/page fetched it, so the same
// item keeps one identity across pages and across polls. A permalink URL is the
// most reliable anchor, so prefer a URL-shaped guid, then a URL-shaped link,
// before falling back to whatever is present. The feed identity is added at
// merge time as `${feedId}::${key}`.
function itemKey(guid, link, title) {
  const isUrl = (s) => /^https?:\/\//i.test((s || "").trim());
  const g = (guid || "").trim();
  const l = (link || "").trim();
  if (isUrl(g)) return g;
  if (isUrl(l)) return l;
  return (g || l || title || "").trim();
}

// Next-page URL from a feed-level <link rel="next" href> (Atom paging / RFC 5005).
function nextPageLink(xml) {
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const links = head.match(/<(?:atom:)?link\b[^>]*>/gi) || [];
  for (const raw of links) {
    if (/rel=["']?next/i.test(raw)) {
      const href = (raw.match(/href=["']([^"']+)["']/i) || [])[1];
      if (href) return decodeEntities(href);
    }
  }
  return null;
}

// Resolve a possibly-relative href against the feed URL so links open in a
// browser tab. github.blog uses absolute links; some feeds (release notes,
// custom endpoints) use relative ones that are useless without resolving.
function absUrl(href, base) {
  if (!href) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

// Returns { title, items: [{ id, title, link, author, publishedAt, summary }] }
export function parseFeed(xml, feedUrl) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);

  // Feed title lives in <channel><title> (RSS) or top-level <feed><title> (Atom).
  const channel = firstTag(xml, "channel");
  let feedTitle = null;
  if (channel) feedTitle = firstTag(channel, "title");
  if (!feedTitle) {
    // Atom: take the first <title> that is NOT inside an <entry>.
    const beforeEntry = xml.split(/<entry[\s>]/i)[0];
    feedTitle = firstTag(beforeEntry, "title");
  }
  feedTitle = decodeEntities(feedTitle || "").trim() || null;

  // Feed icon: RSS <channel><image><url>, Atom <icon> or <logo>.
  let iconUrl = null;
  if (channel) {
    const imageBlock = firstTag(channel, "image");
    if (imageBlock) {
      iconUrl = decodeEntities(firstTag(imageBlock, "url") || "").trim() || null;
    }
  }
  if (!iconUrl) {
    const beforeEntry = xml.split(/<entry[\s>]/i)[0];
    iconUrl =
      decodeEntities(
        firstTag(beforeEntry, "icon") || firstTag(beforeEntry, "logo") || ""
      ).trim() || null;
  }
  if (iconUrl) {
    try {
      iconUrl = new URL(iconUrl, feedUrl).href;
    } catch {
      /* keep as-is */
    }
  }

  // Site link (used to derive a favicon when the feed carries no icon).
  let siteLink = channel
    ? decodeEntities(firstTag(channel, "link") || "").trim() || null
    : null;
  if (!siteLink) {
    const head = xml.split(/<entry[\s>]/i)[0];
    siteLink = atomLink(head);
  }

  const blockTag = isAtom ? "entry" : "item";
  const blockRe = new RegExp(`<${blockTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${blockTag}>`, "gi");

  const items = [];
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];

    const title = decodeEntities(firstTag(block, "title") || "").trim();

    // Link: RSS <link>url</link>, or an Atom-style <link href="..."/> which
    // some otherwise-RSS feeds use. Try the text form first, then the href form.
    let link = decodeEntities(firstTag(block, "link") || "").trim() || null;
    if (!link) link = atomLink(block);

    const guid = decodeEntities(
      firstTag(block, "guid") || firstTag(block, "id") || ""
    ).trim() || null;

    // Some feeds carry the permalink only in <guid>/<id> and ship no <link> at
    // all. Without this fallback the entry has nothing to open and clicking it
    // does nothing.
    if (!link && /^https?:\/\//i.test(guid || "")) link = guid;

    if (link) link = absUrl(link, feedUrl); // resolve relative links so they open

    const dateRaw =
      firstTag(block, "pubDate") ||
      firstTag(block, "published") ||
      firstTag(block, "updated") ||
      firstTag(block, "dc:date");
    const publishedAt = parseDate(dateRaw);

    const author = decodeEntities(
      firstTag(block, "dc:creator") ||
        firstTag(firstTag(block, "author") || "", "name") ||
        firstTag(block, "author") ||
        ""
    ).trim() || null;

    const summaryRaw =
      firstTag(block, "content:encoded") ||
      firstTag(block, "description") ||
      firstTag(block, "summary") ||
      firstTag(block, "content") ||
      "";
    const summary = stripHtml(summaryRaw).slice(0, 400);

    if (!title && !link) continue;

    items.push({
      key: itemKey(guid, link, title),
      title: title || "(untitled)",
      link,
      author,
      publishedAt,
      summary,
    });
  }

  return { title: feedTitle, iconUrl, siteLink, next: nextPageLink(xml), items };
}

// Best-effort feed discovery when the user pastes a site URL instead of a feed URL.
export function discoverFeedUrl(html, baseUrl) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (const raw of links) {
    if (!/rel=["']?alternate/i.test(raw)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(raw)) continue;
    const href = (raw.match(/href=["']([^"']+)["']/i) || [])[1];
    if (href) {
      try {
        return new URL(decodeEntities(href), baseUrl).href;
      } catch {
        return decodeEntities(href);
      }
    }
  }
  return null;
}

export function looksLikeFeed(text) {
  return /<rss[\s>]/i.test(text) || /<feed[\s>]/i.test(text) || /<rdf:RDF[\s>]/i.test(text);
}

// Pick the best <link rel="icon"> (or apple-touch-icon) from a page's HTML.
// Returns an absolute URL, or null. Prefers larger declared sizes.
export function pickIconFromHtml(html, origin) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  let best = null;
  let bestScore = -1;
  for (const raw of links) {
    if (!/rel=["'][^"']*icon/i.test(raw)) continue;
    const href = (raw.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    let score = 1;
    const sizes = (raw.match(/sizes=["'](\d+)x\d+["']/i) || [])[1];
    if (sizes) score = parseInt(sizes, 10);
    if (/apple-touch-icon/i.test(raw)) score = Math.max(score, 180);
    if (score > bestScore) {
      bestScore = score;
      try {
        best = new URL(decodeEntities(href), origin).href;
      } catch {
        best = decodeEntities(href);
      }
    }
  }
  return best;
}
