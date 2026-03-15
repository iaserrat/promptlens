#!/usr/bin/env bun
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useStdout, useInput, useApp } from "ink";
import {
  openDb,
  getRecent,
  getStats,
  getProjectStats,
  getSessionCount,
  getDailyTrends,
  getRecommendations,
  getCategoryScores,
  getWeeklyComparison,
  getLengthDistribution,
  getDataHash,
  getCachedLLMRecs,
  saveLLMRecs,
  gatherLLMContext,
  deleteAnalysis,
  deleteAllAnalyses,
  type Analysis,
  type Stats,
  type ProjectStat,
  type DailyTrend,
  type Recommendation,
  type CategoryScore,
  type WeeklyComparison,
  type LengthBucket,
} from "./db";
import { generateLLMRecommendations } from "./analyze";
import type { Database } from "bun:sqlite";
import { LineGraph, Sparkline, BarChart } from "@pppp606/ink-chart";

const POLL_MS = 1500;

// Pre-load data synchronously so first render has content
const initDb = openDb();
const initAnalyses = getRecent(initDb, 200);
const initStats = getStats(initDb);
const initProjectStats = getProjectStats(initDb);
const initSessionCount = getSessionCount(initDb);
const initTrends = getDailyTrends(initDb);
const initRecs = getRecommendations(initDb);
const initCatScores = getCategoryScores(initDb);
const initWeekly = getWeeklyComparison(initDb);
const initLengthBuckets = getLengthDistribution(initDb);

// ── Helpers ──────────────────────────────────────────────────────────

function scoreColor(score: number | null): string {
  if (score === null) return "gray";
  if (score >= 8) return "green";
  if (score >= 5) return "yellow";
  return "red";
}

function complexityColor(c: string | null): string {
  if (c === "high") return "red";
  if (c === "medium") return "yellow";
  if (c === "low") return "green";
  return "gray";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    function onResize() {
      setSize({
        columns: stdout?.columns ?? 80,
        rows: stdout?.rows ?? 24,
      });
    }
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

// ── Keyboard input (guarded for non-TTY) ─────────────────────────────

type KeyAction =
  | { type: "quit" }
  | { type: "refresh" }
  | { type: "up" }
  | { type: "down" }
  | { type: "delete" }
  | { type: "deleteAll" }
  | { type: "help" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "filterProject" }
  | { type: "filterCategory" }
  | { type: "filterSession" }
  | { type: "toggleGrouping" }
  | { type: "switchTab" }
  | { type: "sidebarScrollUp" }
  | { type: "sidebarScrollDown" };

interface Filters {
  project: string | null;
  category: string | null;
  session: string | null;
}

const emptyFilters: Filters = { project: null, category: null, session: null };

function hasActiveFilters(f: Filters): boolean {
  return f.project !== null || f.category !== null || f.session !== null;
}

function applyFilters(all: Analysis[], filters: Filters): Analysis[] {
  let result = all;
  if (filters.project !== null) {
    result = result.filter((a) => (a.cwd ?? "(unknown)") === filters.project);
  }
  if (filters.category !== null) {
    result = result.filter((a) => a.category === filters.category);
  }
  if (filters.session !== null) {
    result = result.filter((a) => a.session_id === filters.session);
  }
  return result;
}

function cycleValue(current: string | null, options: string[]): string | null {
  if (options.length === 0) return null;
  if (current === null) return options[0];
  const idx = options.indexOf(current);
  if (idx === -1 || idx === options.length - 1) return null; // wrap to "all"
  return options[idx + 1];
}

function KeyboardHandler({ onAction }: { onAction: (a: KeyAction) => void }) {
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c"))
      onAction({ type: "quit" });
    else if (input === "r") onAction({ type: "refresh" });
    else if (key.upArrow || input === "k") onAction({ type: "up" });
    else if (key.downArrow || input === "j") onAction({ type: "down" });
    else if (input === "d") onAction({ type: "delete" });
    else if (input === "D") onAction({ type: "deleteAll" });
    else if (input === "p") onAction({ type: "filterProject" });
    else if (input === "c") onAction({ type: "filterCategory" });
    else if (input === "f") onAction({ type: "filterSession" });
    else if (input === "g") onAction({ type: "toggleGrouping" });
    else if (key.tab) onAction({ type: "switchTab" });
    else if (input === "[") onAction({ type: "sidebarScrollUp" });
    else if (input === "]") onAction({ type: "sidebarScrollDown" });
    else if (input === "?") onAction({ type: "help" });
    else if (key.return || input === "y") onAction({ type: "confirm" });
    else if (key.escape || input === "n") onAction({ type: "cancel" });
  });
  return null;
}

// ── Panel component ──────────────────────────────────────────────────

function Panel({
  title,
  children,
  width,
  titleColor = "cyan",
}: {
  title: string;
  children: React.ReactNode;
  width?: number | string;
  titleColor?: string;
}) {
  return (
    <Box flexDirection="column" width={width}>
      <Box
        borderStyle="round"
        borderColor="gray"
        flexDirection="column"
        paddingX={1}
      >
        <Box marginTop={-1} marginLeft={1}>
          <Text color={titleColor} bold>
            {" "}
            {title}{" "}
          </Text>
        </Box>
        {children}
      </Box>
    </Box>
  );
}

// ── Score sparkline ──────────────────────────────────────────────────

function ScoreBar({ score }: { score: number | null }) {
  if (score === null) return <Text dimColor>{"░".repeat(10)}</Text>;
  const filled = Math.round(score);
  const empty = 10 - filled;
  return (
    <Text>
      <Text color={scoreColor(score)}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
    </Text>
  );
}

// ── Header / Stats Bar ──────────────────────────────────────────────

