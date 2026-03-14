import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadDotEnv } from "./house_disclosures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_DIR = path.resolve(__dirname, "..");
const DEV_VARS_PATH = path.join(API_DIR, ".dev.vars");

function parseArgs(argv) {
  const options = {
    from: "2024-12-01",
    to: new Date().toISOString().slice(0, 10),
    limit: null,
    offset: 0,
    concurrency: 1,
    baseUrl: "http://127.0.0.1:8789",
    maxRetries: 3,
    retryDelayMs: 5_000,
    cooldownMs: 60_000,
    checkpointPath: path.join(API_DIR, ".cache", "trade-org-activity-checkpoint.json"),
    resume: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from") options.from = argv[++i] ?? options.from;
    else if (arg === "--to") options.to = argv[++i] ?? options.to;
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--offset") options.offset = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--concurrency") options.concurrency = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--base-url") options.baseUrl = argv[++i] ?? options.baseUrl;
    else if (arg === "--max-retries") options.maxRetries = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--retry-delay-ms") options.retryDelayMs = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--cooldown-ms") options.cooldownMs = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--checkpoint-path") options.checkpointPath = argv[++i] ?? options.checkpointPath;
    else if (arg === "--resume") options.resume = true;
  }

  if (!Number.isFinite(options.offset) || options.offset < 0) options.offset = 0;
  if (!Number.isFinite(options.concurrency) || options.concurrency <= 0) options.concurrency = 1;
  if (options.limit != null && (!Number.isFinite(options.limit) || options.limit <= 0)) options.limit = null;
  if (!Number.isFinite(options.maxRetries) || options.maxRetries < 0) options.maxRetries = 3;
  if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) options.retryDelayMs = 5_000;
  if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) options.cooldownMs = 60_000;

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readCheckpoint(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCheckpoint(filePath, checkpoint) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
}

function isRateLimitError(message) {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes("rate limit") || normalized.includes("429");
}

function normalizeTicker(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return normalized && /^[A-Z.\-]+$/.test(normalized) ? normalized : null;
}

async function loadCandidateSymbols(sb) {
  const tradeRes = await sb
    .from("member_stock_trades")
    .select("symbol")
    .not("symbol", "is", null)
    .order("symbol", { ascending: true })
    .limit(5000);

  if (tradeRes.error) {
    throw new Error(`Failed to load trade symbols: ${tradeRes.error.message}`);
  }

  return [...new Set(
    (tradeRes.data ?? [])
      .map((row) => normalizeTicker(row.symbol))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
}

async function refreshSymbol(baseUrl, symbol, from, to) {
  const url = `${baseUrl}/api/correlation/refresh/organization/${encodeURIComponent(symbol)}/activity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const response = await fetch(url, { method: "POST" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const detail = typeof payload?.detail === "string"
      ? payload.detail
      : typeof payload?.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return {
    symbol,
    organizationId: payload.organizationId ?? null,
    lobbyingCount: payload.lobbyingCount ?? 0,
    contractCount: payload.contractCount ?? 0,
  };
}

async function refreshSymbolWithRetry(options, symbol) {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const result = await refreshSymbol(options.baseUrl, symbol, options.from, options.to);
      return { ...result, attempts: attempt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rateLimited = isRateLimitError(message);
      if (attempt > options.maxRetries) {
        throw new Error(message);
      }

      const delay = rateLimited
        ? options.cooldownMs * attempt
        : options.retryDelayMs * attempt;
      console.warn(
        `Retrying ${symbol} in ${delay}ms after attempt ${attempt} failed: ${message}`
      );
      await sleep(delay);
    }
  }
}

async function main() {
  loadDotEnv(DEV_VARS_PATH);
  const options = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in api/.dev.vars or the environment");
  }

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const allSymbols = await loadCandidateSymbols(sb);
  let checkpoint = null;
  if (options.resume) {
    checkpoint = readCheckpoint(options.checkpointPath);
    if (checkpoint?.totalSymbols !== allSymbols.length) {
      checkpoint = null;
    }
    if (checkpoint?.nextOffset != null && Number.isFinite(checkpoint.nextOffset)) {
      options.offset = checkpoint.nextOffset;
    }
  }
  const retrySymbols = checkpoint?.failures
    ?.map((entry) => (typeof entry?.symbol === "string" ? entry.symbol : null))
    .filter((value) => value && allSymbols.includes(value)) ?? [];
  const sliceSymbols = allSymbols.slice(
    options.offset,
    options.limit == null ? undefined : options.offset + options.limit
  );
  const limitedRetrySymbols = options.limit == null
    ? retrySymbols
    : retrySymbols.slice(0, options.limit);
  const selectedSymbols = options.resume && retrySymbols.length
    ? limitedRetrySymbols
    : sliceSymbols;
  const processingRetrySymbols = options.resume && retrySymbols.length > 0;

  console.log(JSON.stringify({
    totalSymbols: allSymbols.length,
    selectedSymbols: selectedSymbols.length,
    offset: options.offset,
    retryingFailures: processingRetrySymbols,
    from: options.from,
    to: options.to,
    concurrency: options.concurrency,
    baseUrl: options.baseUrl,
    maxRetries: options.maxRetries,
    retryDelayMs: options.retryDelayMs,
    cooldownMs: options.cooldownMs,
    checkpointPath: options.checkpointPath,
    resume: options.resume,
  }, null, 2));

  const results = [];
  const failures = [];

  for (let i = 0; i < selectedSymbols.length; i += options.concurrency) {
    const batch = selectedSymbols.slice(i, i + options.concurrency);
    const settled = await Promise.allSettled(
      batch.map((symbol) => refreshSymbolWithRetry(options, symbol))
    );

    settled.forEach((entry, index) => {
      const symbol = batch[index];
      if (entry.status === "fulfilled") {
        results.push(entry.value);
        console.log(
          `Refreshed ${symbol}: ${entry.value.lobbyingCount} lobbying, ${entry.value.contractCount} contracts (${entry.value.attempts} attempt${entry.value.attempts === 1 ? "" : "s"})`
        );
      } else {
        const error = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
        failures.push({ symbol, error });
        console.error(`Failed ${symbol}: ${error}`);
      }
    });

    const nextOffset = processingRetrySymbols
      ? options.offset
      : options.offset + i + batch.length;

    writeCheckpoint(options.checkpointPath, {
      from: options.from,
      to: options.to,
      totalSymbols: allSymbols.length,
      processedSymbols: processingRetrySymbols ? options.offset : nextOffset,
      nextOffset,
      retriedFailures: processingRetrySymbols,
      refreshedSymbols: results.length,
      failedSymbols: failures.length,
      failures,
      updatedAt: new Date().toISOString(),
    });
  }

  console.log("\nActivity refresh summary");
  console.log(JSON.stringify({
    totalSymbols: allSymbols.length,
    attemptedSymbols: selectedSymbols.length,
    refreshedSymbols: results.length,
    failedSymbols: failures.length,
    totalLobbyingRows: results.reduce((sum, item) => sum + item.lobbyingCount, 0),
    totalContractRows: results.reduce((sum, item) => sum + item.contractCount, 0),
    failures,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
