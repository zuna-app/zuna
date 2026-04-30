type Handler<P = unknown> = (payload: P) => void;
type HandlerSet = Set<Handler>;
type ServerRegistry = Map<string, HandlerSet>;

const registries = new Map<string, ServerRegistry>();

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
  return () => {
    set!.delete(handler as Handler);
  };
}

export function dispatch(serverId: string, type: string, payload: unknown): void {
  const reg = getRegistry(serverId);
  reg.get(type)?.forEach((h) => h(payload));
}