function StatsBar({
  stats,
  sessionCount,
  width,
  activeTab,
}: {
  stats: Stats;
  sessionCount: number;
  width: number;
  activeTab: Tab;
}) {
  const tabs: { key: Tab; label: string }[] = [
    { key: "dashboard", label: "Dashboard" },
    { key: "trends", label: "Trends" },
    { key: "recommendations", label: "Tips" },
  ];

  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <Text bold color="cyan">◆ PROMPTLENS</Text>
        <Text dimColor>│</Text>
        {tabs.map((t, i) => (
          <React.Fragment key={t.key}>
            {i > 0 && <Text dimColor>│</Text>}
            <Text
              bold={activeTab === t.key}
              color={activeTab === t.key ? "cyan" : "gray"}
              underline={activeTab === t.key}
            >
              {t.label}
            </Text>
          </React.Fragment>
        ))}
        <Text dimColor>│</Text>
        <Text>
          <Text bold color="white">{stats.total}</Text>
          <Text dimColor> prompts</Text>
        </Text>
        <Text>
          <Text bold color="blue">{sessionCount}</Text>
          <Text dimColor> sessions</Text>
        </Text>
        <Text>
          <Text dimColor>avg </Text>
          <Text bold color={scoreColor(stats.avg_score)}>
            {stats.avg_score || "—"}
          </Text>
          <Text dimColor>/10</Text>
        </Text>
      </Box>
      <Text dimColor>? help</Text>
    </Box>
  );
}

// ── Recent Analyses Table ───────────────────────────────────────────

function RecentTable({
  analyses,
  height,
  width,
  selectedIdx,
}: {
  analyses: Analysis[];
  height: number;
  width: number;
  selectedIdx: number;
}) {
  const innerW = width - 4;
  const colTime = 10;
  const colCat = 10;
  const colComp = 14;
  const colScore = 6;
  const colBar = 12;
  const colInsights = Math.max(
    10,
    innerW - colTime - colCat - colComp - colScore - colBar - 5,
  );
  const visibleRows = Math.max(1, height - 4);

  if (analyses.length === 0) {
    return (
      <Panel title="Recent Analyses" width={width}>
        <Box height={visibleRows} alignItems="center" justifyContent="center">
          <Text dimColor>
            No analyses yet. Submit a prompt to Claude Code to get started.
          </Text>
        </Box>
      </Panel>
    );
  }

  // Scroll window: keep selected row visible
  const totalRows = analyses.length;
  let scrollOffset = 0;
  if (selectedIdx >= visibleRows) {
    scrollOffset = selectedIdx - visibleRows + 1;
  }
  const rows = analyses.slice(scrollOffset, scrollOffset + visibleRows);

  return (
    <Panel title={`Recent Analyses (${totalRows})`} width={width}>
      <Box>
        <Text bold dimColor>
          {"  "}
          {pad("TIME", colTime)}
          {pad("CATEGORY", colCat)}
          {pad("COMPLEXITY", colComp)}
          {pad("SCORE", colScore)}
          {pad("QUALITY", colBar)}
          {"INSIGHTS"}
        </Text>
      </Box>
      <Text dimColor>{"─".repeat(innerW)}</Text>
      {rows.map((a, i) => {
        const isSelected = scrollOffset + i === selectedIdx;
        return (
          <Box key={a.id}>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
            </Text>
            <Text dimColor={!isSelected}>
              {pad(timeAgo(a.created_at), colTime)}
            </Text>
            <Text color="magenta" dimColor={!isSelected}>
              {pad(a.category ?? "—", colCat)}
            </Text>
            <Text color={complexityColor(a.complexity)} dimColor={!isSelected}>
              {pad(a.complexity ?? "—", colComp)}
            </Text>
            <Text
              bold
              color={scoreColor(a.quality_score)}
              dimColor={!isSelected}
            >
              {pad(
                a.quality_score !== null ? String(a.quality_score) : "—",
                colScore,
              )}
            </Text>
            <Box width={colBar}>
              <ScoreBar score={a.quality_score} />
              <Text> </Text>
            </Box>
            {a.has_images ? (
              <Text color="blue" dimColor={!isSelected}>
                [img]{" "}
              </Text>
            ) : null}
            <Text dimColor={!isSelected}>
              {truncate(a.insights, colInsights - (a.has_images ? 6 : 0))}
            </Text>
          </Box>
        );
      })}
      {Array.from({ length: visibleRows - rows.length }).map((_, i) => (
        <Text key={`empty-${i}`}> </Text>
      ))}
    </Panel>
  );
}

// ── Detail Bar (selected entry) ─────────────────────────────────────

function DetailBar({
  analysis,
  width,
}: {
  analysis: Analysis | undefined;
  width: number;
}) {
  if (!analysis) return null;

  const projectName = analysis.cwd
    ? (analysis.cwd.split("/").filter(Boolean).pop() ?? analysis.cwd)
    : "—";

  return (
    <Panel title="▸ Selected" titleColor="yellow" width={width}>
      <Box gap={2}>
        <Text>
          Session{" "}
          <Text bold color="blue">
            {analysis.session_id.slice(0, 12)}
          </Text>
        </Text>
        <Text>
          Project{" "}
          <Text bold color="green">
            {projectName}
          </Text>
        </Text>
        <Text>
          Path{" "}
          <Text dimColor>
            {truncate(analysis.cwd, Math.max(20, width - 80))}
          </Text>
        </Text>
        {analysis.has_images ? (
          <Text>
            Images{" "}
            <Text bold color="blue">
              {analysis.image_count}
            </Text>
          </Text>
        ) : null}
      </Box>
    </Panel>
  );
}

// ── Sidebar: Projects ───────────────────────────────────────────────

