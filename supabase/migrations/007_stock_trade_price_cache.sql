CREATE TABLE stock_price_history_cache (
  symbol TEXT NOT NULL,
  price_date DATE NOT NULL,
  close_price NUMERIC NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, price_date)
);

CREATE TABLE stock_price_quote_cache (
  symbol TEXT PRIMARY KEY,
  current_price NUMERIC NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_price_history_cache_date ON stock_price_history_cache(price_date DESC);
CREATE INDEX idx_stock_price_quote_cache_fetched_at ON stock_price_quote_cache(fetched_at DESC);

ALTER TABLE stock_price_history_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_price_quote_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read" ON stock_price_history_cache FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON stock_price_quote_cache FOR SELECT USING (true);

CREATE POLICY "Allow service write" ON stock_price_history_cache FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service write" ON stock_price_quote_cache FOR ALL USING (true) WITH CHECK (true);
