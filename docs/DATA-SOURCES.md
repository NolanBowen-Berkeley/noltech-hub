# Data sources

This document explains where NolTech Hub gets lot listings and price data, why
the public build ships with generated sample data, and how to connect a real
source you're authorized to use.

## What this build does not include

The private build this repository was derived from obtained lot listings,
manifests, and sold-price comparables by scraping auction and marketplace
websites — HTML parsing behind a commercial proxy service that rotates IPs to
get past bot detection.

That code is not here, and it isn't coming back. Two reasons:

1. **Terms of service.** The sites involved prohibit automated access in their
   terms. Using a proxy service specifically to defeat their bot detection is
   not a grey area — it's circumventing an access control the operator put
   there deliberately.
2. **It's a bad foundation.** Scrapers break whenever the target's markup
   changes, and every breakage is silent: you get zero results, or worse,
   wrong ones. Pricing decisions built on that are pricing decisions built on
   sand.

Removed along with it: the proxy-service client, the search-page and
sold-listings HTML parsers, the per-site closing-price lookups, and the
`puppeteer-core` / `cheerio` dependencies that supported them.

## What replaced it

A provider interface: `noltech-pipeline/src/providers/`. Everything the
pipeline knows about the outside world arrives through one of two contracts.

**Lot provider** — where lots come from:

| Method | Returns |
| --- | --- |
| `searchLots(env, { source, page, log })` | `{ ok, source, lots[], page }` |
| `fetchManifest(env, { lotId, lotUrl, ... })` | `{ ok, manifestUrl, headers[], rows[][] }` |
| `fetchLotState(env, { lotId, lotUrl })` | `{ ok, ended, status, currentPrice, finalBid, endsAt }` |
| `fetchImage(env, { url, lotId })` | `{ ok, bytes, contentType }` |

**Comps provider** — what things sell for:

| Method | Returns |
| --- | --- |
| `lookup(env, { query, condition, category, soldDays, maxResults })` | `{ ok, items[], total }` |

A provider may implement a subset. Anything it omits returns HTTP 501 with a
clear message rather than throwing, so a partial provider is a legitimate
thing to ship.

## Built-in providers

### `sample` (default, both roles)

Deterministic generated data from `src/providers/fixtures.js`. No network, no
credentials, no terms to honor.

It exists so a fresh clone runs: the browse UI populates, the analysis queue
drains, the scoring model produces numbers, and the crons exercise both the
"auction open" and "auction ended" branches. Manifests come back with
plausible brands, models, UPCs, and MSRPs; comps come back log-normally
distributed around a per-query base, outliers included, so the filtering stage
has something real to do.

**It tells you nothing true about the market.** Responses carry
`sample: true`, `/health` reports `usingSampleData`, the Hub labels the view
"Using sample data", and the sync agent refuses to write sample lots into
Supabase. Those guards are deliberate — generated numbers reaching a real
bidding decision is the failure mode worth engineering against.

### `ebay-browse` (comps only)

Real pricing through eBay's official Browse API, using your own developer
credentials over the documented endpoint.

```bash
# 1. Create an app keyset at https://developer.ebay.com/my/keys
# 2. In noltech-pipeline/.env:
EBAY_APP_ID=your-client-id
EBAY_CERT_ID=your-client-secret
COMPS_PROVIDER=ebay-browse
```

**The caveat that matters:** Browse API returns *active* listings — what
sellers are asking, not what buyers paid. Asking prices skew high, because
unsold inventory is by definition the inventory nobody paid that price for.
Treat the output as an upper bound.

eBay's actual sold data comes from the **Marketplace Insights API**, which is
limited-release — you apply for access per application. If you're granted it,
wrap it as a custom provider (below); it returns genuine sold prices in the
same shape.

## Writing a custom provider

Point the pipeline at any module that exports `lotProvider` and/or
`compsProvider`:

```bash
# noltech-pipeline/.env
LOT_PROVIDER=custom
LOT_PROVIDER_MODULE=/absolute/path/to/my-provider.js

COMPS_PROVIDER=custom
COMPS_PROVIDER_MODULE=@myorg/noltech-comps-provider
```

The module specifier is passed to a dynamic `import()`, so an npm package name
or an absolute path both work (use a `file:` URL on Windows).

```js
// my-provider.js
export const lotProvider = {
  id: 'my-feed',
  label: 'Supplier CSV drop',

  async searchLots(env, { source, page, log }) {
    const lots = await readTodaysDrop(env.SUPPLIER_DROP_DIR);
    return { ok: true, source, page, lots };
  },

  async fetchManifest(env, { lotId }) {
    // Return the manifest as a raw table. The pipeline handles column
    // mapping, condition inference, and categorization from here —
    // see src/shared/manifestTable.js.
    const { headers, rows } = await readManifestCsv(lotId);
    return { ok: true, manifestUrl: `file://manifests/${lotId}`, headers, rows };
  },

  // fetchLotState and fetchImage omitted — those routes return 501.
};
```

Then list your source IDs so the fan-out knows about them:

```bash
LOT_SOURCES=my-feed
```

## Sourcing data you're allowed to use

Roughly in order of how much trouble they'll save you:

- **An official API.** Most large marketplaces have one. eBay, Amazon (SP-API),
  and Shopify all do. Read the rate limits before you design around them.
- **A supplier feed.** If you buy from a liquidator regularly, ask whether they
  publish a manifest feed or an API for customers. Many do and don't advertise
  it. This is usually the highest-quality option and nobody thinks to ask.
- **Your own exports.** The manifest table parser accepts CSV-shaped rows and
  HTML tables, so a manifest you downloaded from your own account is a
  perfectly good input — and unambiguously yours to use.
- **A licensed data vendor.** Several sell marketplace pricing data under terms
  that permit exactly this. You're paying for the license as much as the data.

Whatever you pick, check its terms yourself. A provider being easy to write is
not the same as it being permitted, and this repository can't make that call
for you.