function ProjectsPanel({
  projects,
  width,
  height,
  scrollOffset,
}: {
  projects: ProjectStat[];
  width: number;
  height: number;
  scrollOffset: number;
}) {
  if (projects.length === 0) {
    return (
      <Panel title="Projects" width={width}>
        <Text dimColor>No data</Text>
      </Panel>
    );
  }

  const innerW = width - 4; // border (2) + paddingX (2)
  const labelW = 10;
  const countW = 4;
  const gaps = 2; // two gap={1} separators
  const maxCount = projects[0]?.count ?? 1;
  const barWidth = Math.max(3, innerW - labelW - countW - gaps);
  const maxItems = Math.max(1, Math.floor((height - 3) / 2));
  const offset = Math.min(scrollOffset, Math.max(0, projects.length - maxItems));
  const visible = projects.slice(offset, offset + maxItems);
  const hasMore = projects.length > maxItems;

  return (
    <Panel title={hasMore ? `Projects (${offset + 1}-${Math.min(offset + maxItems, projects.length)}/${projects.length})` : "Projects"} width={width}>
      <Box flexDirection="column" gap={1}>
      {visible.map((p) => {
        const name = p.project.split("/").filter(Boolean).pop() ?? p.project;
        const filled = Math.round((p.count / maxCount) * barWidth);
        const empty = barWidth - filled;
        return (
          <Box key={p.project} gap={1}>
            <Text color="green">
              {pad(truncate(name, labelW) || "?", labelW)}
            </Text>
            <Text>
              <Text color="green">{"█".repeat(filled)}</Text>
              <Text dimColor>{"░".repeat(empty)}</Text>
            </Text>
            <Text bold>{String(p.count).padStart(countW)}</Text>
          </Box>
        );
      })}
      </Box>
    </Panel>
  );
}

// ── Sidebar: Categories ─────────────────────────────────────────────

function CategoryPanel({
  stats,
  width,
  height,
  scrollOffset,
}: {
  stats: Stats;
  width: number;
  height: number;
  scrollOffset: number;
}) {
  const innerW = width - 4; // border (2) + paddingX (2)
  const labelW = 10;
  const countW = 4;
  const gaps = 2; // two gap={1} separators
  const cats = stats.categories;
  const maxCount = cats[0]?.count ?? 1;
  const barWidth = Math.max(3, innerW - labelW - countW - gaps);
  const maxItems = Math.max(1, Math.floor((height - 3) / 2));
  const offset = Math.min(scrollOffset, Math.max(0, cats.length - maxItems));
  const visible = cats.slice(offset, offset + maxItems);
  const hasMore = cats.length > maxItems;

  return (
    <Panel title={hasMore ? `Categories (${offset + 1}-${Math.min(offset + maxItems, cats.length)}/${cats.length})` : "Categories"} width={width}>
      {cats.length === 0 ? (
        <Text dimColor>No data</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
        {visible.map((c) => {
          const filled = Math.round((c.count / maxCount) * barWidth);
          const empty = barWidth - filled;
          return (
            <Box key={c.category} gap={1}>
              <Text color="magenta">{pad(c.category, labelW)}</Text>
              <Text>
                <Text color="magenta">{"█".repeat(filled)}</Text>
                <Text dimColor>{"░".repeat(empty)}</Text>
              </Text>
              <Text bold>{String(c.count).padStart(countW)}</Text>
            </Box>
          );
        })}
        </Box>
      )}
    </Panel>
  );
}

// ── Sidebar: Score Distribution ─────────────────────────────────────

function ScoreDistribution({
  analyses,
  width,
}: {
  analyses: Analysis[];
  width: number;
}) {
  const buckets = Array(10).fill(0);
  for (const a of analyses) {
    if (
      a.quality_score !== null &&
      a.quality_score >= 1 &&
      a.quality_score <= 10
    ) {
      buckets[a.quality_score - 1]++;
    }
  }
  const max = Math.max(1, ...buckets);
  const barMax = Math.max(3, width - 12);

  return (
    <Panel title="Score Distribution" width={width}>
      <Box flexDirection="column" gap={1}>
      {buckets.map((count, i) => {
        const score = i + 1;
        const barLen = Math.round((count / max) * barMax);
        return (
          <Box key={score} gap={1}>
            <Text color={scoreColor(score)} bold>
              {String(score).padStart(2)}
            </Text>
            <Text color={scoreColor(score)}>
              {"█".repeat(barLen)}
              {"░".repeat(barMax - barLen)}
            </Text>
            <Text dimColor>{String(count).padStart(2)}</Text>
          </Box>
        );
      })}
      </Box>
    </Panel>
  );
}

// ── Sidebar: Complexity Breakdown ───────────────────────────────────

function ComplexityPanel({
  analyses,
  width,
}: {
  analyses: Analysis[];
  width: number;
}) {
  const counts = { low: 0, medium: 0, high: 0 };
  for (const a of analyses) {
    if (
      a.complexity === "low" ||
      a.complexity === "medium" ||
      a.complexity === "high"
    ) {
      counts[a.complexity]++;
    }
  }
  const total = Math.max(1, counts.low + counts.medium + counts.high);

  return (
    <Panel title="Complexity" width={width}>
      <Box flexDirection="column" gap={1}>
      {(["low", "medium", "high"] as const).map((level) => {
        const pct = Math.round((counts[level] / total) * 100);
        return (
          <Box key={level} gap={1}>
            <Text color={complexityColor(level)}>{pad(level, 7)}</Text>
            <Text bold>{String(counts[level]).padStart(3)}</Text>
            <Text dimColor>({String(pct).padStart(2)}%)</Text>
          </Box>
        );
      })}
      </Box>
    </Panel>
  );
}

// ── Filter Bar ──────────────────────────────────────────────────────

