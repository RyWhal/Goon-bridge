# Stock Trades Table Redesign

## Summary

Replace the current stock-trades split view with a single dense explorer built around row-level trade data. The page should default to the latest 20 trades, expose top-level filters for common lookup tasks, and show expanded context in a right-side details drawer when a trade row is selected.

This redesign also adds Finnhub-backed pricing enrichment:

- historical close price on the trade date, cached durably per `symbol + trade_date`
- current stock price, fetched from Finnhub and cached with a short TTL

The old left-side "members with trades" browser is removed from the primary workflow.

## Goals

- Make stock trades scannable as a market-style table instead of a member-first browser.
- Support direct filtering by the attributes users actually know: date, member, trade type, and ticker.
- Surface filing details and stock context without navigating away from the table.
- Reuse existing disclosure data and existing Finnhub connectivity already present in the repo.
- Persist historical price lookups so the app does not repeatedly re-fetch immutable data.

## Non-Goals

- Full-text search over every raw disclosure field.
- Infinite historical backfill of trade-date prices during this UI change.
- Portfolio analytics, P/L calculations, or charting.
- Automatic redirect support for the removed `/experimental/trades` URL.

## User Experience

### Layout

The stock-trades page becomes a three-part explorer:

1. Filter bar at the top.
2. Dense trade table in the main content area.
3. Right-side details drawer showing information for the currently selected row.

The default page state loads the latest 20 trades and preselects either:

- the first row automatically, or
- no row until the user clicks one.

Recommendation: preselect the first returned row so the drawer does useful work immediately.

### Filters

The top filter bar includes:

- date range: `from` and `to`
- congress member name
- transaction type: all, purchase, sale, exchange
- ticker symbol
- apply and reset actions

Filters should be submitted server-side. The UI should not pretend to search beyond the loaded results.

### Table

The table shows one trade per row. Recommended columns:

- trade date
- member name
- transaction type
- ticker
- asset name
- amount range
- trade-date close price
- current price

Optional future columns:

- state / party
- filing date
- estimated trade value

The table should be compact and readable on desktop first. On narrower screens, lower-priority columns can collapse while preserving tap-to-open drawer behavior.

### Details Drawer

Selecting a row opens or updates a right-side drawer with:

- member name
- asset / company name
- ticker
- transaction type
- transaction date
- amount range
- estimated trade value, if available
- trade-date close price
- current price
- owner label / owner type
- disclosure filed date
- parse confidence
- source filing link
- source row key

The drawer is the place for secondary metadata that would clutter the main table.

## Data Model Changes

### Existing Data

Current trade records already expose:

- symbol
- asset name
- transaction date
- transaction type
- amount range
- estimated trade value
- execution close price in some raw payloads
- filing and organization metadata
- member metadata

### New Pricing Fields

Trade responses should expose consistent pricing fields regardless of whether the source came from old enrichment or new cache logic:

- `trade_date_close_price: number | null`
- `trade_date_price_source: string | null`
- `current_price: number | null`
- `current_price_as_of: string | null`
- `price_change_since_trade: number | null`
- `price_change_percent_since_trade: number | null`

### Price Cache

Add durable storage for historical prices keyed by `symbol + trade_date`.

Recommended table shape:

- `symbol`
- `price_date`
- `close_price`
- `source`
- `fetched_at`
- unique key on `symbol, price_date`

Current-price caching can use either:

- a second table keyed by symbol with `current_price` and `fetched_at`, or
- the same table if the implementation treats current price as date-stamped quote state

Recommendation: use a separate lightweight current-price cache because it has different freshness semantics from immutable historical closes.

## API Design

### Keep Default Latest-Trades Endpoint

Keep the existing latest-trades path for the default page state, but change its default UI consumer to request `limit=20`.

Current route:

- `GET /api/disclosures/trades/recent`

This route should be expanded to return the standardized pricing fields above.

### Add Filtered Search Endpoint

Add a dedicated trade search endpoint for the table:

- `GET /api/disclosures/trades/search`

Supported query params:

- `from`
- `to`
- `member`
- `transaction_type`
- `symbol`
- `limit`
- `offset`

Behavior:

- sort by `transaction_date desc`, then `created_at desc`
- default `limit` to 20
- return total count plus paged rows
- join member, organization, and filing metadata
- enrich each row with cached historical and current price fields

### Query Semantics

- `member` should match canonical member names and direct-order names case-insensitively
- `symbol` should normalize to uppercase before querying
- empty filters should not be applied
- invalid dates should return `400`
- `from > to` should return `400`

## Finnhub Integration

### Historical Price

Historical trade-date pricing should follow this order:

1. use existing stored execution close price if already present on the trade
2. check durable historical cache by `symbol + trade_date`
3. fetch from Finnhub if missing
4. persist cache result for reuse

Historical prices do not expire.

### Current Price

Current pricing should:

1. check a short-TTL cache by symbol
2. fetch from Finnhub quote endpoint if stale or missing
3. persist refreshed quote and fetch timestamp

Recommendation: TTL of 10-15 minutes for current price to balance freshness and free-tier usage.

### Failure Handling

Price lookup failures must not break disclosure results.

If Finnhub fails or a ticker has no result:

- return the trade row anyway
- set price fields to `null`
- show `N/A` in the UI

## Frontend Architecture

### Component Direction

Refactor `StockTradeExplorer` away from:

- member list on the left
- recent-trades cards
- member drilldown mode

Into focused UI units:

- `StockTradeFilters`
- `StockTradeTable`
- `StockTradeDetailDrawer`
- shared formatting helpers for prices, dates, and transaction labels

This is a targeted improvement to file boundaries, not a broad visual rewrite.

### State

Frontend state should include:

- filter draft state
- applied filter state
- selected trade id
- paged trade results
- loading / error state

On initial load:

- fetch latest 20 trades
- select first row if results are present

On filter apply:

- issue search request
- replace table rows
- reset selected row to the first result, if present

On reset:

- clear filters
- reload latest 20

## Error Handling

- empty result set should show a compact empty state inside the table region
- network errors should show a non-blocking error panel above or within the table
- missing pricing data should not produce a page-level error
- drawer should handle null selected row cleanly

## Testing Strategy

### Backend

Add tests for:

- date validation and search query parsing
- transaction type filtering
- member-name search behavior
- symbol normalization
- historical cache reuse
- current-price TTL behavior
- Finnhub failure fallback

### Frontend

Add tests for:

- default latest-20 load
- filter application
- reset behavior
- selecting a row updates the drawer
- no-results state
- pricing fields render as `N/A` when unavailable

## Rollout Plan

1. Add backend pricing/cache support.
2. Add filtered trade search endpoint.
3. Refactor the stock-trades frontend into filter bar, table, and details drawer.
4. Add tests for backend query behavior and frontend explorer behavior.
5. Verify latest-20 default state, filter flow, and drawer interaction manually.

## Risks

- Finnhub free-tier rate limits may be hit if current-price caching is too aggressive.
- Some disclosures may have bad or missing tickers, which will reduce price coverage.
- Existing trade rows may have inconsistent historical close coverage from older ingestion runs.

## Recommendation

Build this in one focused pass, but keep the backend contract conservative:

- latest 20 by default
- server-side filters
- durable historical price cache
- short-TTL current quote cache

That approach fits the requested UX, minimizes repeated Finnhub calls, and avoids loading misleading partial data into the browser.
