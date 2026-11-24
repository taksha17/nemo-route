import { createHash } from "node:crypto";
import type { AnalysisResult, Complexity, TaskType, VirtualModel } from "@nemo-route/shared";
import { estimateTokens } from "../crypto/secrets.js";

export type PromptImportance = "trivial" | "normal" | "critical";

export interface RichAnalysis extends AnalysisResult {
  importance: PromptImportance;
  latestUserText: string;
  latestUserTokens: number;
}

const cache = new Map<string, RichAnalysis>();

export interface AnalyzeInput {
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>;
  tools?: unknown[];
  requestedModel?: string;
  allowLlmEscalation?: boolean;
}

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|yo|sup|howdy|hola|thanks|thank you|thx|ok|okay|k|yes|no|yep|nope|bye|good ?morning|good ?night|good ?evening|gm|gn)[\s!.?]*$/i,
  /^how are you\??$/i,
  /^what('?s| is) up\??$/i,
  /^who are you\??$/i,
  /^test(ing)?[\s!.?]*$/i,
  /^ping[\s!.?]*$/i,
];

export function analyzeRequest(input: AnalyzeInput): RichAnalysis {
  const forced = forceFromVirtual(input.requestedModel);
  if (forced) return forced;

  const fullText = flattenMessages(input.messages);
  const latestUserText = getLatestUserText(input.messages);
  const analyzeText = latestUserText || fullText;
  const requiresTools = Boolean(input.tools?.length) || hasToolLoop(input.messages);
  const requiresVision = hasMultimodalContent(input.messages);
  const hash = createHash("sha256")
    .update(
      `${input.requestedModel ?? ""}|${analyzeText}|tools:${Boolean(input.tools?.length)}|loop:${hasToolLoop(input.messages)}|vision:${requiresVision}`,
    )
    .digest("hex")
    .slice(0, 24);
  const cached = cache.get(hash);
  if (cached) return cached;
  const estimatedInputTokens = estimateTokens(fullText);
  const latestUserTokens = estimateTokens(analyzeText);

  // Prefer substantive signal: if last user turn is tiny but earlier user turns have work, blend
  const substantive = getSubstantiveUserText(input.messages) || analyzeText;

  let taskType = classifyTask(substantive, requiresVision, requiresTools);
  const importance = scoreImportance(
    substantive,
    requiresTools,
    requiresVision,
    taskType,
  );
  let complexity = scoreComplexity(
    substantive,
    estimateTokens(substantive),
    requiresTools,
    importance,
    taskType,
  );

  // Agentic tool loops: keep at least medium so we don't bounce to a toy model mid-task
  if (hasToolLoop(input.messages) && importance !== "trivial") {
    if (complexity === "low") complexity = "medium";
    if (taskType === "chat") taskType = "code";
  }

  let confidence = 0.65;
  if (importance === "trivial") confidence = 0.95;
  if (requiresVision || requiresTools) confidence = Math.max(confidence, 0.85);
  if (taskType === "code" && /```/.test(substantive)) confidence = 0.9;

  const result: RichAnalysis = {
    taskType,
    complexity,
    requiresTools,
    requiresVision,
    estimatedInputTokens,
    confidence,
    method: "heuristic",
    importance,
    latestUserText: analyzeText,
    latestUserTokens,
  };

  cache.set(hash, result);
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return result;
}

function forceFromVirtual(model?: string): RichAnalysis | null {
  if (!model?.startsWith("nemo/")) return null;
  if (model === "nemo/auto" || model === "nemo/orchestrate") return null;
  const map: Record<string, Partial<RichAnalysis>> = {
    "nemo/fast": {
      taskType: "chat",
      complexity: "low",
      importance: "trivial",
      method: "forced",
      confidence: 1,
    },
    "nemo/code": {
      taskType: "code",
      complexity: "medium",
      importance: "normal",
      method: "forced",
      confidence: 1,
    },
    "nemo/reasoning": {
      taskType: "reasoning",
      complexity: "high",
      importance: "critical",
      method: "forced",
      confidence: 1,
    },
    "nemo/vision": {
      taskType: "vision",
      complexity: "medium",
      requiresVision: true,
      importance: "normal",
      method: "forced",
      confidence: 1,
    },
  };
  const hit = map[model as VirtualModel];
  if (!hit) return null;
  return {
    taskType: "chat",
    complexity: "medium",
    requiresTools: false,
    requiresVision: false,
    estimatedInputTokens: 0,
    confidence: 1,
    method: "forced",
    importance: "normal",
    latestUserText: "",
    latestUserTokens: 0,
    ...hit,
  };
}

function classifyTask(
  text: string,
  requiresVision: boolean,
  requiresTools: boolean,
): TaskType {
  if (requiresVision) return "vision";
  if (looksLikeCode(text) || requiresTools) return "code";
  if (looksLikeReasoning(text)) return "reasoning";
  if (/\bsummar(y|ize|ise)\b/i.test(text)) return "summarize";
  if (/\b(rewrite|rephrase|edit|proofread)\b/i.test(text)) return "rewrite";
  if (/\b(extract|parse|json schema|structured data)\b/i.test(text)) return "extract";
  return "chat";
}

function scoreImportance(
  text: string,
  tools: boolean,
  vision: boolean,
  taskType: TaskType,
): PromptImportance {
  const trimmed = text.trim();
  if (!trimmed) return "trivial";
  if (isTrivialPrompt(trimmed)) return "trivial";
  if (tools || vision) return "critical";
  if (taskType === "code" || taskType === "reasoning") {
    return trimmed.length > 100 || /```/.test(trimmed) ? "critical" : "normal";
  }
  // Short non-technical chit-chat only
  if (
    trimmed.length < 80 &&
    !looksLikeCode(trimmed) &&
    !looksLikeReasoning(trimmed) &&
    !/\b(please|help|explain|write|build|create|fix|implement|debug)\b/i.test(trimmed)
  ) {
    return "trivial";
  }
  return "normal";
}

