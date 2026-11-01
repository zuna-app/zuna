import { Plus, Settings } from "lucide-react";
import { motion, Reorder } from "motion/react";
import { memo, useRef, type RefObject } from "react";
import { Avatar, Tooltip } from "@/components/ui";
import { countedUnread, useApp } from "@/state/store";

const ServerButton = memo(function ServerButton({ serverId, dragged }: { serverId: string; dragged: RefObject<boolean> }) {
  const select = useApp((state) => state.selectServer);
  const server = useApp((state) => state.servers[serverId]);
  const active = useApp((state) => state.activeServerId === serverId);
  if (!server) return null;
  const unread = server.conversations.reduce((sum, item) => sum + countedUnread(item), 0);
  const { entry } = server;
  return (
    <div className={`rail-item${active ? " is-active" : ""}${unread > 0 ? " has-unread" : ""}`}>
      <span className="rail-pill" />
      <Tooltip text={entry.name} side="right">
        <button
          className={`rail-button${active ? " is-active" : ""}`}
          // Letting go of a drag clicks the button it started on, and that isn't asking to switch.
          onClick={(event) => {
            if (!dragged.current || event.detail === 0) select(serverId);
          }}
          aria-label={entry.name}
          aria-current={active}
        >
          <Avatar name={entry.name} seed={entry.url} size={42} rounded serverId={serverId} imageUrl={entry.hasIcon ? `${entry.url}/api/icon` : null} />
        </button>
      </Tooltip>
      {!active && unread > 0 && <span className="rail-badge">{unread > 99 ? "99+" : unread}</span>}
    </div>
  );
});

/** Apart from the button, so a new message doesn't make Motion measure the rail again. */
const ServerEntry = memo(function ServerEntry({ serverId }: { serverId: string }) {
  const saveServerOrder = useApp((state) => state.saveServerOrder);
  const dragged = useRef(false);
  return (
    <Reorder.Item
      as="div"
      className="rail-entry"
      value={serverId}
      onPointerDown={() => (dragged.current = false)}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={() => saveServerOrder()}
    >
      <ServerButton serverId={serverId} dragged={dragged} />
    </Reorder.Item>
  );
});

export function ServerRail() {
  const order = useApp((state) => state.order);
  const servers = useApp((state) => state.servers);
  const activeServerId = useApp((state) => state.activeServerId);
  const setOverlay = useApp((state) => state.setOverlay);
  const setServerOrder = useApp((state) => state.setServerOrder);
  const active = activeServerId ? servers[activeServerId] : null;
  const selfUser = active?.self ? active.users[active.self.userId] : null;

  return (
    <nav className="rail" aria-label="Servers">
      <motion.div className="rail-list" layoutScroll>
        <Reorder.Group as="div" className="rail-servers" axis="y" values={order} onReorder={setServerOrder}>
          {order.map((id) => (
            <ServerEntry key={id} serverId={id} />
          ))}
        </Reorder.Group>
        <Tooltip text="Join a server" side="right">
          <button className="rail-add" onClick={() => setOverlay({ type: "add-server" })} aria-label="Join a server">
            <Plus size={20} />
          </button>
        </Tooltip>
      </motion.div>
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
