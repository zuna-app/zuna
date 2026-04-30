type Handler<P = unknown> = (payload: P) => void;
type HandlerSet = Set<Handler>;
type ServerRegistry = Map<string, HandlerSet>;

const registries = new Map<string, ServerRegistry>();

function wsRegistryDebug(serverId: string, event: string, details?: Record<string, unknown>) {
  if (!__DEV__) return;
  if (details) {
    console.debug(`[ws-registry:${serverId}] ${event}`, details);
    return;
  }
  console.debug(`[ws-registry:${serverId}] ${event}`);
}

function getRegistry(serverId: string): ServerRegistry {
  let reg = registries.get(serverId);
  if (!reg) {
    reg = new Map<string, HandlerSet>();
    registries.set(serverId, reg);
  }
  return reg;
}

export function registerHandler<P = unknown>(
  serverId: string,
  type: string,
  handler: Handler<P>,
): () => void {
  const reg = getRegistry(serverId);
  let set = reg.get(type);
  if (!set) {
    set = new Set<Handler>();
    reg.set(type, set);
  }
  set.add(handler as Handler);
  wsRegistryDebug(serverId, 'handler registered', { type, total: set.size });
  return () => {
    set!.delete(handler as Handler);
    wsRegistryDebug(serverId, 'handler unregistered', { type, total: set!.size });
  };
}

export function dispatch(serverId: string, type: string, payload: unknown): void {
  const reg = getRegistry(serverId);
  const handlers = reg.get(type);
  wsRegistryDebug(serverId, 'dispatch', { type, handlers: handlers?.size ?? 0 });
  handlers?.forEach((h) => h(payload));
}
