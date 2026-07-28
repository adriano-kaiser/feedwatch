# Changelog

All notable changes to FeedWatch are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.3] - 2026-07-28

### Fixed
- Release assets: ship a single `feedwatch.zip` (dropped the duplicate versioned zip).

## [1.0.2] - 2026-07-28

### Added
- GitHub Actions release workflow: every push to `main` packages the extension
  as a zip and publishes a GitHub Release.

## [1.0.1] - 2026-07-28

### Fixed
- Cap stored read entries at **200 per feed**, matching the documented retention
  (unread and starred items are still never pruned).
- Serialize storage writes across the popup and service worker with a
  re-entrant write lock so mark-read / star actions cannot race a background
  refresh and lose state.

## [1.0.0] - 2026-07-28

### Added
- Private RSS/Atom reader as a Chrome MV3 extension; all data in
  `chrome.storage.local`.
- Scheduled polling via `chrome.alarms`, custom unread badge on the toolbar
  icon, desktop notifications (opt-in).
- Feed auto-discovery from site URLs, history backfill / on-demand older pages,
  per-feed icons with favicon fallback.
- Search, star, mark read/unread, mark all read, edit/remove feeds.

[1.0.3]: https://github.com/adriano-kaiser/feedwatch/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/adriano-kaiser/feedwatch/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/adriano-kaiser/feedwatch/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/adriano-kaiser/feedwatch/releases/tag/v1.0.0