function FilterBar({
  filters,
  grouped,
  width,
}: {
  filters: Filters;
  grouped: boolean;
  width: number;
}) {
  const active = hasActiveFilters(filters);
  if (!active && !grouped) return null;

  const projectName = filters.project
    ? (filters.project.split("/").filter(Boolean).pop() ?? filters.project)
    : null;
  const sessionShort = filters.session ? filters.session.slice(0, 12) : null;

  return (
    <Panel title="Filters" titleColor="yellow" width={width}>
      <Box gap={2}>
        {projectName && (
          <Text>
            project{" "}
            <Text bold color="green">
              {projectName}
            </Text>
          </Text>
        )}
        {filters.category && (
          <Text>
            category{" "}
            <Text bold color="magenta">
              {filters.category}
            </Text>
          </Text>
        )}
        {sessionShort && (
          <Text>
            session{" "}
            <Text bold color="blue">
              {sessionShort}
            </Text>
          </Text>
        )}
        {grouped && (
          <Text bold color="cyan">
            grouped by session
          </Text>
        )}
        <Text dimColor>Esc to clear</Text>
      </Box>
    </Panel>
  );
}

// ── Grouped Table ───────────────────────────────────────────────────

type DisplayRow =
  | {
      kind: "header";
      session: string;
      project: string | null;
      count: number;
      avgScore: number;
    }
  | { kind: "entry"; analysis: Analysis };

function buildGroupedRows(analyses: Analysis[]): DisplayRow[] {
  const groups = new Map<string, Analysis[]>();
  for (const a of analyses) {
    const list = groups.get(a.session_id) ?? [];
    list.push(a);
    groups.set(a.session_id, list);
  }

  const rows: DisplayRow[] = [];
  for (const [sessionId, items] of groups) {
    const scores = items
      .filter((a) => a.quality_score !== null)
      .map((a) => a.quality_score!);
    const avg =
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) /
          10
        : 0;
    rows.push({
      kind: "header",
      session: sessionId,
      project: items[0].cwd,
      count: items.length,
      avgScore: avg,
    });
    for (const a of items) {
      rows.push({ kind: "entry", analysis: a });
    }
  }
  return rows;
}

function GroupedTable({
  analyses,
  height,
  width,
  selectedIdx,
}: {
  analyses: Analysis[];
  height: number;
  width: number;
  selectedIdx: number;
}) {
  const innerW = width - 4;
  const visibleRows = Math.max(1, height - 4);
  const displayRows = buildGroupedRows(analyses);

  if (displayRows.length === 0) {
    return (
      <Panel title="Analyses by Session" width={width}>
        <Box height={visibleRows} alignItems="center" justifyContent="center">
          <Text dimColor>No analyses match current filters.</Text>
        </Box>
      </Panel>
    );
  }

  // Map selectedIdx (over analyses) to displayRow index
  let entryCount = -1;
  let selectedDisplayIdx = 0;
  for (let i = 0; i < displayRows.length; i++) {
    if (displayRows[i].kind === "entry") entryCount++;
    if (entryCount === selectedIdx) {
      selectedDisplayIdx = i;
      break;
    }
  }

  let scrollOffset = 0;
  if (selectedDisplayIdx >= visibleRows) {
    scrollOffset = selectedDisplayIdx - visibleRows + 1;
  }
  const visible = displayRows.slice(scrollOffset, scrollOffset + visibleRows);

  const colTime = 10;
  const colCat = 10;
  const colScore = 6;
  const colInsights = Math.max(10, innerW - colTime - colCat - colScore - 8);

  return (
    <Panel title={`Analyses by Session (${analyses.length})`} width={width}>
      {visible.map((row, i) => {
        const absIdx = scrollOffset + i;
        if (row.kind === "header") {
          const projectName = row.project
            ? (row.project.split("/").filter(Boolean).pop() ?? "?")
            : "?";
          return (
            <Box key={`h-${row.session}`}>
              <Text bold color="blue">
                {"  "}
                {row.session.slice(0, 10)}{" "}
              </Text>
              <Text dimColor>
                {projectName} │ {row.count} prompts │ avg{" "}
              </Text>
              <Text bold color={scoreColor(row.avgScore)}>
                {row.avgScore}
              </Text>
            </Box>
          );
        }

        // Find which analysis index this entry corresponds to
        let eIdx = -1;
        let count = 0;
        for (let j = 0; j <= absIdx; j++) {
          if (displayRows[j].kind === "entry") {
            eIdx = count;
            count++;
          }
        }
        const isSelected = eIdx === selectedIdx;
        const a = row.analysis;

        return (
          <Box key={a.id}>
            <Text color={isSelected ? "cyan" : undefined} bold={isSelected}>
              {isSelected ? "  ▸ " : "    "}
            </Text>
            <Text dimColor={!isSelected}>
              {pad(timeAgo(a.created_at), colTime)}
            </Text>
            <Text color="magenta" dimColor={!isSelected}>
              {pad(a.category ?? "—", colCat)}
            </Text>
            <Text
              bold
              color={scoreColor(a.quality_score)}
              dimColor={!isSelected}
            >
              {pad(
                a.quality_score !== null ? String(a.quality_score) : "—",
                colScore,
              )}
            </Text>
            {a.has_images ? (
              <Text color="blue" dimColor={!isSelected}>
                [img]{" "}
              </Text>
            ) : null}
            <Text dimColor={!isSelected}>
              {truncate(a.insights, colInsights - (a.has_images ? 6 : 0))}
            </Text>
          </Box>
        );
      })}
      {Array.from({ length: Math.max(0, visibleRows - visible.length) }).map(
        (_, i) => (
          <Text key={`empty-${i}`}> </Text>
        ),
      )}
    </Panel>
  );
}

// ── Help Overlay ────────────────────────────────────────────────────

