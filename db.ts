import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "promptlens.db");

export function openDb(): Database {
  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=3000");
  db.run(`
    CREATE TABLE IF NOT EXISTS analyses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      prompt_hash   TEXT NOT NULL,
      prompt_length INTEGER NOT NULL,
      category      TEXT,
      complexity    TEXT,
      quality_score INTEGER,
      insights      TEXT,
      model_used    TEXT,
      latency_ms    INTEGER,
      token_count   INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      cwd           TEXT,
      has_images    INTEGER NOT NULL DEFAULT 0,
      image_count   INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at)",
  );
  // Migrate: add columns if missing (existing DBs)
  try {
    db.run(
      "ALTER TABLE analyses ADD COLUMN has_images INTEGER NOT NULL DEFAULT 0",
    );
  } catch {}
  try {
    db.run(
      "ALTER TABLE analyses ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0",
    );
  } catch {}
  db.run(`
    CREATE TABLE IF NOT EXISTS recommendation_cache (
      id          INTEGER PRIMARY KEY CHECK (id = 1),
      data_hash   TEXT NOT NULL,
      recs_json   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

export interface Analysis {
  id: number;
  session_id: string;
  prompt_hash: string;
  prompt_length: number;
  category: string | null;
  complexity: string | null;
  quality_score: number | null;
  insights: string | null;
  model_used: string | null;
  latency_ms: number | null;
  token_count: number | null;
  created_at: string;
  cwd: string | null;
  has_images: number;
  image_count: number;
}

export function insertAnalysis(
  db: Database,
  data: Omit<Analysis, "id" | "created_at"> & { created_at?: string },
) {
  if (data.created_at) {
    const stmt = db.prepare(`
      INSERT INTO analyses (session_id, prompt_hash, prompt_length, category, complexity, quality_score, insights, model_used, latency_ms, token_count, cwd, has_images, image_count, created_at)
      VALUES ($session_id, $prompt_hash, $prompt_length, $category, $complexity, $quality_score, $insights, $model_used, $latency_ms, $token_count, $cwd, $has_images, $image_count, $created_at)
    `);
    stmt.run({
      $session_id: data.session_id,
      $prompt_hash: data.prompt_hash,
      $prompt_length: data.prompt_length,
      $category: data.category,
      $complexity: data.complexity,
      $quality_score: data.quality_score,
      $insights: data.insights,
      $model_used: data.model_used,
      $latency_ms: data.latency_ms,
      $token_count: data.token_count,
      $cwd: data.cwd,
      $has_images: data.has_images,
      $image_count: data.image_count,
      $created_at: data.created_at,
    });
  } else {
    const stmt = db.prepare(`
      INSERT INTO analyses (session_id, prompt_hash, prompt_length, category, complexity, quality_score, insights, model_used, latency_ms, token_count, cwd, has_images, image_count)
      VALUES ($session_id, $prompt_hash, $prompt_length, $category, $complexity, $quality_score, $insights, $model_used, $latency_ms, $token_count, $cwd, $has_images, $image_count)
    `);
    stmt.run({
      $session_id: data.session_id,
      $prompt_hash: data.prompt_hash,
      $prompt_length: data.prompt_length,
      $category: data.category,
      $complexity: data.complexity,
      $quality_score: data.quality_score,
      $insights: data.insights,
      $model_used: data.model_used,
      $latency_ms: data.latency_ms,
      $token_count: data.token_count,
      $cwd: data.cwd,
      $has_images: data.has_images,
      $image_count: data.image_count,
    });
  }
}

export function hashExists(db: Database, hash: string): boolean {
  const row = db
    .query("SELECT 1 FROM analyses WHERE prompt_hash = $hash LIMIT 1")
    .get({ $hash: hash }) as { 1: number } | null;
  return row !== null;
}

export function getRecent(db: Database, limit = 15): Analysis[] {
  return db
    .query("SELECT * FROM analyses ORDER BY created_at DESC LIMIT $limit")
    .all({ $limit: limit }) as Analysis[];
}

export interface Stats {
  total: number;
  avg_score: number;
  top_category: string | null;
  categories: { category: string; count: number }[];
}

export function deleteAnalysis(db: Database, id: number): void {
  db.run("DELETE FROM analyses WHERE id = $id", { $id: id });
}

export function deleteAllAnalyses(db: Database): void {
  db.run("DELETE FROM analyses");
}

export interface ProjectStat {
  project: string;
  count: number;
  avg_score: number;
  sessions: number;
}

export function getProjectStats(db: Database): ProjectStat[] {
  return db
    .query(
      `
      SELECT
        COALESCE(cwd, '(unknown)') as project,
        COUNT(*) as count,
        ROUND(COALESCE(AVG(quality_score), 0), 1) as avg_score,
        COUNT(DISTINCT session_id) as sessions
      FROM analyses
      GROUP BY cwd
      ORDER BY count DESC
    `,
    )
    .all() as ProjectStat[];
}

export function getSessionCount(db: Database): number {
  const row = db
    .query("SELECT COUNT(DISTINCT session_id) as cnt FROM analyses")
    .get() as { cnt: number };
  return row.cnt;
}

export interface DailyTrend {
  day: string;
  avg_score: number;
  count: number;
}

export function getDailyTrends(db: Database): DailyTrend[] {
  return db
    .query(
      `
      SELECT
        date(created_at) as day,
        ROUND(COALESCE(AVG(quality_score), 0), 1) as avg_score,
        COUNT(*) as count
      FROM analyses
      GROUP BY date(created_at)
      ORDER BY day ASC
    `,
    )
    .all() as DailyTrend[];
}

export interface CategoryScore {
  category: string;
  avg_score: number;
  count: number;
}

export function getCategoryScores(db: Database): CategoryScore[] {
  return db.query(`
    SELECT category, ROUND(AVG(quality_score), 1) as avg_score, COUNT(*) as count
    FROM analyses
    WHERE category IS NOT NULL AND quality_score IS NOT NULL
    GROUP BY category
    ORDER BY avg_score ASC
  `).all() as CategoryScore[];
}

export interface WeeklyComparison {
  thisWeek: { count: number; avgScore: number; avgLength: number };
  lastWeek: { count: number; avgScore: number; avgLength: number };
}

export function getWeeklyComparison(db: Database): WeeklyComparison {
  const row = db.query(`
    SELECT
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as tw_count,
      AVG(CASE WHEN created_at >= datetime('now', '-7 days') THEN quality_score END) as tw_avg,
      AVG(CASE WHEN created_at >= datetime('now', '-7 days') THEN prompt_length END) as tw_len,
      SUM(CASE WHEN created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days') THEN 1 ELSE 0 END) as lw_count,
      AVG(CASE WHEN created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days') THEN quality_score END) as lw_avg,
      AVG(CASE WHEN created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days') THEN prompt_length END) as lw_len
    FROM analyses
  `).get() as Record<string, number | null>;
  return {
    thisWeek: {
      count: row.tw_count ?? 0,
      avgScore: Math.round((row.tw_avg ?? 0) * 10) / 10,
      avgLength: Math.round(row.tw_len ?? 0),
    },
    lastWeek: {
      count: row.lw_count ?? 0,
      avgScore: Math.round((row.lw_avg ?? 0) * 10) / 10,
      avgLength: Math.round(row.lw_len ?? 0),
    },
  };
}

export interface LengthBucket {
  label: string;
  count: number;
  avg_score: number;
}

export function getLengthDistribution(db: Database): LengthBucket[] {
  return db.query(`
    SELECT
      CASE
        WHEN prompt_length < 50 THEN '<50'
        WHEN prompt_length < 100 THEN '50-99'
        WHEN prompt_length < 200 THEN '100-199'
        WHEN prompt_length < 500 THEN '200-499'
        ELSE '500+'
      END as label,
      COUNT(*) as count,
      ROUND(AVG(quality_score), 1) as avg_score
    FROM analyses
    WHERE quality_score IS NOT NULL
    GROUP BY label
    ORDER BY MIN(prompt_length)
  `).all() as LengthBucket[];
}

export interface Recommendation {
  icon: string;
  title: string;
  body: string;
  severity: "good" | "info" | "warn";
}

export function getRecommendations(db: Database): Recommendation[] {
  const recs: Recommendation[] = [];
  const total = (
    db.query("SELECT COUNT(*) as n FROM analyses").get() as { n: number }
  ).n;
  if (total < 5) return [{ icon: "i", title: "Not enough data", body: "Submit at least 5 prompts to get recommendations.", severity: "info" }];

  // 1. Weakest category
  const catScores = db.query(`
    SELECT category, ROUND(AVG(quality_score), 1) as avg, COUNT(*) as n
    FROM analyses WHERE category IS NOT NULL AND quality_score IS NOT NULL
    GROUP BY category HAVING n >= 3 ORDER BY avg ASC
  `).all() as { category: string; avg: number; n: number }[];
  if (catScores.length > 0 && catScores[0].avg < 6) {
    const c = catScores[0];
    const tips: Record<string, string> = {
      debug: "Include error messages, stack traces, and steps to reproduce.",
      feature: "Describe the desired behavior, edge cases, and constraints.",
      refactor: "Specify what to improve and why — performance, readability, etc.",
      explain: "Point to specific code and say what's confusing.",
      config: "State the tool, version, and desired outcome.",
      test: "Specify what to test, edge cases, and expected behavior.",
      docs: "Clarify audience, format, and what to document.",
    };
    const tip = tips[c.category] || "Add more context and be specific about what you need.";
    recs.push({
      icon: "!",
      title: `Weak area: ${c.category} prompts (avg ${c.avg}/10)`,
      body: tip,
      severity: "warn",
    });
  }

  // 2. Short prompts correlate with low scores
  const shortStats = db.query(`
    SELECT
      AVG(CASE WHEN prompt_length < 100 THEN quality_score END) as short_avg,
      AVG(CASE WHEN prompt_length >= 100 THEN quality_score END) as long_avg,
      SUM(CASE WHEN prompt_length < 100 THEN 1 ELSE 0 END) as short_count,
      COUNT(*) as total
    FROM analyses WHERE quality_score IS NOT NULL
  `).get() as { short_avg: number | null; long_avg: number | null; short_count: number; total: number };
  if (shortStats.short_avg !== null && shortStats.long_avg !== null && shortStats.short_count >= 3) {
    const gap = shortStats.long_avg - shortStats.short_avg;
    const pct = Math.round((shortStats.short_count / shortStats.total) * 100);
    if (gap > 1) {
      recs.push({
        icon: "!",
        title: `Short prompts score ${gap.toFixed(1)} points lower`,
        body: `${pct}% of your prompts are under 100 chars. Adding context, examples, or constraints can significantly improve results.`,
        severity: "warn",
      });
    }
  }

  // 3. Score trend (last 7 days vs prior 7 days)
  const trendData = db.query(`
    SELECT
      AVG(CASE WHEN created_at >= datetime('now', '-7 days') THEN quality_score END) as recent,
      AVG(CASE WHEN created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days') THEN quality_score END) as prior
    FROM analyses WHERE quality_score IS NOT NULL
  `).get() as { recent: number | null; prior: number | null };
  if (trendData.recent !== null && trendData.prior !== null) {
    const delta = trendData.recent - trendData.prior;
    if (delta >= 1) {
      recs.push({
        icon: "+",
        title: `Quality trending up (+${delta.toFixed(1)} this week)`,
        body: "Your prompts are getting better. Keep providing context and being specific.",
        severity: "good",
      });
    } else if (delta <= -1) {
      recs.push({
        icon: "!",
        title: `Quality trending down (${delta.toFixed(1)} this week)`,
        body: "Review recent low-scoring prompts. Are you rushing or being vague?",
        severity: "warn",
      });
    }
  }

  // 4. Complexity balance
  const complexityCounts = db.query(`
    SELECT complexity, COUNT(*) as n FROM analyses
    WHERE complexity IS NOT NULL GROUP BY complexity
  `).all() as { complexity: string; n: number }[];
  const cMap = Object.fromEntries(complexityCounts.map((c) => [c.complexity, c.n]));
  const lowPct = ((cMap.low ?? 0) / total) * 100;
  if (lowPct > 70) {
    recs.push({
      icon: "i",
      title: `${Math.round(lowPct)}% of prompts are low complexity`,
      body: "You might be under-utilizing the assistant. Try delegating harder tasks like architecture, debugging, or multi-step work.",
      severity: "info",
    });
  }

  // 5. High performers — what's working
  const bestCat = catScores.length > 0 ? catScores[catScores.length - 1] : null;
  if (bestCat && bestCat.avg >= 6) {
    recs.push({
      icon: "+",
      title: `Strong area: ${bestCat.category} prompts (avg ${bestCat.avg}/10)`,
      body: "Apply the same level of detail to your other prompt categories.",
      severity: "good",
    });
  }

  // 6. Consistency (high variance)
  const variance = db.query(`
    SELECT AVG((quality_score - sub.mean) * (quality_score - sub.mean)) as var
    FROM analyses, (SELECT AVG(quality_score) as mean FROM analyses WHERE quality_score IS NOT NULL) sub
    WHERE quality_score IS NOT NULL
  `).get() as { var: number | null };
  if (variance.var !== null && Math.sqrt(variance.var) > 2) {
    recs.push({
      icon: "i",
      title: "Inconsistent prompt quality",
      body: "Your scores vary widely. Try a consistent structure: state the goal, provide context, specify constraints.",
      severity: "warn",
    });
  }

  if (recs.length === 0) {
    recs.push({
      icon: "+",
      title: "Looking good!",
      body: "Your prompting is solid across the board. Keep it up.",
      severity: "good",
    });
  }

  return recs;
}

// ── LLM Recommendation Cache ─────────────────────────────────────────

export function getDataHash(db: Database): string {
  const row = db.query(
    "SELECT COUNT(*) as n, COALESCE(MAX(id), 0) as maxId FROM analyses"
  ).get() as { n: number; maxId: number };
  return `${row.n}:${row.maxId}`;
}

export interface CachedRecs {
  recs: Recommendation[];
  dataHash: string;
}

export function getCachedLLMRecs(db: Database): CachedRecs | null {
  const row = db.query(
    "SELECT data_hash, recs_json FROM recommendation_cache WHERE id = 1"
  ).get() as { data_hash: string; recs_json: string } | null;
  if (!row) return null;
  try {
    return { recs: JSON.parse(row.recs_json), dataHash: row.data_hash };
  } catch {
    return null;
  }
}

export function saveLLMRecs(db: Database, dataHash: string, recs: Recommendation[]): void {
  db.run(
    `INSERT OR REPLACE INTO recommendation_cache (id, data_hash, recs_json, created_at)
     VALUES (1, $hash, $json, datetime('now'))`,
    { $hash: dataHash, $json: JSON.stringify(recs) }
  );
}

export interface LLMContext {
  total: number;
  avgScore: number;
  categoryBreakdown: { category: string; count: number; avgScore: number }[];
  complexityBreakdown: { complexity: string; count: number }[];
  avgPromptLength: number;
  lowScoringInsights: string[];
  highScoringInsights: string[];
  scoreDistribution: { score: number; count: number }[];
}

export function gatherLLMContext(db: Database): LLMContext {
  const totals = db.query(
    "SELECT COUNT(*) as n, COALESCE(AVG(quality_score), 0) as avg, COALESCE(AVG(prompt_length), 0) as avgLen FROM analyses"
  ).get() as { n: number; avg: number; avgLen: number };

  const cats = db.query(`
    SELECT category, COUNT(*) as count, ROUND(AVG(quality_score), 1) as avgScore
    FROM analyses WHERE category IS NOT NULL AND quality_score IS NOT NULL
    GROUP BY category ORDER BY count DESC
  `).all() as { category: string; count: number; avgScore: number }[];

  const complexity = db.query(`
    SELECT complexity, COUNT(*) as count FROM analyses
    WHERE complexity IS NOT NULL GROUP BY complexity
  `).all() as { complexity: string; count: number }[];

  const lowInsights = db.query(`
    SELECT insights FROM analyses
    WHERE quality_score IS NOT NULL AND quality_score <= 4 AND insights IS NOT NULL
    ORDER BY created_at DESC LIMIT 30
  `).all() as { insights: string }[];

  const highInsights = db.query(`
    SELECT insights FROM analyses
    WHERE quality_score IS NOT NULL AND quality_score >= 7 AND insights IS NOT NULL
    ORDER BY created_at DESC LIMIT 15
  `).all() as { insights: string }[];

  const scoreDist = db.query(`
    SELECT quality_score as score, COUNT(*) as count FROM analyses
    WHERE quality_score IS NOT NULL GROUP BY quality_score ORDER BY score
  `).all() as { score: number; count: number }[];

  return {
    total: totals.n,
    avgScore: Math.round(totals.avg * 10) / 10,
    categoryBreakdown: cats,
    complexityBreakdown: complexity,
    avgPromptLength: Math.round(totals.avgLen),
    lowScoringInsights: lowInsights.map((r) => r.insights),
    highScoringInsights: highInsights.map((r) => r.insights),
    scoreDistribution: scoreDist,
  };
}

export function getStats(db: Database): Stats {
  const totals = db
    .query(
      "SELECT COUNT(*) as total, COALESCE(AVG(quality_score), 0) as avg_score FROM analyses",
    )
    .get() as { total: number; avg_score: number };

  const categories = db
    .query(
      "SELECT category, COUNT(*) as count FROM analyses WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC",
    )
    .all() as { category: string; count: number }[];

  return {
    total: totals.total,
    avg_score: Math.round(totals.avg_score * 10) / 10,
    top_category: categories[0]?.category ?? null,
    categories,
  };
}
