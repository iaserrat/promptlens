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
