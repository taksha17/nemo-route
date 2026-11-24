import { eq } from "drizzle-orm";
import type {
  AnalysisResult,
  Complexity,
  ModelRegistryEntry,
  ModelTier,
  TaskType,
} from "@nemo-route/shared";
import { VIRTUAL_MODELS } from "@nemo-route/shared";
import { env } from "../config/env.js";
import { getDb } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { getSettings } from "../db/workspace.js";
import { isModelRoutable } from "../scout/health.js";
import { getModelEntry, listChatModels, listHealth } from "../scout/registry.js";
import type { PromptImportance, RichAnalysis } from "./analyzer.js";

export interface SelectOptions {
  analysis: AnalysisResult | RichAnalysis;
  requestedModel: string;
  sessionId?: string | null;
  excludeModels?: string[];
}

export function selectFallbackChain(opts: SelectOptions): string[] {
  const settings = getSettings();
  const exclude = new Set(opts.excludeModels ?? []);
  const importance = getImportance(opts.analysis);
  const chats = listChatModels().filter((m) => {
    if (exclude.has(m.id)) return false;
    return isModelRoutable(m.id);
  });

  // Pinned real model
  if (
    opts.requestedModel &&
    !VIRTUAL_MODELS.includes(opts.requestedModel as (typeof VIRTUAL_MODELS)[number])
  ) {
    const pinned = getModelEntry(opts.requestedModel);
    const chain: string[] = [];
    if (pinned && isModelRoutable(pinned.id) && !exclude.has(pinned.id)) {
      // Never pin a text-only model onto an image/audio/video request
      const pinnedOkForVision =
        !opts.analysis.requiresVision || pinned.inputs.includes("image");
      if (pinnedOkForVision) chain.push(pinned.id);
    }
    chain.push(
      ...rankModels(
        chats.filter((m) => m.id !== opts.requestedModel),
        opts.analysis,
        settings.taskPreferences,
        importance,
      ),
    );
    return dedupe(
      applyStickiness(chain, opts.sessionId, importance, opts.analysis.complexity),
    );
  }

  // Preference lists are soft hints only — never force light-only except trivial/fast
  let preferred = settings.taskPreferences[opts.analysis.taskType] ?? [];
  // Image/audio/video in the thread always prefers real VL/omni NIM profiles
  if (opts.analysis.requiresVision) {
    preferred = settings.taskPreferences.vision ?? preferred;
  }
  if (opts.requestedModel === "nemo/fast") {
    preferred = chats.filter((m) => m.tier === "light").map((m) => m.id);
  } else if (importance === "trivial" && opts.analysis.taskType === "chat") {
    preferred = [
      ...(settings.taskPreferences.chat ?? []).filter((id) => {
        const e = getModelEntry(id);
        return e?.tier === "light";
      }),
      ...chats.filter((m) => m.tier === "light").map((m) => m.id),
    ];
  } else if (opts.requestedModel === "nemo/code") {
    preferred = settings.taskPreferences.code ?? preferred;
  } else if (opts.requestedModel === "nemo/reasoning") {
    preferred = settings.taskPreferences.reasoning ?? preferred;
  } else if (opts.requestedModel === "nemo/vision") {
    preferred = settings.taskPreferences.vision ?? preferred;
  }

  const ranked = rankModels(
    chats,
    opts.analysis,
    {
      ...settings.taskPreferences,
      [opts.analysis.taskType]: preferred,
    },
    importance,
  );
  return dedupe(
    applyStickiness(ranked, opts.sessionId, importance, opts.analysis.complexity),
  );
}

function getImportance(analysis: AnalysisResult | RichAnalysis): PromptImportance {
  if ("importance" in analysis && analysis.importance) return analysis.importance;
  if (analysis.complexity === "low") return "trivial";
  if (analysis.complexity === "high") return "critical";
  return "normal";
}

