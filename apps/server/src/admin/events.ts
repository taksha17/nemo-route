type Handler = (payload: unknown) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload: unknown) {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        h(payload);
      } catch {
        // ignore listener errors
      }
    }
    for (const h of this.handlers.get("*") ?? []) {
      try {
        h({ event, payload });
      } catch {
        // ignore
      }
    }
  }
}

export const globalBus = new EventBus();
