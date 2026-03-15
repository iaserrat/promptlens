import { openDb, insertAnalysis, hashExists } from "./db";
import { readFileSync } from "fs";
import { computePromptHash, analyzePrompt, MIN_LENGTH } from "./analyze";

function detectImages(transcriptPath: string | undefined): {
  hasImages: boolean;
  imageCount: number;
} {
  if (!transcriptPath) return { hasImages: false, imageCount: 0 };
  try {
    const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
    // Walk backwards to find the last user message (skip tool_result entries)
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (
        entry.type === "user" ||
        entry.type === "human" ||
        entry.role === "user"
      ) {
        const content = entry.message?.content ?? entry.content;
        if (Array.isArray(content)) {
          // Skip tool_result-only messages
          const hasNonToolContent = content.some(
            (block: any) => block.type !== "tool_result",
          );
          if (!hasNonToolContent) continue;

          const images = content.filter(
            (block: any) =>
              block.type === "image" || block.type === "image_url",
          );
          return { hasImages: images.length > 0, imageCount: images.length };
        }
        return { hasImages: false, imageCount: 0 };
      }
    }
  } catch {
    // transcript unreadable or not yet written — not critical
  }
  return { hasImages: false, imageCount: 0 };
}

async function main() {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) process.exit(0);

  const input = JSON.parse(raw);
  const prompt: string = input.prompt ?? "";
  const sessionId: string = input.session_id ?? "unknown";
  const cwd: string = input.cwd ?? "";
  const transcriptPath: string | undefined = input.transcript_path;

  const trimmed = prompt.trim();
  const { hasImages, imageCount } = detectImages(transcriptPath);

  if (trimmed.length < MIN_LENGTH && !hasImages) process.exit(0);

  const hash = computePromptHash(trimmed, hasImages ? imageCount : 0);

  const db = openDb();
  if (hashExists(db, hash)) {
    db.close();
    process.exit(0);
  }

  const result = await analyzePrompt(trimmed, { hasImages, imageCount });
  if (!result) {
    db.close();
    process.exit(0);
  }

  insertAnalysis(db, {
    session_id: sessionId,
    prompt_hash: hash,
    prompt_length: trimmed.length,
    category: result.category,
    complexity: result.complexity,
    quality_score: result.quality_score,
    insights: result.insights,
    model_used: result.model_used,
    latency_ms: result.latency_ms,
    token_count: result.token_count,
    cwd: cwd || null,
    has_images: hasImages ? 1 : 0,
    image_count: imageCount,
  });

  db.close();
}

main().catch((err) => {
  console.error("promptlens hook error:", err);
  process.exit(0);
});
