import { openDb, insertAnalysis, hashExists } from "./db";
import { readFileSync } from "fs";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";
const MIN_LENGTH = parseInt(process.env.PROMPTLENS_MIN_LENGTH || "50", 10);

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

  const hash = new Bun.CryptoHasher("sha256")
    .update(trimmed + (hasImages ? `::images=${imageCount}` : ""))
    .digest("hex")
    .slice(0, 16);

  const db = openDb();
  if (hashExists(db, hash)) {
    db.close();
    process.exit(0);
  }

  const sliced = trimmed.slice(0, 2000);
  const imageNote = hasImages
    ? `\nIMPORTANT: The user also attached ${imageCount} image(s) (screenshots, diagrams, etc.) to this prompt. Factor this into your analysis — images count as additional context even though you cannot see them. Do NOT penalize the prompt for lacking context if images are attached.`
    : "";
  const systemPrompt = `You analyze user prompts sent to an AI coding assistant. Return ONLY valid JSON with these fields:
- "category": one of "feature", "debug", "refactor", "explain", "config", "test", "docs", "other"
- "complexity": one of "low", "medium", "high"
- "quality_score": integer 1-10 (10 = excellent prompt)
- "insights": max 8 words on prompt quality (terse, no fluff)
${imageNote}
No markdown, no code fences, just the JSON object.`;

  const start = performance.now();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: sliced },
      ],
      temperature: 0,
      max_tokens: 150,
    }),
  });

  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    console.error(`OpenRouter error: ${res.status} ${await res.text()}`);
    process.exit(0);
  }

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  const tokenCount: number | undefined = data.usage?.total_tokens;

  // Strip markdown fences if present
  const cleaned = content
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(cleaned);
  } catch {
    db.close();
    process.exit(0);
  }

  insertAnalysis(db, {
    session_id: sessionId,
    prompt_hash: hash,
    prompt_length: trimmed.length,
    category: analysis.category ?? null,
    complexity: analysis.complexity ?? null,
    quality_score: analysis.quality_score ?? null,
    insights: analysis.insights ?? null,
    model_used: OPENROUTER_MODEL,
    latency_ms: latencyMs,
    token_count: tokenCount ?? null,
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
