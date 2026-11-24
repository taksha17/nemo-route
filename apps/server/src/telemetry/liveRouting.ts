import type { LiveRoutingSession, TokenRoutingSegment } from "@nemo-route/shared";
import { globalBus } from "../admin/events.js";

const active = new Map<string, LiveRoutingSession>();
const recent: LiveRoutingSession[] = [];
const RECENT_LIMIT = 40;

export function beginLiveRouting(session: Omit<LiveRoutingSession, "segments" | "endedAt" | "status" | "chosenModel"> & {
  segments?: TokenRoutingSegment[];
}): LiveRoutingSession {
  const full: LiveRoutingSession = {
    ...session,
    segments: session.segments ?? [],
    endedAt: null,
    status: "active",
    chosenModel: null,
  };
  active.set(full.requestId, full);
  globalBus.emit("routing_live", { type: "start", session: full });
  return full;
}

export function upsertLiveSegment(
  requestId: string,
  segment: TokenRoutingSegment,
) {
  const session = active.get(requestId);
  if (!session) return;
  const idx = session.segments.findIndex(
    (s) =>
      s.modelId === segment.modelId &&
      s.startedAt === segment.startedAt &&
      s.role === segment.role,
  );
  if (idx >= 0) session.segments[idx] = segment;
  else session.segments.push(segment);
  globalBus.emit("routing_live", { type: "segment", requestId, segment, session });
}

export function finishLiveRouting(
  requestId: string,
  opts: {
    status: "done" | "error";
    chosenModel: string | null;
    segments?: TokenRoutingSegment[];
  },
) {
  const session = active.get(requestId);
  if (!session) return null;
  if (opts.segments) session.segments = opts.segments;
  session.status = opts.status;
  session.chosenModel = opts.chosenModel;
  session.endedAt = Date.now();
  active.delete(requestId);
  recent.unshift(session);
  if (recent.length > RECENT_LIMIT) recent.pop();
  globalBus.emit("routing_live", { type: "finish", session });
  return session;
}

export function listLiveRouting() {
  return {
    active: [...active.values()].sort((a, b) => b.startedAt - a.startedAt),
    recent: [...recent],
  };
}

export function getLiveRouting(requestId: string) {
  return active.get(requestId) ?? recent.find((r) => r.requestId === requestId) ?? null;
}