export function isTrivialPrompt(text: string): boolean {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= 2) return true;
  if (cleaned.length <= 40 && TRIVIAL_PATTERNS.some((re) => re.test(cleaned))) {
    return true;
  }
  if (
    cleaned.length <= 60 &&
    !looksLikeCode(cleaned) &&
    !looksLikeReasoning(cleaned) &&
    /^(hi|hey|hello|thanks|how are|what('?s| is) up|who are you)/i.test(cleaned)
  ) {
    return true;
  }
  return false;
}

export function getLatestUserText(
  messages: Array<{ role: string; content: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = flattenMessages([m]).trim();
    if (!text) continue;
    // Skip OpenCode tool-result wrappers that look like user turns
    if (isToolResultNoise(text)) continue;
    return text;
  }
  return "";
}

/** Walk back through user turns to find real work, not just "hi" or tool noise. */
export function getSubstantiveUserText(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const userTurns: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = flattenMessages([m]).trim();
    if (!text || isToolResultNoise(text)) continue;
    userTurns.push(text);
    if (userTurns.length >= 3) break;
  }
  // Prefer the most recent non-trivial turn
  for (const turn of userTurns) {
    if (!isTrivialPrompt(turn)) return turn;
  }
  return userTurns[0] ?? "";
}

function isToolResultNoise(text: string): boolean {
  return (
    /^<tool/i.test(text) ||
    /^Tool result/i.test(text) ||
    /^\[tool/i.test(text) ||
    (/^{"type":"tool_result"/.test(text) && text.length < 500)
  );
}

export function flattenMessages(
  messages: Array<{ role: string; content: unknown }>,
): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
              const p = part as Record<string, unknown>;
              if (typeof p.text === "string") return p.text;
              if (typeof p.content === "string") return p.content;
            }
            return "";
          })
          .join("\n");
      }
      if (m.content && typeof m.content === "object") {
        return JSON.stringify(m.content);
      }
      return "";
    })
    .join("\n");
}

const MULTIMODAL_PART_TYPES = new Set([
  "image_url",
  "image",
  "input_image",
  "image-url",
  "image_data",
  "image-data",
  "audio_url",
  "input_audio",
  "audio",
  "video_url",
  "video",
  "input_video",
  "media",
  "file",
]);

