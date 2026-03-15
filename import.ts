import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { openDb, insertAnalysis, hashExists } from "./db";
import {
  computePromptHash,
  analyzePrompt,
  fetchModelPricing,
  computeCost,
  MIN_LENGTH,
  type ModelPricing,
} from "./analyze";
import { createInterface } from "readline";

const HISTORY_PATH = join(
  process.env.HOME || "~",
  ".claude",
  "history.jsonl",
);
// Fallback estimate if we can't fetch real pricing
const FALLBACK_COST_PER_PROMPT = 0.0002;
// Estimated avg tokens per prompt for cost projection
const EST_PROMPT_TOKENS = 250;
const EST_COMPLETION_TOKENS = 60;

interface HistoryEntry {
  display: string;
  timestamp?: string;
  project?: string;
  sessionId?: string;
}

function showHelp() {
  console.log(`Usage: promptlens import [options]

Import and analyze prompts from Claude Code history (~/.claude/history.jsonl).

Options:
  --dry-run          Show counts only, don't process anything
  --concurrency=N    Number of parallel requests (default: 5)
  --project=PATH     Only import prompts from a specific project directory
  --help, -h         Show this help message`);
  process.exit(0);
}

function parseArgs(argv: string[]) {
  let dryRun = false;
  let concurrency = 5;
  let projectFilter: string | null = null;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      showHelp();
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parseInt(arg.split("=")[1], 10) || 5;
    } else if (arg.startsWith("--project=")) {
      projectFilter = arg.split("=").slice(1).join("=");
    }
  }

  return { dryRun, concurrency, projectFilter };
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

interface PromptToAnalyze {
  text: string;
  hash: string;
  sessionId: string;
  project: string | null;
  timestamp: string | null;
}

async function main() {
  const { dryRun, concurrency, projectFilter } = parseArgs(
    process.argv.slice(2),
  );

  // Check API key
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      "Error: OPENROUTER_API_KEY is not set.\nSet it in your environment or in .env",
    );
    process.exit(1);
  }

  // Read history file
  if (!existsSync(HISTORY_PATH)) {
    console.log(
      `No history file found at ${HISTORY_PATH}\nNothing to import.`,
    );
    process.exit(0);
  }

  const raw = readFileSync(HISTORY_PATH, "utf-8");
  const lines = raw.trim().split("\n");

  // Parse entries
  const entries: HistoryEntry[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }

  // Filter and deduplicate
  const db = openDb();
  const prompts: PromptToAnalyze[] = [];
  let alreadyAnalyzed = 0;
  let filtered = 0;

  for (const entry of entries) {
    const text = (entry.display ?? "").trim();

    // Skip short prompts
    if (text.length < MIN_LENGTH) {
      filtered++;
      continue;
    }

    // Skip slash commands
    if (text.startsWith("/")) {
      filtered++;
      continue;
    }

    // Project filter
    if (projectFilter && entry.project !== projectFilter) {
      filtered++;
      continue;
    }

    const hash = computePromptHash(text);

    if (hashExists(db, hash)) {
      alreadyAnalyzed++;
      continue;
    }

    prompts.push({
      text,
      hash,
      sessionId: entry.sessionId ?? "import",
      project: entry.project ?? null,
      timestamp: entry.timestamp
        ? new Date(
            typeof entry.timestamp === "number" || /^\d+$/.test(entry.timestamp)
              ? Number(entry.timestamp)
              : entry.timestamp,
          ).toISOString()
        : null,
    });
  }

  // Deduplicate by hash within the batch
  const seen = new Set<string>();
  const unique = prompts.filter((p) => {
    if (seen.has(p.hash)) return false;
    seen.add(p.hash);
    return true;
  });

  console.log(
    `Found ${entries.length} prompts in history, ${alreadyAnalyzed} already analyzed, ${unique.length} new to import`,
  );
  if (malformed > 0) {
    console.log(`  (${malformed} malformed lines skipped)`);
  }
  if (filtered > 0) {
    console.log(`  (${filtered} filtered out: too short, slash commands, or project mismatch)`);
  }

  if (unique.length === 0) {
    console.log("Nothing to import.");
    db.close();
    process.exit(0);
  }

  // Fetch real pricing from OpenRouter
  console.log("\nFetching model pricing from OpenRouter...");
  const pricing = await fetchModelPricing();

  function estimateCost(count: number): string {
    if (pricing) {
      const perPrompt = computeCost(pricing, EST_PROMPT_TOKENS, EST_COMPLETION_TOKENS);
      return `~$${(count * perPrompt).toFixed(4)}`;
    }
    return `~$${(count * FALLBACK_COST_PER_PROMPT).toFixed(4)}`;
  }

  if (dryRun) {
    const est = estimateCost(unique.length);
    const source = pricing ? "live pricing" : "fallback estimate";
    console.log(`Estimated cost if imported: ${est} (${source})`);
    db.close();
    process.exit(0);
  }

  // Cost warning
  const est = estimateCost(unique.length);
  const source = pricing ? "live pricing" : "estimate";
  console.log(`Estimated cost: ${est} (${source}, ${unique.length} prompts)`);

  const proceed = await confirm(`\nProceed with importing ${unique.length} prompts? [y/N] `);
  if (!proceed) {
    console.log("Aborted.");
    db.close();
    process.exit(0);
  }

  // Process with concurrency control
  let completed = 0;
  let errors = 0;
  let totalCost = 0;
  let idx = 0;

  const printProgress = () => {
    const errStr = errors > 0 ? ` (${errors} errors)` : "";
    const costStr = pricing && totalCost > 0 ? ` $${totalCost.toFixed(4)}` : "";
    process.stdout.write(
      `\r[${completed}/${unique.length}] Analyzing...${errStr}${costStr}`,
    );
  };

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    const costStr = pricing && totalCost > 0 ? ` Total cost: $${totalCost.toFixed(4)}` : "";
    console.log(
      `\n\nInterrupted. ${completed}/${unique.length} prompts analyzed, ${errors} errors.${costStr}`,
    );
    db.close();
    process.exit(0);
  });

  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= unique.length) break;

      const prompt = unique[i];
      try {
        const result = await analyzePrompt(prompt.text);
        if (result) {
          // Track real cost if pricing is available
          if (pricing && result.prompt_tokens && result.completion_tokens) {
            totalCost += computeCost(pricing, result.prompt_tokens, result.completion_tokens);
          }

          insertAnalysis(db, {
            session_id: prompt.sessionId,
            prompt_hash: prompt.hash,
            prompt_length: prompt.text.length,
            category: result.category,
            complexity: result.complexity,
            quality_score: result.quality_score,
            insights: result.insights,
            model_used: result.model_used,
            latency_ms: result.latency_ms,
            token_count: result.token_count,
            cwd: prompt.project,
            has_images: 0,
            image_count: 0,
            ...(prompt.timestamp ? { created_at: prompt.timestamp } : {}),
          });
        }
      } catch {
        errors++;
      }

      completed++;
      printProgress();

      // Rate limit: 100ms delay between requests per worker
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  printProgress();
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, () => worker());
  await Promise.all(workers);

  const costStr = pricing && totalCost > 0 ? ` Total cost: $${totalCost.toFixed(4)}` : "";
  console.log(
    `\n\nDone! ${completed - errors} prompts analyzed successfully.${errors > 0 ? ` ${errors} errors.` : ""}${costStr}`,
  );

  db.close();
}

main().catch((err) => {
  console.error("promptlens import error:", err);
  process.exit(1);
});
