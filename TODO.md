# TODO

## Potential Data Sources to Investigate

### Congressman Stock Purchases
- Source: [House Stock Watcher](https://housestockwatcher.com/) / [Senate Stock Watcher](https://senatestockwatcher.com/)
- Official disclosures via STOCK Act filings on clerk.house.gov and efts.senate.gov
- Map trades to votes/legislation for correlation analysis

### USAspending Fallback Cleanup
- Current local behavior: `/api/usaspending/awards` can 502 in Wrangler/Miniflare while the browser-side direct USAspending fallback still succeeds and renders award content
- Keep surfacing the Worker 502 for debugging in the short term
- Later cleanup: make the fallback path explicit in UI/dev logging so successful fallback does not look like a broken awards experience

### Stock Prices Before and After Votes
- Pull historical OHLCV data around vote dates (e.g. via Yahoo Finance, Polygon.io, or Alpha Vantage)
- Define a window (e.g. T-5 to T+5 days around a vote) and measure price movement
- Cross-reference with industries/companies relevant to the bill being voted on

### Price of a Big Mac in Their Home State
- McDonald's doesn't publish official regional pricing, but crowdsourced data exists
- Potential sources: The Economist's Big Mac Index (country-level), PriceSpy, or manual scraping
- Could use as a rough cost-of-living / economic conditions proxy per district

### Google Autocomplete Results for Congressman's Name
- Use the Google Suggest / autocomplete API (unofficial endpoint) to capture public perception
- Query patterns like: "[name]", "[name] is", "[name] was", "[name] will", "[name] stock"
- Track changes over time around key votes or news events
- Note: unofficial API, terms of service considerations apply

### Home State Sports Team Win Records
- Track performance of professional (NFL, NBA, MLB, NHL) and college teams from the congressman's home state/district
- Sources: ESPN API, Sports Reference (sports-reference.com), SportsDataIO, or The Sports DB (free tier)
- Correlate win/loss records around vote dates — does a losing streak affect legislative behavior?
- Could also look at playoff appearances, championships, or rivalry game outcomes as discrete events
- College teams may be more relevant for districts with no pro franchises

### Astrology Data
- Mercury retrograde dates: publicly available, many astrology APIs and datasets exist (e.g. astro-seek.com, astrology.com)
- Congressman birth date horoscopes: would need birth dates (publicly available for many members)
- Tag each vote/decision with: mercury retrograde (y/n), congressman's sun/moon sign, planetary transits
- Purely for fun / satirical analysis — do not use for actual decision-making