/** True when the request carries image/audio/video parts OpenCode/NIM understand. */
export function hasMultimodalContent(
  messages: Array<{ content: unknown; [key: string]: unknown }>,
): boolean {
  for (const m of messages) {
    if (typeof m.content === "string") {
      if (/data:image\/[a-z0-9.+-]+;base64,/i.test(m.content)) return true;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const type = typeof p.type === "string" ? p.type.toLowerCase() : "";
      if (MULTIMODAL_PART_TYPES.has(type)) {
        // text-only "file" parts (e.g. source code) are not multimodal
        if (type === "file") {
          const media =
            (typeof p.mediaType === "string" && p.mediaType) ||
            (typeof p.mime_type === "string" && p.mime_type) ||
            (typeof p.mimeType === "string" && p.mimeType) ||
            "";
          if (media.startsWith("image/") || media.startsWith("audio/") || media.startsWith("video/")) {
            return true;
          }
          // OpenCode sometimes sends image files without mime — treat binary-ish as media
          if (p.image_url || p.image || p.data || p.source) return true;
          continue;
        }
        return true;
      }
      if (p.image_url || p.image || p.audio_url || p.video_url || p.input_audio) return true;
      if (p.source && typeof p.source === "object") {
        const src = p.source as Record<string, unknown>;
        if (src.type === "base64" || src.media_type || src.mediaType) return true;
      }
      if (typeof p.text === "string" && /data:image\/[a-z0-9.+-]+;base64,/i.test(p.text)) {
        return true;
      }
    }
  }
  return false;
}

/** Drop media parts so a text-only model can still answer (last-resort fallback). */
export function stripMultimodalContent<T extends { content: unknown }>(messages: T[]): T[] {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const kept = (m.content as unknown[])
      .map((part) => {
        if (!part || typeof part !== "object") return part;
        const p = part as Record<string, unknown>;
        const type = typeof p.type === "string" ? p.type.toLowerCase() : "";
        if (
          MULTIMODAL_PART_TYPES.has(type) ||
          p.image_url ||
          p.image ||
          p.audio_url ||
          p.video_url
        ) {
          if (type === "file") {
            const media =
              (typeof p.mediaType === "string" && p.mediaType) ||
              (typeof p.mime_type === "string" && p.mime_type) ||
              "";
            if (
              !media.startsWith("image/") &&
              !media.startsWith("audio/") &&
              !media.startsWith("video/") &&
              !p.image_url &&
              !p.image
            ) {
              return part;
            }
          }
          return {
            type: "text",
            text: "[media omitted: routed to a text-only model]",
          };
        }
        return part;
      })
      .filter(Boolean);
    return { ...m, content: kept.length > 0 ? kept : "[media omitted]" };
  });
}

export function isMultimodalUpstreamError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${"body" in err ? String((err as { body?: unknown }).body ?? "") : ""}`
      : String(err);
  return /multimodal processing is not enabled|Received multimodal data/i.test(text);
}

function hasToolLoop(messages: Array<{ role: string; tool_calls?: unknown }>): boolean {
  return messages.some(
    (m) => m.role === "tool" || m.role === "function" || Boolean(m.tool_calls),
  );
}

function looksLikeCode(text: string): boolean {
  return (
    /```/.test(text) ||
    /\b(function|class|def |import |package |fn |const |let |var |SELECT |CREATE TABLE)\b/.test(
      text,
    ) ||
    /\b(bug|refactor|compile|typescript|python|javascript|rust|golang|opencode|implement|debug)\b/i.test(
      text,
    )
  );
}

function looksLikeReasoning(text: string): boolean {
  return /\b(prove|reason|step by step|think carefully|analyze|why does|logic|puzzle|math|derive|compare tradeoffs)\b/i.test(
    text,
  );
}

function scoreComplexity(
  text: string,
  tokens: number,
  tools: boolean,
  importance: PromptImportance,
  taskType: TaskType,
): Complexity {
  if (importance === "trivial") return "low";

  let score = 0;
  if (tokens > 1500) score += 2;
  else if (tokens > 300) score += 1;
  if (tools) score += 2;
  if (/```/.test(text)) score += 1;
  if (looksLikeReasoning(text)) score += 1;
  if (taskType === "code" || taskType === "reasoning") score += 1;
  if (looksLikeCode(text) && tokens > 100) score += 1;
  if (text.split("\n").length > 25) score += 1;
  if (importance === "critical") score += 1;

  if (score >= 3) return "high";
  if (score >= 1) return "medium";
  return "low";
}

export function clearAnalyzerCache() {
  cache.clear();
}
