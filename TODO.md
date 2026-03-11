# TODO

## Potential Data Sources to Investigate

### Congressman Stock Purchases
- Source: [House Stock Watcher](https://housestockwatcher.com/) / [Senate Stock Watcher](https://senatestockwatcher.com/)
- Official disclosures via STOCK Act filings on clerk.house.gov and efts.senate.gov
- Map trades to votes/legislation for correlation analysis

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

### Astrology Data
- Mercury retrograde dates: publicly available, many astrology APIs and datasets exist (e.g. astro-seek.com, astrology.com)
- Congressman birth date horoscopes: would need birth dates (publicly available for many members)
- Tag each vote/decision with: mercury retrograde (y/n), congressman's sun/moon sign, planetary transits
- Purely for fun / satirical analysis — do not use for actual decision-making
