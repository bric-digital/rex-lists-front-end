# webmunk-lists-front-end

This repository provides a **Webmunk extension UI + service-worker helper** for **viewing and editing “lists”** that live in Webmunk’s IndexedDB-backed list store (implemented in `@bric/webmunk-core/list-utilities`).

In practice, these lists are most often used as **domain/pattern sets** for:
- block/allow lists
- privacy filter lists (exclude certain URLs from data collection)
- categorization lists (attach categories/metadata to patterns)

> Note: This module’s responsibility is “list management UI + sync”. It does **not** enforce blocking/allowing by itself. The main extension uses the list(s).

## What this module provides

- **Extension UI (`/extension`)**: a “list editor” screen that:
  - lists available list names
  - renders entries in a table
  - allows adding/editing/deleting **user** entries
  - marks **backend** entries read-only
  - supports **export** to JSON and **import** from JSON
  - shows “last sync” time and a **Sync Now** button
- **Service worker helper (`/service-worker`)**:
  - optional periodic sync via `chrome.alarms` (`webmunk-list-sync`)
  - manual sync trigger callable from the UI
  - stores last sync timestamp in `chrome.storage.local` (`webmunk_last_list_sync`)
- **Browser entrypoint (`/browser`)**: currently no-op (list management is done in extension + service worker contexts)

## Data model (from `@bric/webmunk-core/list-utilities`)

- **Storage**: IndexedDB database `webmunk_lists`, store `list_entries`
- **Entry fields** (simplified):
  - `list_name`: string
  - `domain`: string (pattern text)
  - `pattern_type`: one of:
    - `domain` (registered domain ONLY, PSL-aware; must be eTLD+1 like `google.com` — subdomains like `health.google.com` are invalid)
    - `host` (exact hostname match; ignores leading `www.`)
    - `exact_url`
    - `host_path_prefix` (e.g. `example.com/path...`)
    - `regex`
  - `source`: `backend` | `user` | `generated`
  - `metadata`: arbitrary object (e.g. `category`, `description`, `tags`, timestamps)

**Backend sync behavior**: syncing **replaces only the `backend` entries** for each list and preserves `user`/`generated` entries.

## Integration (typical Webmunk extension)

### Extension UI

1. **Import and register** the module:
   - Example (from `webmunk-dev-extension/src/typescript/extension.ts`):
     - `import listsFrontEndExtension from '@bric/webmunk-lists-front-end/extension'`
     - `registerWebmunkModule(listsFrontEndExtension)`
2. **Add an interface** with identifier **`list-editor`** (that’s what the module activates on).
3. Ensure your interface HTML includes a container with id **`list-container`** where the module injects UI.

### Service worker

Import and call `setup()` once during service worker initialization:
- `import listsFrontEndPlugin from '@bric/webmunk-lists-front-end/service-worker'`
- `await listsFrontEndPlugin.setup({ configUrl, syncIntervalMinutes })`

If you omit `configUrl`, the module won’t auto-sync (but you can still use the UI to view/edit whatever is already in IndexedDB).

## Backend configuration format (lists)

The list sync expects the fetched configuration JSON to have a `lists` object like:

```json
{
  "lists": {
    "ai-chatbots": [
      {
        "domain": "chatgpt.com",
        "pattern_type": "domain",
        "metadata": { "category": "ai-chatbot", "description": "ChatGPT AI service" }
      }
    ],
    "user-privacy-filter": [
      {
        "domain": "google.com/maps/",
        "pattern_type": "host_path_prefix",
        "metadata": { "category": "fitness", "description": "Fitness data" }
      }
    ]
  }
}
```

## Notes / current limitations

- This module **manages lists**; it does not itself enforce blocking. Other modules can consume these lists (e.g. for filtering or categorization).
- The UI assumes **Bootstrap** is present and uses **jQuery** for DOM interactions.

