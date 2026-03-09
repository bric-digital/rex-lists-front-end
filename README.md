# rex-lists-front-end

This repository provides a **REX extension UI + service-worker helper** for **viewing and editing "lists"** that live in REX's IndexedDB-backed list store (implemented in `@bric/rex-lists`).

## Configuration

This module reads from the `lists_front_end` section of the backend config.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | Yes | - | Enable/disable the list management UI |
| `config_url` | string | No | derived from core config | URL to fetch list configuration JSON from |
| `sync_interval_minutes` | number | No | 60 | Periodic sync interval for list refresh |

### Example

```json
{
  "lists_front_end": {
    "enabled": true,
    "sync_interval_minutes": 60
  }
}
```

> **Note**: The actual list data is configured in the `lists` section (see [rex-lists](https://github.com/bric-digital/rex-lists)). This module only controls whether the list management UI is available.

### Local Override (Lists Front End Only)

This module supports a local override in `chrome.storage.local` at key `webmunkListsFrontEndConfiguration`.

- If the stored object has a `lists_front_end` object, that object is used.
- If the stored object is already a flat `lists_front_end` config shape, it is also accepted.
- Override values are merged over rex-core configuration and can override fields like:
  - `config_url`
  - `sync_interval_minutes`
- This override is scoped to the lists front end module; it does not replace module config loading rules in other modules.

### Interaction with History Module

- `rex-history` reads list names from `REXConfiguration.history` (for example `allow_lists` and `filter_lists`).
- When a user edits list entries in this UI, those entries are written to the shared lists database.
- History matching uses that same shared list data, so entry changes made here are reflected in history collection behavior for configured lists.

---

In practice, these lists are most often used as **domain/pattern sets** for:
- Filter / block lists - exclude certain URLs/domains from data collection - can work on their own or with allow lists.
- Allow lists - ONLY URLs or domains on these lists are included in data collection.
- Categorization lists attach categories/metadata to patterns

> Note: This module's responsibility is "list management UI + sync". It does **not** enforce blocking/allowing by itself. How lists are used is determiend by the configuration of the extension or module consuming the list.

## What this module provides

- **Extension UI (`/extension`)**: a "list editor" screen that:
  - lists available list names
  - renders entries in a table
  - allows adding/editing/deleting **user** entries
  - marks **backend** entries read-only
  - supports **export** to JSON and **import** from JSON
  - shows "last sync" time and a **Sync Now** button
- **Service worker helper (`/service-worker`)**:
  - optional periodic sync via `chrome.alarms` (`webmunk-list-sync`)
  - manual sync trigger callable from the UI
  - stores last sync timestamp in `chrome.storage.local` (`webmunk_last_list_sync`)
- **Browser entrypoint (`/browser`)**: currently no-op (list management is done in extension + service worker contexts)

---

## URL and Domain Matching

This section describes how URL/domain matching works in the REX list system. Understanding these concepts is important for correctly configuring lists.

### URL Anatomy

A URL like `https://www.mail.google.com/inbox?view=all&demo=789` consists of:
- **Protocol**: `https`
- **Subdomain**: `www.mail` (can be multiple levels)
- **Second-level domain**: `google`
- **Top-level domain (TLD)**: `com` (can be multiple levels e.g. .co.uk)
- **Registered domain (eTLD+1)**: `google.com` (the "ownable" part)
- **Hostname**: `www.mail.google.com`
- **Path**: `/inbox`
- **Query string**: `?view=all&demo=789`

### Pattern Types

All entries in a list specify a `pattern_type` that determines how matching is performed. The `domain` field is the primariy identifier and stores whatever is allowed by the pattern type (domain, regex, etc.).

| Pattern Type | Description | Example Pattern | Matches | Does NOT Match |
|--------------|-------------|-----------------|---------|----------------|
| `domain` | Registered domain only (eTLD+1). Pattern must be a bare domain—no subdomain, scheme, or path. Uses the [Public Suffix List](https://publicsuffix.org/) (PSL) for accurate TLD detection. | `google.com` | `https://www.google.com/maps`, `https://mail.google.com` | `https://google.co.uk`, `https://notgoogle.com` |
| `host` | Exact hostname match. Leading `www.` is normalized away on both sides. | `mail.google.com` | `https://mail.google.com/inbox`, `https://www.mail.google.com` | `https://www.google.com`, `https://google.com` |
| `exact_url` | Full URL string must match exactly (scheme, host, path, query, fragment). | `https://example.com/login?next=/home` | Only that exact URL | Any variation |
| `host_path_prefix` | Hostname + path prefix. Query string is ignored. Leading `www.` is normalized. | `example.com/maps` | `https://www.example.com/maps`, `https://example.com/maps/directions` | `https://example.com/map` (prefix mismatch) |
| `regex` | JavaScript regular expression applied to the full URL string. | `^https://(www\.)?example\.com/.*` | `https://example.com/anything`, `https://www.example.com/path` | `http://example.com` (wrong scheme) |

### Domain Type and the Public Suffix List (PSL)

The `domain` pattern type uses the [psl](https://www.npmjs.com/package/psl) library which implements the [Public Suffix List](https://publicsuffix.org/). This is important for accurately identifying the "registrable domain" (eTLD+1):

- `google.com` → registered domain is `google.com`
- `mail.google.com` → registered domain is still `google.com`
- `example.co.uk` → registered domain is `example.co.uk` (not `co.uk`)
- `subdomain.example.co.uk` → registered domain is `example.co.uk`

**Strict validation**: When using `pattern_type: "domain"`, the pattern *must* be exactly a registered domain to prevents accidental over-matching. Subdomains are rejected:
- `google.com` — Valid
- `mail.google.com` — Invalid (use `host` pattern type instead)
- `www.google.com` — Invalid (use `host` or omit `www.`)

### Regex Pattern Details

The `regex` pattern type uses **JavaScript regular expressions** (ECMAScript flavor). The pattern is tested against the **full URL string** using `new RegExp(pattern).test(url)`.

**Key characteristics:**
- Standard JavaScript regex syntax (ECMAScript)
- Case-sensitive by default (use `[Aa]` character classes or `[a-zA-Z]` for case-insensitivity since the `/i` flag cannot be specified in a pattern string)
- Tests the complete URL including scheme, host, path, and query string
- No anchoring by default—use `^` and `$` for start/end anchors
- Backslashes must be escaped in JSON: `\.` becomes `"\\."` in JSON

**Example patterns:**
```javascript
// Match any google.com URL (with or without www)
"^https?://(www\\.)?google\\.com/.*"

// Match specific paths on multiple domains
"^https://.*\\.(google|bing)\\.com/(search|results)"

// Match URLs containing a specific query parameter
"[?&]utm_source="
```

**Invalid regex handling**: If a regex pattern is malformed, it will not match any URL and an error will be logged to the console.

### Hostname Normalization

For `host` and `host_path_prefix` pattern types:
- Leading `www.` is stripped from **both** the URL and the pattern before comparison
- `www.example.com` and `example.com` are treated as equivalent
- Comparison is case-insensitive (hostnames are lowercased)

---

## How Allow-Listing Works

When an extension configuration uses these lists for allow-listing, the behavior is:

### Allow-List Logic

1. **No allow-lists configured**: All URLs are allowed (permissive default)
2. **Allow-lists configured**: A URL is allowed if it matches **any entry in any configured allow-list**

The check stops at the **first match**—if a URL matches an entry in the first allow-list, subsequent lists are not checked (short-circuit evaluation).

### Example Configuration

```json
{
  "allow_lists": ["research-sites", "approved-domains"]
}
```

With this configuration:
- A URL matching **any** entry in `research-sites` → **Allowed**
- A URL matching **any** entry in `approved-domains` → **Allowed**
- A URL matching entries in **both** lists → **Allowed** (first match wins)
- A URL matching **neither** list → **Not allowed** (skipped/filtered)

### Filter Lists vs. Allow Lists

- **Allow lists**: Determine which URLs are collected at all. If configured, only matching URLs are processed.
- **Filter lists**: Applied after allow-list check. Matching URLs have their recorded URL replaced with a category placeholder (e.g., `CATEGORY:fitness`) for privacy.
- **Category lists**: Used to attach category metadata to URLs without filtering.

---

## Data Model (from `@bric/rex-lists`)

- **Storage**: IndexedDB database `webmunk_lists`, store `list_entries`
- **Entry fields**:
  - `list_name`: string — identifies which list this entry belongs to
  - `domain`: string — the pattern text (despite the name, stores any pattern type)
  - `pattern_type`: one of `domain`, `host`, `exact_url`, `host_path_prefix`, `regex`
  - `source`: `backend` | `user` | `generated`
  - `metadata`: arbitrary object (e.g., `category`, `description`, `tags`, timestamps)
- **Uniqueness**: Entries are unique on `(list_name, pattern_type, domain)`

**Backend sync behavior**: Syncing **replaces only the `backend` entries** for each list and preserves `user`/`generated` entries.

---

## Integration (typical REX extension)

### Extension UI

1. **Import and register** the module:
   - Example (from `rex-dev-extension/src/typescript/extension.ts`):
     - `import listsFrontEndExtension from '@bric/rex-lists-front-end/extension'`
     - `registerREXModule(listsFrontEndExtension)`
2. **Add an interface** with identifier **`list-editor`** (that's what the module activates on).
3. Ensure your interface HTML includes a container with id **`list-container`** where the module injects UI.

### Service Worker

Import and call `setup()` once during service worker initialization:
- `import listsFrontEndPlugin from '@bric/rex-lists-front-end/service-worker'`
- `await listsFrontEndPlugin.setup({ configUrl, syncIntervalMinutes })`

If you omit `configUrl`, the module won't auto-sync (but you can still use the UI to view/edit whatever is already in IndexedDB).

---

## Backend Configuration Format (Lists)

The list sync expects the fetched configuration JSON to have a `lists` object like:

```json
{
  "lists": {
    "ai-chatbots": [
      {
        "domain": "chatgpt.com",
        "pattern_type": "domain",
        "metadata": { "category": "ai-chatbot", "description": "ChatGPT AI service" }
      },
      {
        "domain": "claude.ai",
        "pattern_type": "domain",
        "metadata": { "category": "ai-chatbot", "description": "Claude AI assistant" }
      }
    ],
    "privacy-filter": [
      {
        "domain": "health.example.com",
        "pattern_type": "host",
        "metadata": { "category": "health", "description": "Health portal" }
      },
      {
        "domain": "example.com/account/medical",
        "pattern_type": "host_path_prefix",
        "metadata": { "category": "health" }
      },
      {
        "domain": "^https://.*\\.health\\.(com|org)/",
        "pattern_type": "regex",
        "metadata": { "category": "health" }
      }
    ]
  }
}
```

---

## Notes

- This module **manages lists**; it does not itself enforce blocking. The extension config determins how lists are used.
- The UI assumes **Bootstrap** is present and uses **jQuery** for DOM interactions.
- The `domain` field name stores patterns of all types, not just domains.
