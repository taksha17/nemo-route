export type ModelKind = "chat" | "embed" | "rerank" | "guard" | "other";
export type ModelTier = "light" | "medium" | "heavy";
export type ModelStatus =
  | "healthy"
  | "degraded"
  | "down"
  | "not_entitled"
  | "checking"
  | "unknown";

export type TaskType =
  | "chat"
  | "code"
  | "reasoning"
  | "summarize"
  | "rewrite"
  | "extract"
  | "vision"
  | "other";

export type Complexity = "low" | "medium" | "high";

export type RequestPriority = "live" | "orchestrate" | "probe";

export type RequestOutcome =
  | "success"
  | "error"
  | "failover_success"
  | "cancelled";

export type VirtualModel =
  | "nemo/auto"
  | "nemo/orchestrate"
  | "nemo/fast"
  | "nemo/code"
  | "nemo/reasoning"
  | "nemo/vision";

export const VIRTUAL_MODELS: VirtualModel[] = [
  "nemo/auto",
  "nemo/orchestrate",
  "nemo/fast",
  "nemo/code",
  "nemo/reasoning",
  "nemo/vision",
];

export interface ModelCapabilities {
  kind: ModelKind;
  inputs: Array<"text" | "image" | "audio" | "video">;
  tools: boolean;
  contextTokens: number;
  tier: ModelTier;
  strengths: TaskType[];
}

export interface ModelRegistryEntry extends ModelCapabilities {
  id: string;
  ownedBy: string;
  displayName: string;
  curated: boolean;
  notes?: string;
}

export interface ModelHealthSnapshot {
  modelId: string;
  status: ModelStatus;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastProbeAt: number | null;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
  errorRate: number;
  consecutiveFailures: number;
  circuitOpenUntil: number | null;
  inCatalog: boolean;
}

export interface AnalysisResult {
  taskType: TaskType;
  complexity: Complexity;
  requiresTools: boolean;
  requiresVision: boolean;
  estimatedInputTokens: number;
  confidence: number;
  method: "heuristic" | "llm" | "forced";
}

export type RoutingRole =
  | "primary"
  | "retry"
  | "failover"
  | "continue"
  | "orchestrate"
  | "synthesis";

export interface RoutingAttempt {
  modelId: string;
  startedAt: number;
  endedAt: number;
  ttftMs: number | null;
  error: string | null;
  abandonedReason: string | null;
  role?: RoutingRole;
  inputTokens?: number;
  outputTokens?: number;
  label?: string;
}

export interface TokenRoutingSegment {
  modelId: string;
  role: RoutingRole;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  endedAt: number | null;
  status: "active" | "success" | "failed";
  label?: string;
  error?: string | null;
}

export interface RequestTrace {
  id: string;
  workspaceId: string;
  keyId: string | null;
  requestedModel: string;
  chosenModel: string | null;
  taskType: TaskType | null;
  complexity: Complexity | null;
  inputTokens: number;
  outputTokens: number;
  tokensEstimated: boolean;
  ttftMs: number | null;
  durationMs: number;
  outcome: RequestOutcome;
  attempts: RoutingAttempt[];
  segments?: TokenRoutingSegment[];
  createdAt: number;
}

export interface LiveRoutingSession {
  requestId: string;
  requestedModel: string;
  taskType: TaskType | null;
  complexity: Complexity | null;
  startedAt: number;
  endedAt: number | null;
  status: "active" | "done" | "error";
  segments: TokenRoutingSegment[];
  chosenModel: string | null;
}

export interface ApiKeyInfo {
  id: string;
  workspaceId: string;
  label: string;
  prefix: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  debugBodies: boolean;
}

export interface WorkspaceSettings {
  workspaceId: string;
  rpmLimit: number;
  dailyRequestLimit: number;
  probeRpmBudget: number;
  catalogPollMs: number;
  timeouts: {
    lightTtftMs: number;
    mediumTtftMs: number;
    heavyTtftMs: number;
    idleMs: number;
  };
  partialStreamBehavior: "continue" | "error";
  taskPreferences: Partial<Record<TaskType, string[]>>;
}

export interface OverviewStats {
  rpmUsed: number;
  rpmLimit: number;
  dailyRequests: number;
  dailyLimit: number;
  tokensIn: number;
  tokensOut: number;
  successRate: number;
  failovers: number;
  queueDepth: number;
  healthyModels: number;
  totalChatModels: number;
}

export interface SubtaskPlan {
  id: string;
  prompt: string;
  taskType: TaskType;
  complexity: Complexity;
  dependsOn: string[];
}

export interface OrchestratePlan {
  subtasks: SubtaskPlan[];
  synthesisPrompt: string;
}
