const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

export const MIN_LENGTH = parseInt(
  process.env.PROMPTLENS_MIN_LENGTH || "50",
  10,
);

export function computePromptHash(text: string, imageCount = 0): string {
  return new Bun.CryptoHasher("sha256")
    .update(text + (imageCount > 0 ? `::images=${imageCount}` : ""))
    .digest("hex")
    .slice(0, 16);
}

export interface ModelPricing {
  prompt: number; // cost per token (input)
  completion: number; // cost per token (output)
}

export async function fetchModelPricing(): Promise<ModelPricing | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) return null;
    const data = await res.json();
    const model = data.data?.find(
      (m: any) => m.id === OPENROUTER_MODEL,
    );
    if (!model?.pricing) return null;
    return {
      prompt: parseFloat(model.pricing.prompt),
      completion: parseFloat(model.pricing.completion),
    };
  } catch {
    return null;
  }
}

export function computeCost(
  pricing: ModelPricing,
  promptTokens: number,
  completionTokens: number,
): number {
  return pricing.prompt * promptTokens + pricing.completion * completionTokens;
}

export interface AnalysisResult {
  category: string | null;
  complexity: string | null;
  quality_score: number | null;
  insights: string | null;
  latency_ms: number;
  token_count: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  model_used: string;
}

export interface LLMRecommendation {
  title: string;
  body: string;
  severity: "good" | "info" | "warn";
}

export async function generateLLMRecommendations(
  context: Record<string, unknown>,
): Promise<LLMRecommendation[]> {
  if (!OPENROUTER_API_KEY) return [];

  const systemPrompt = `You are a prompting coach analyzing a user's history of prompts sent to an AI coding assistant. You receive aggregate statistics about their prompting patterns.

Return a JSON array of 2-4 actionable recommendations. Each object has:
- "title": short headline (max 60 chars)
- "body": specific, actionable advice (1-2 sentences, max 150 chars)
- "severity": "warn" for problems, "info" for suggestions, "good" for praise

Focus on patterns you can infer from the data:
- Recurring themes in low-scoring prompt insights (these are terse quality notes like "vague request", "lacks context", etc.)
- What makes their high-scoring prompts different from low-scoring ones
- Category-specific advice based on where they struggle
- Concrete behavioral changes, not generic advice

Do NOT repeat obvious stats. Be specific and prescriptive.
No markdown, no code fences, just the JSON array.`;

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
        { role: "user", content: JSON.stringify(context) },
      ],
      temperature: 0.3,
      max_tokens: 600,
    }),
  });

  if (!res.ok) return [];

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  const cleaned = content
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r: any) => r.title && r.body && r.severity
    ) as LLMRecommendation[];
  } catch {
    return [];
  }
}

export async function analyzePrompt(
  promptText: string,
  options?: { hasImages?: boolean; imageCount?: number },
): Promise<AnalysisResult | null> {
  const sliced = promptText.slice(0, 2000);
  const hasImages = options?.hasImages ?? false;
  const imageCount = options?.imageCount ?? 0;

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
    return null;
  }

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  const tokenCount: number | undefined = data.usage?.total_tokens;
  const promptTokens: number | undefined = data.usage?.prompt_tokens;
  const completionTokens: number | undefined = data.usage?.completion_tokens;

  const cleaned = content
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let analysis: Record<string, unknown>;
  try {
    analysis = JSON.parse(cleaned);
  } catch {
    return null;
  }

  return {
    category: (analysis.category as string) ?? null,
    complexity: (analysis.complexity as string) ?? null,
    quality_score: (analysis.quality_score as number) ?? null,
    insights: (analysis.insights as string) ?? null,
    latency_ms: latencyMs,
    token_count: tokenCount ?? null,
    prompt_tokens: promptTokens ?? null,
    completion_tokens: completionTokens ?? null,
    model_used: OPENROUTER_MODEL,
  };
}