function rankModels(
  models: ModelRegistryEntry[],
  analysis: AnalysisResult | RichAnalysis,
  prefs: Partial<Record<TaskType, string[]>>,
  importance: PromptImportance,
): string[] {
  const health = new Map(listHealth().map((h) => [h.modelId, h]));
  const preferred = prefs[analysis.taskType] ?? [];
  const preferredIndex = new Map(preferred.map((id, i) => [id, i]));

  const scored = models
    .filter((m) => {
      if (analysis.requiresTools && !m.tools) return false;
      if (analysis.requiresVision && !m.inputs.includes("image")) return false;
      if (analysis.estimatedInputTokens > m.contextTokens) return false;

      // Only for pure small-talk: keep heavies out when lighter models exist
      if (
        importance === "trivial" &&
        analysis.taskType === "chat" &&
        m.tier === "heavy"
      ) {
        const hasLighter = models.some(
          (x) => x.tier !== "heavy" && isModelRoutable(x.id),
        );
        if (hasLighter) return false;
      }

      // Medium/high work: avoid light-only traps when better tiers are healthy
      if (
        (analysis.complexity === "high" || importance === "critical") &&
        m.tier === "light"
      ) {
        const hasStronger = models.some(
          (x) =>
            (x.tier === "medium" || x.tier === "heavy") &&
            isModelRoutable(x.id) &&
            (!analysis.requiresTools || x.tools),
        );
        // Keep lights as fallback, but rank them last via score — still allow in chain
        void hasStronger;
      }
      return true;
    })
    .map((m) => {
      let score = 0;

      // Task strength fit
      if (m.strengths.includes(analysis.taskType)) score += 24;
      else if (analysis.taskType === "code" && m.strengths.includes("reasoning")) score += 10;

      // Soft preference — small tie-breaker only (was dominating before)
      const pref = preferredIndex.get(m.id);
      if (pref != null) score += Math.max(0, 8 - pref);

      score += tierMatch(m.tier, analysis.complexity, importance, analysis.taskType);

      const h = health.get(m.id);
      if (h?.status === "healthy") score += 14;
      if (h?.status === "degraded") score -= 10;

      // Speed: strong for trivial; mild otherwise so quality can win
      if (h?.avgTtftMs != null) {
        if (importance === "trivial") score -= Math.min(35, h.avgTtftMs / 1200);
        else if (analysis.complexity === "low") score -= Math.min(20, h.avgTtftMs / 2500);
        else score -= Math.min(12, h.avgTtftMs / 8000);
      }

      if (h?.errorRate) score -= h.errorRate * 30;

      // Quality bias for real work
      if (
        (analysis.complexity === "high" || importance === "critical") &&
        (m.tier === "medium" || m.tier === "heavy")
      ) {
        score += 16;
      }
      if (
        (analysis.complexity === "high" || importance === "critical") &&
        m.tier === "light"
      ) {
        score -= 25;
      }

      // Medium coding/chat: prefer medium tier over defaulting to bolt
      if (analysis.complexity === "medium" && importance !== "trivial") {
        if (m.tier === "medium") score += 18;
        if (m.tier === "heavy") score += 8;
        if (m.tier === "light") score -= 12;
      }

      if (importance === "trivial" && m.tier === "heavy") score -= 40;
      if (importance === "trivial" && m.tier === "light") score += 20;

      return { id: m.id, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.map((s) => s.id);
}

function tierMatch(
  tier: ModelTier,
  complexity: Complexity,
  importance: PromptImportance,
  taskType: TaskType,
): number {
  if (importance === "trivial" && taskType === "chat") {
    if (tier === "light") return 30;
    if (tier === "medium") return 8;
    return -25;
  }
  if (complexity === "low") {
    if (tier === "light") return 18;
    if (tier === "medium") return 14;
    return 2;
  }
  if (complexity === "medium") {
    if (tier === "medium") return 22;
    if (tier === "heavy") return 12;
    if (tier === "light") return 4;
    return 0;
  }
  // high
  if (tier === "heavy") return 24;
  if (tier === "medium") return 16;
  return 0;
}

function applyStickiness(
  chain: string[],
  sessionId: string | null | undefined,
  importance: PromptImportance,
  complexity: Complexity,
): string[] {
  if (!sessionId) return chain;
  if (importance === "trivial" || complexity === "low") return chain;

  const db = getDb();
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (!row?.stickyModelId) return chain;
  if (!chain.includes(row.stickyModelId)) return chain;
  if (!isModelRoutable(row.stickyModelId)) return chain;

  const sticky = getModelEntry(row.stickyModelId);
  // Don't stick a light model onto medium/high work
  if (
    (complexity === "medium" || complexity === "high") &&
    sticky?.tier === "light"
  ) {
    return chain;
  }
  // Don't stick heavy onto light chat
  if (complexity === "medium" && sticky?.tier === "heavy") {
    const hasMid = chain.some((id) => {
      const t = getModelEntry(id)?.tier;
      return t === "medium" || t === "light";
    });
    if (hasMid) return chain;
  }

  return [row.stickyModelId, ...chain.filter((id) => id !== row.stickyModelId)];
}

export function rememberStickyModel(
  sessionId: string | null | undefined,
  modelId: string,
  analysis?: AnalysisResult | RichAnalysis,
) {
  if (!sessionId) return;
  const importance = analysis ? getImportance(analysis) : "normal";
  if (importance === "trivial") return;
  if (analysis?.complexity === "low" && analysis.taskType === "chat") return;

  const db = getDb();
  const existing = db.select().from(sessions).where(eq(sessions.id, sessionId)).all()[0];
  if (existing) {
    db.update(sessions)
      .set({ stickyModelId: modelId, updatedAt: Date.now() })
      .where(eq(sessions.id, sessionId))
      .run();
  } else {
    db.insert(sessions)
      .values({
        id: sessionId,
        workspaceId: env.workspaceId,
        stickyModelId: modelId,
        updatedAt: Date.now(),
      })
      .run();
  }
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
