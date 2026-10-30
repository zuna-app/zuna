import { Plus, Settings } from "lucide-react";
import { memo } from "react";
import { Avatar, Tooltip } from "@/components/ui";
import { useApp, type ServerState } from "@/state/store";

const ServerButton = memo(function ServerButton({ serverId, server, active }: { serverId: string; server: ServerState; active: boolean }) {
  const select = useApp((state) => state.selectServer);
  const unread = server.conversations.reduce((sum, item) => sum + (item.muted ? 0 : item.unread), 0);
  const { entry } = server;
  return (
    <div className={`rail-item${active ? " is-active" : ""}${unread > 0 ? " has-unread" : ""}`}>
      <span className="rail-pill" />
      <Tooltip text={entry.name} side="right">
        <button className={`rail-button${active ? " is-active" : ""}`} onClick={() => select(serverId)} aria-label={entry.name} aria-current={active}>
          <Avatar name={entry.name} seed={entry.url} size={42} rounded serverId={serverId} imageUrl={entry.hasIcon ? `${entry.url}/api/icon` : null} />
        </button>
      </Tooltip>
      {!active && unread > 0 && <span className="rail-badge">{unread > 99 ? "99+" : unread}</span>}
    </div>
  );
});

export function ServerRail() {
  const order = useApp((state) => state.order);
  const servers = useApp((state) => state.servers);
  const activeServerId = useApp((state) => state.activeServerId);
  const setOverlay = useApp((state) => state.setOverlay);
  const active = activeServerId ? servers[activeServerId] : null;
  const selfUser = active?.self ? active.users[active.self.userId] : null;

  return (
    <nav className="rail" aria-label="Servers">
      <div className="rail-list">
        {order.map((id) => servers[id] && <ServerButton key={id} serverId={id} server={servers[id]!} active={id === activeServerId} />)}
        <Tooltip text="Join a server" side="right">
          <button className="rail-add" onClick={() => setOverlay({ type: "add-server" })} aria-label="Join a server">
            <Plus size={20} />
          </button>
        </Tooltip>
      </div>
      <div className="rail-footer">
        <Tooltip text="Settings" side="right">
          <button className="icon-btn" onClick={() => setOverlay({ type: "settings" })} aria-label="Settings">
            <Settings size={19} />
          </button>
        </Tooltip>
        {selfUser && (
          <Tooltip text={selfUser.displayName} side="right">
            <button onClick={() => setOverlay({ type: "settings", section: "profile" })} aria-label="Your profile" className="rail-self">
              <Avatar name={selfUser.displayName} seed={selfUser.id} avatar={selfUser.avatar} size={32} />
            </button>
          </Tooltip>
        )}
      </div>
    </nav>
  );
}