function HelpOverlay({ width, height }: { width: number; height: number }) {
  const w = Math.min(50, width - 4);
  const h = Math.min(24, height - 4);
  const left = Math.floor((width - w) / 2);
  const top = Math.floor((height - h) / 2);

  const bindings: [string, string][] = [
    ["↑/k", "Move selection up"],
    ["↓/j", "Move selection down"],
    ["p", "Cycle project filter"],
    ["c", "Cycle category filter"],
    ["f", "Cycle session filter"],
    ["g", "Toggle session grouping"],
    ["Tab", "Switch tab"],
    ["[/]", "Scroll sidebar panels"],
    ["Esc", "Clear all filters"],
    ["d", "Delete selected entry"],
    ["D", "Delete ALL entries (reset)"],
    ["r", "Refresh data"],
    ["?", "Toggle this help"],
    ["q", "Quit"],
  ];

  return (
    <Box justifyContent="center" alignItems="center" width={width} height={height - 8}>
      <Box
        width={w}
        flexDirection="column"
        borderStyle="double"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
      >
        <Text color="cyan" bold>
          Keyboard Shortcuts
        </Text>
        <Text> </Text>
        {bindings.map(([key, desc]) => (
          <Box key={key} gap={1}>
            <Text bold color="yellow">
              {pad(key, 6)}
            </Text>
            <Text>{desc}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text dimColor>Press ? or Esc to close</Text>
      </Box>
    </Box>
  );
}

// ── Confirm Dialog ──────────────────────────────────────────────────

function ConfirmDialog({
  message,
  width,
  height,
}: {
  message: string;
  width: number;
  height: number;
}) {
  const w = Math.min(52, width - 4);
  const left = Math.floor((width - w) / 2);
  const top = Math.floor((height - 6) / 2);

  return (
    <Box justifyContent="center" alignItems="center" width={width} height={height - 8}>
      <Box
        width={w}
        flexDirection="column"
        borderStyle="double"
        borderColor="red"
        paddingX={2}
      >
        <Text bold color="red">
          {message}
        </Text>
        <Text> </Text>
        <Text>
          Press{" "}
          <Text bold color="green">
            y/Enter
          </Text>{" "}
          to confirm,{" "}
          <Text bold color="yellow">
            n/Esc
          </Text>{" "}
          to cancel
        </Text>
      </Box>
    </Box>
  );
}

// ── Footer ──────────────────────────────────────────────────────────

function Footer({ width, lastRefresh }: { width: number; lastRefresh: Date }) {
  return (
    <Box
      width={width}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text dimColor>
        ↑↓ navigate Tab switch view [] scroll sidebar p project c category f session g group d del ? help q quit
      </Text>
      <Text dimColor>
        {lastRefresh.toLocaleTimeString()} │ {POLL_MS / 1000}s poll
      </Text>
    </Box>
  );
}

// ── Tab Bar ─────────────────────────────────────────────────────────

type Tab = "dashboard" | "trends" | "recommendations";

// ── Trends View ─────────────────────────────────────────────────────

function TrendsView({
  trends,
  analyses,
  width,
  height,
}: {
  trends: DailyTrend[];
  analyses: Analysis[];
  width: number;
  height: number;
}) {
  if (trends.length === 0) {
    return (
      <Panel title="Trends" width={width}>
        <Box
          height={height - 4}
          alignItems="center"
          justifyContent="center"
        >
          <Text dimColor>
            No trend data yet. Submit prompts over multiple days to see trends.
          </Text>
        </Box>
      </Panel>
    );
  }

  const scores = trends.map((t) => t.avg_score);
  const counts = trends.map((t) => t.count);
  const xLabels = trends.map((t) => t.day.slice(5)); // MM-DD
  const graphWidth = Math.max(20, width - 8);
  const graphHeight = Math.max(3, Math.floor((height - 12) / 3));

  // Category breakdown for bar chart
  const catCounts = new Map<string, number>();
  for (const a of analyses) {
    if (a.category) {
      catCounts.set(a.category, (catCounts.get(a.category) ?? 0) + 1);
    }
  }
  const catData = [...catCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, value]) => ({ label, value, color: "magenta" as const }));

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <Panel title="Quality Score Over Time" width={width}>
        <LineGraph
          data={[{ values: scores, color: "green" }]}
          width={graphWidth}
          height={graphHeight}
          xLabels={xLabels}
          showYAxis
          yDomain={[0, 10]}
        />
      </Panel>

      <Panel title="Prompt Volume Over Time" width={width}>
        <Sparkline
          data={counts}
          width={graphWidth}
          caption={`${xLabels[0] ?? ""} → ${xLabels[xLabels.length - 1] ?? ""}`}
        />
      </Panel>

      {catData.length > 0 && (
        <Panel title="Category Breakdown" width={width}>
          <BarChart
            data={catData}
            width={graphWidth}
            showValue="right"
            sort="desc"
          />
        </Panel>
      )}
    </Box>
  );
}

// ── Recommendations View ─────────────────────────────────────────────

function RecCard({ r }: { r: Recommendation }) {
  const color = r.severity === "good" ? "green" : r.severity === "warn" ? "yellow" : "cyan";
  const icon = r.severity === "good" ? "+" : r.severity === "warn" ? "!" : "i";
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold color={color}>[{icon}]</Text>
        <Text bold color={color}>{r.title}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text wrap="wrap">{r.body}</Text>
      </Box>
    </Box>
  );
}

