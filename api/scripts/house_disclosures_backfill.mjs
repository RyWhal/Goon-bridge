import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadDotEnv, runHouseDisclosureIngest } from "./house_disclosures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_DIR = path.resolve(__dirname, "..");
const DEV_VARS_PATH = path.join(API_DIR, ".dev.vars");

function parseArgs(argv) {
  const options = {
    from: null,
    to: null,
    batchSize: 25,
    startOffset: 0,
    maxBatches: null,
    force: false,
    refreshCases: false,
    refreshBaseUrl: "http://localhost:8787",
    stopOnError: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--from") options.from = argv[++i] ?? null;
    else if (arg === "--to") options.to = argv[++i] ?? null;
    else if (arg === "--batch-size") options.batchSize = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--start-offset") options.startOffset = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--max-batches") options.maxBatches = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--refresh-cases") options.refreshCases = true;
    else if (arg === "--refresh-base-url") options.refreshBaseUrl = argv[++i] ?? options.refreshBaseUrl;
    else if (arg === "--force") options.force = true;
    else if (arg === "--stop-on-error") options.stopOnError = true;
  }

  if (!options.from || !options.to) {
    throw new Error(
      "Usage: npm run disclosures:house:batch -- --from YYYY-MM-DD --to YYYY-MM-DD [--batch-size N] [--start-offset N] [--max-batches N] [--refresh-cases] [--refresh-base-url URL] [--force] [--stop-on-error]"
    );
  }
  if (!Number.isFinite(options.batchSize) || options.batchSize <= 0) options.batchSize = 25;
  if (!Number.isFinite(options.startOffset) || options.startOffset < 0) options.startOffset = 0;
  if (options.maxBatches != null && (!Number.isFinite(options.maxBatches) || options.maxBatches <= 0)) {
    options.maxBatches = null;
  }

  return options;
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
  const summaries = [];
  const failures = [];
  let offset = options.startOffset;
  let batchNumber = 0;

  while (options.maxBatches == null || batchNumber < options.maxBatches) {
    batchNumber += 1;
    console.log(`\nBatch ${batchNumber} starting at offset ${offset}`);

    try {
      const summary = await runHouseDisclosureIngest({
        sb,
        from: options.from,
        to: options.to,
        limit: options.batchSize,
        offset,
        force: options.force,
        refreshCases: options.refreshCases,
        refreshBaseUrl: options.refreshBaseUrl,
        log: console,
      });

      summaries.push(summary);
      console.log(JSON.stringify(summary, null, 2));

      if (summary.filingsDiscovered === 0) break;
      offset = summary.nextOffset;
      if (summary.filingsDiscovered < options.batchSize) break;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push({ batchNumber, offset, error: detail });
      console.error(`Batch ${batchNumber} failed at offset ${offset}: ${detail}`);
      if (options.stopOnError) break;
      offset += options.batchSize;
    }
  }

  const aggregate = {
    batchesCompleted: summaries.length,
    batchesFailed: failures.length,
    filingsProcessed: summaries.reduce((sum, item) => sum + item.filingsProcessed, 0),
    filingsSkipped: summaries.reduce((sum, item) => sum + item.filingsSkipped, 0),
    parsedRows: summaries.reduce((sum, item) => sum + item.parsedRows, 0),
    normalizedTrades: summaries.reduce((sum, item) => sum + item.normalizedTrades, 0),
    affectedMembers: [...new Set(summaries.flatMap((item) => item.affectedMembers))],
    refreshedMembers: [...new Set(summaries.flatMap((item) => item.refreshedMembers))],
    nextOffset: offset,
    failures,
  };

  console.log("\nBackfill summary");
  console.log(JSON.stringify(aggregate, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