function CategoryScoreChart({
  catScores,
  width,
}: {
  catScores: CategoryScore[];
  width: number;
}) {
  if (catScores.length === 0) return null;
  const innerW = width - 4;
  const labelW = 10;
  const scoreW = 5;
  const barW = Math.max(3, innerW - labelW - scoreW - 3);

  return (
    <Panel title="Score by Category" width={width}>
      <Box flexDirection="column" gap={1}>
        {catScores.map((c) => {
          const filled = Math.round((c.avg_score / 10) * barW);
          const empty = barW - filled;
          return (
            <Box key={c.category} gap={1}>
              <Text color="magenta">{pad(c.category, labelW)}</Text>
              <Text>
                <Text color={scoreColor(c.avg_score)}>{"█".repeat(filled)}</Text>
                <Text dimColor>{"░".repeat(empty)}</Text>
              </Text>
              <Text bold color={scoreColor(c.avg_score)}>
                {String(c.avg_score).padStart(scoreW)}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}

function WeeklyScorecard({
  weekly,
  width,
}: {
  weekly: WeeklyComparison;
  width: number;
}) {
  const delta = (curr: number, prev: number) => {
    if (prev === 0) return { text: "", color: "gray" };
    const d = curr - prev;
    if (d > 0) return { text: ` +${d.toFixed(1)}`, color: "green" };
    if (d < 0) return { text: ` ${d.toFixed(1)}`, color: "red" };
    return { text: " =", color: "gray" };
  };

  const scoreDelta = delta(weekly.thisWeek.avgScore, weekly.lastWeek.avgScore);
  const countDelta = delta(weekly.thisWeek.count, weekly.lastWeek.count);
  const lenDelta = delta(weekly.thisWeek.avgLength, weekly.lastWeek.avgLength);

  return (
    <Panel title="This Week vs Last Week" width={width}>
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text dimColor>{pad("", 12)}</Text>
          <Text bold dimColor>{pad("This wk", 10)}</Text>
          <Text bold dimColor>{pad("Last wk", 10)}</Text>
          <Text bold dimColor>Change</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>{pad("Prompts", 12)}</Text>
          <Text bold>{pad(String(weekly.thisWeek.count), 10)}</Text>
          <Text dimColor>{pad(String(weekly.lastWeek.count), 10)}</Text>
          <Text color={countDelta.color}>{countDelta.text}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>{pad("Avg score", 12)}</Text>
          <Text bold color={scoreColor(weekly.thisWeek.avgScore)}>
            {pad(weekly.thisWeek.avgScore ? String(weekly.thisWeek.avgScore) : "—", 10)}
          </Text>
          <Text dimColor>{pad(weekly.lastWeek.avgScore ? String(weekly.lastWeek.avgScore) : "—", 10)}</Text>
          <Text color={scoreDelta.color}>{scoreDelta.text}</Text>
        </Box>
        <Box gap={1}>
          <Text dimColor>{pad("Avg length", 12)}</Text>
          <Text bold>{pad(String(weekly.thisWeek.avgLength), 10)}</Text>
          <Text dimColor>{pad(String(weekly.lastWeek.avgLength), 10)}</Text>
          <Text color={lenDelta.color}>{lenDelta.text}</Text>
        </Box>
      </Box>
    </Panel>
  );
}

function LengthScoreChart({
  buckets,
  width,
}: {
  buckets: LengthBucket[];
  width: number;
}) {
  if (buckets.length === 0) return null;
  const innerW = width - 4;
  const labelW = 9;
  const scoreW = 5;
  const countW = 5;
  const barW = Math.max(3, innerW - labelW - scoreW - countW - 4);
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <Panel title="Length vs Quality" width={width}>
      <Box flexDirection="column" gap={1}>
        {buckets.map((b) => {
          const filled = Math.round((b.count / maxCount) * barW);
          const empty = barW - filled;
          return (
            <Box key={b.label} gap={1}>
              <Text dimColor>{pad(b.label, labelW)}</Text>
              <Text>
                <Text color={scoreColor(b.avg_score)}>{"█".repeat(filled)}</Text>
                <Text dimColor>{"░".repeat(empty)}</Text>
              </Text>
              <Text dimColor>{String(b.count).padStart(countW)}</Text>
              <Text bold color={scoreColor(b.avg_score)}>
                {String(b.avg_score).padStart(scoreW)}
              </Text>
            </Box>
          );
        })}
        <Box gap={1}>
          <Text dimColor>{pad("chars", labelW)}</Text>
          <Text dimColor>{pad("volume", barW)}</Text>
          <Text dimColor>{" ".repeat(countW - 3)}cnt</Text>
          <Text dimColor>{" ".repeat(scoreW - 3)}avg</Text>
        </Box>
      </Box>
    </Panel>
  );
}

function RecommendationsView({
  recs,
  llmRecs,
  llmLoading,
  catScores,
  weekly,
  lengthBuckets,
  width,
  height,
}: {
  recs: Recommendation[];
  llmRecs: Recommendation[];
  llmLoading: boolean;
  catScores: CategoryScore[];
  weekly: WeeklyComparison;
  lengthBuckets: LengthBucket[];
  width: number;
  height: number;
}) {
  const leftW = Math.floor(width * 0.45);
  const rightW = width - leftW;

  return (
    <Box width={width}>
      {/* Left column: charts */}
      <Box flexDirection="column" width={leftW} gap={1}>
        <CategoryScoreChart catScores={catScores} width={leftW} />
        <WeeklyScorecard weekly={weekly} width={leftW} />
        <LengthScoreChart buckets={lengthBuckets} width={leftW} />
      </Box>
      {/* Right column: recommendations */}
      <Box flexDirection="column" width={rightW} gap={1}>
        <Panel title="Recommendations" width={rightW}>
          <Box flexDirection="column" gap={1}>
            {recs.map((r, i) => <RecCard key={`sql-${i}`} r={r} />)}
          </Box>
        </Panel>
        <Panel title="AI Insights" titleColor={llmLoading ? "yellow" : "cyan"} width={rightW}>
          {llmLoading ? (
            <Text color="yellow">Analyzing your prompting patterns...</Text>
          ) : llmRecs.length === 0 ? (
            <Text dimColor>No AI insights available. Ensure OPENROUTER_API_KEY is set.</Text>
          ) : (
            <Box flexDirection="column" gap={1}>
              {llmRecs.map((r, i) => <RecCard key={`llm-${i}`} r={r} />)}
            </Box>
          )}
        </Panel>
      </Box>
    </Box>
  );
}

// ── Main App ────────────────────────────────────────────────────────

type Modal = "none" | "help" | "confirmDelete" | "confirmDeleteAll";

const isTTY = process.stdin.isTTY === true;

function App() {
  const { columns, rows } = useTerminalSize();
  const { exit } = useApp();
  const dbRef = useRef<Database>(initDb);
  const [allAnalyses, setAllAnalyses] = useState<Analysis[]>(initAnalyses);
  const [stats, setStats] = useState<Stats>(initStats);
  const [projectStats, setProjectStats] =
    useState<ProjectStat[]>(initProjectStats);
  const [sessionCount, setSessionCount] = useState(initSessionCount);
  const [trends, setTrends] = useState<DailyTrend[]>(initTrends);
  const [recs, setRecs] = useState<Recommendation[]>(initRecs);
  const [catScores, setCatScores] = useState<CategoryScore[]>(initCatScores);
  const [weekly, setWeekly] = useState<WeeklyComparison>(initWeekly);
  const [lengthBuckets, setLengthBuckets] = useState<LengthBucket[]>(initLengthBuckets);
  const [llmRecs, setLlmRecs] = useState<Recommendation[]>([]);
  const [llmLoading, setLlmLoading] = useState(false);
  const llmFetchedHash = useRef<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [modal, setModal] = useState<Modal>("none");
  const [flash, setFlash] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [grouped, setGrouped] = useState(false);
  const [sidebarScroll, setSidebarScroll] = useState(0);

  // Derived: filtered analyses
  const analyses = applyFilters(allAnalyses, filters);

  // Unique values for cycling filters
  const uniqueProjects = [
    ...new Set(allAnalyses.map((a) => a.cwd ?? "(unknown)")),
  ];
  const uniqueCategories = [
    ...new Set(allAnalyses.map((a) => a.category).filter(Boolean)),
  ] as string[];
  const uniqueSessions = [...new Set(allAnalyses.map((a) => a.session_id))];

  const poll = () => {
    const db = dbRef.current;
    setAllAnalyses(getRecent(db, 200));
    setStats(getStats(db));
    setProjectStats(getProjectStats(db));
    setSessionCount(getSessionCount(db));
    setTrends(getDailyTrends(db));
    setRecs(getRecommendations(db));
    setCatScores(getCategoryScores(db));
    setWeekly(getWeeklyComparison(db));
    setLengthBuckets(getLengthDistribution(db));
    setLastRefresh(new Date());
  };

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2000);
  };

  const handleAction = (action: KeyAction) => {
    // If a modal is open, only respond to confirm/cancel/escape
    if (modal === "help") {
      if (action.type === "help" || action.type === "cancel") {
        setModal("none");
      }
      return;
    }

    if (modal === "confirmDelete") {
      if (action.type === "confirm") {
        const target = analyses[selectedIdx];
        if (target) {
          deleteAnalysis(dbRef.current, target.id);
          poll();
          setSelectedIdx((prev) =>
            Math.min(prev, Math.max(0, analyses.length - 2)),
          );
          showFlash("Entry deleted");
        }
        setModal("none");
      } else if (action.type === "cancel" || action.type === "quit") {
        setModal("none");
      }
      return;
    }

    if (modal === "confirmDeleteAll") {
      if (action.type === "confirm") {
        deleteAllAnalyses(dbRef.current);
        poll();
        setSelectedIdx(0);
        showFlash("All entries deleted");
        setModal("none");
      } else if (action.type === "cancel" || action.type === "quit") {
        setModal("none");
      }
      return;
    }

    // Normal mode
    switch (action.type) {
      case "quit":
        exit();
        break;
      case "refresh":
        poll();
        showFlash("Refreshed");
        break;
      case "up":
        setSelectedIdx((prev) => Math.max(0, prev - 1));
        break;
      case "down":
        setSelectedIdx((prev) => Math.min(analyses.length - 1, prev + 1));
        break;
      case "delete":
        if (analyses.length > 0) setModal("confirmDelete");
        break;
      case "deleteAll":
        if (analyses.length > 0) setModal("confirmDeleteAll");
        break;
      case "help":
        setModal("help");
        break;
      case "filterProject": {
        const next = cycleValue(filters.project, uniqueProjects);
        setFilters((f) => ({ ...f, project: next }));
        setSelectedIdx(0);
        const label = next
          ? (next.split("/").filter(Boolean).pop() ?? next)
          : "all";
        showFlash(`Project: ${label}`);
        break;
      }
      case "filterCategory": {
        const next = cycleValue(filters.category, uniqueCategories);
        setFilters((f) => ({ ...f, category: next }));
        setSelectedIdx(0);
        showFlash(`Category: ${next ?? "all"}`);
        break;
      }
      case "filterSession": {
        const next = cycleValue(filters.session, uniqueSessions);
        setFilters((f) => ({ ...f, session: next }));
        setSelectedIdx(0);
        showFlash(`Session: ${next ? next.slice(0, 12) : "all"}`);
        break;
      }
      case "toggleGrouping":
        setGrouped((g) => !g);
        setSelectedIdx(0);
        showFlash(grouped ? "Grouping off" : "Grouped by session");
        break;
      case "switchTab": {
        const tabOrder: Tab[] = ["dashboard", "trends", "recommendations"];
        setActiveTab((t) => tabOrder[(tabOrder.indexOf(t) + 1) % tabOrder.length]);
        break;
      }
      case "sidebarScrollUp":
        setSidebarScroll((s) => Math.max(0, s - 1));
        break;
      case "sidebarScrollDown":
        setSidebarScroll((s) => s + 1);
        break;
      case "cancel":
        if (hasActiveFilters(filters) || grouped) {
          setFilters(emptyFilters);
          setGrouped(false);
          setSelectedIdx(0);
          showFlash("Filters cleared");
        }
        break;
    }
  };

  useEffect(() => {
    const id = setInterval(poll, POLL_MS);
    return () => {
      clearInterval(id);
      dbRef.current.close();
    };
  }, []);

  // Fetch LLM recommendations when Tips tab is active and data has changed
  useEffect(() => {
    if (activeTab !== "recommendations") return;
    const db = dbRef.current;
    const currentHash = getDataHash(db);
    // Already fetched for this data
    if (llmFetchedHash.current === currentHash) return;
    // Check cache first
    const cached = getCachedLLMRecs(db);
    if (cached && cached.dataHash === currentHash) {
      setLlmRecs(cached.recs);
      llmFetchedHash.current = currentHash;
      return;
    }
    // Fetch from LLM
    setLlmLoading(true);
    const context = gatherLLMContext(db);
    generateLLMRecommendations(context as unknown as Record<string, unknown>).then((results) => {
      const mapped: Recommendation[] = results.map((r) => ({
        icon: r.severity === "good" ? "+" : r.severity === "warn" ? "!" : "i",
        ...r,
      }));
      setLlmRecs(mapped);
      setLlmLoading(false);
      llmFetchedHash.current = currentHash;
      saveLLMRecs(db, currentHash, mapped);
    }).catch(() => {
      setLlmLoading(false);
    });
  }, [activeTab, allAnalyses.length]);

  // Clamp selected index when data changes
  useEffect(() => {
    if (analyses.length === 0) {
      setSelectedIdx(0);
    } else if (selectedIdx >= analyses.length) {
      setSelectedIdx(analyses.length - 1);
    }
  }, [analyses.length]);

  // Layout calculations
  const sidebarW = Math.min(36, Math.floor(columns * 0.3));
  const mainW = columns - sidebarW;
  const topPanelRows = hasActiveFilters(filters) || grouped ? 3 : 0;
  const detailRows = analyses[selectedIdx] ? 3 : 0;
  const flashRows = flash ? 1 : 0;
  const tableH = rows - 1 - topPanelRows - detailRows - flashRows - 3;
  const catH = Math.floor((tableH - 2) * 0.45);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {isTTY && <KeyboardHandler onAction={handleAction} />}

      {/* Top stats + tab bar */}
      <StatsBar stats={stats} sessionCount={sessionCount} width={columns} activeTab={activeTab} />

      {/* Flash message */}
      {flash && (
        <Box paddingX={1}>
          <Text color="green" bold>
            ● {flash}
          </Text>
        </Box>
      )}

      {modal === "help" ? (
        <Box flexGrow={1}>
          <HelpOverlay width={columns} height={rows} />
        </Box>
      ) : modal === "confirmDelete" ? (
        <Box flexGrow={1}>
          <ConfirmDialog
            message={`Delete entry #${analyses[selectedIdx]?.id ?? "?"}?`}
            width={columns}
            height={rows}
          />
        </Box>
      ) : modal === "confirmDeleteAll" ? (
        <Box flexGrow={1}>
          <ConfirmDialog
            message={`Delete ALL ${analyses.length} entries? This cannot be undone.`}
            width={columns}
            height={rows}
          />
        </Box>
      ) : activeTab === "dashboard" ? (
        <>
          {/* Filter bar */}
          <FilterBar filters={filters} grouped={grouped} width={columns} />

          {/* Detail bar for selected entry */}
          <DetailBar analysis={analyses[selectedIdx]} width={columns} />

          {/* Main content area */}
          <Box flexGrow={1}>
            {grouped ? (
              <GroupedTable
                analyses={analyses}
                height={tableH - 1}
                width={mainW}
                selectedIdx={selectedIdx}
              />
            ) : (
              <RecentTable
                analyses={analyses}
                height={tableH - 1}
                width={mainW}
                selectedIdx={selectedIdx}
              />
            )}

            <Box flexDirection="column" width={sidebarW} gap={1}>
              <ProjectsPanel
                projects={projectStats}
                width={sidebarW}
                height={Math.floor(catH * 0.5)}
                scrollOffset={sidebarScroll}
              />
              <CategoryPanel
                stats={stats}
                width={sidebarW}
                height={Math.floor(catH * 0.5)}
                scrollOffset={sidebarScroll}
              />
              <ScoreDistribution analyses={analyses} width={sidebarW} />
              <ComplexityPanel analyses={analyses} width={sidebarW} />
            </Box>
          </Box>
        </>
      ) : activeTab === "trends" ? (
        <Box flexGrow={1}>
          <TrendsView
            trends={trends}
            analyses={analyses}
            width={columns}
            height={tableH}
          />
        </Box>
      ) : (
        <Box flexGrow={1}>
          <RecommendationsView
            recs={recs}
            llmRecs={llmRecs}
            llmLoading={llmLoading}
            catScores={catScores}
            weekly={weekly}
            lengthBuckets={lengthBuckets}
            width={columns}
            height={tableH}
          />
        </Box>
      )}

      {/* Bottom bar */}
      <Footer width={columns} lastRefresh={lastRefresh} />
    </Box>
  );
}

// Enter alternate screen buffer for fullscreen experience
process.stdout.write("\x1b[?1049h");
process.stdout.write("\x1b[?25l");

const app = render(<App />);

function cleanup() {
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
}

app.waitUntilExit().then(cleanup);

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
