import type { UserView } from "@zuna/core";
import { Crown, MessageCircle, UserRound } from "lucide-react";
import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar, PopupMenu, Tooltip, useContextMenu } from "@/components/ui";
import { nameColor } from "@/lib/format";
import { useApp } from "@/state/store";

const byName = (a: UserView, b: UserView) => a.displayName.localeCompare(b.displayName);

const MemberRow = memo(function MemberRow({ user, online }: { user: UserView; online: boolean }) {
  const menu = useContextMenu();
  const openProfile = () => useApp.getState().setOverlay({ type: "verify", userId: user.id });
  return (
    <>
      <button className={`member-item${online ? "" : " is-offline"}${menu.menu ? " is-menu-open" : ""}`} onClick={openProfile} onContextMenu={menu.open}>
        <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={32} online={online} />
        <span className="member-name truncate" style={{ color: nameColor(user.id) }}>
          {user.displayName}
        </span>
        {user.role === "owner" && (
          <Tooltip text="Server owner">
            <Crown size={14} className="member-crown" aria-label="Server owner" />
          </Tooltip>
        )}
      </button>
      {menu.menu && (
        <PopupMenu
          x={menu.menu.x}
          y={menu.menu.y}
          onClose={menu.close}
          entries={[
            { label: "Profile", icon: <UserRound size={15} />, onSelect: openProfile },
            ...(user.isSelf ? [] : [{ label: "Message", icon: <MessageCircle size={15} />, onSelect: () => useApp.getState().selectConversation(`user:${user.id}`) }]),
          ]}
        />
      )}
    </>
  );
});

/**
 * Who can read a channel, which is everyone on the server, as Discord lists them on
 * the right: those online first, then the rest, faded.
 */
export function MemberList() {
  const users = useApp(
    useShallow((state) => {
      const server = state.activeServerId ? state.servers[state.activeServerId] : undefined;
      return Object.values(server?.users ?? {}).filter((user) => !user.banned && !user.deleted);
    }),
  );
  const [online, offline] = useMemo(() => {
    const here = users.filter((user) => user.online || user.isSelf).sort(byName);
    return [here, users.filter((user) => !here.includes(user)).sort(byName)];
  }, [users]);
  return (
    <aside className="member-list" aria-label="Members">
      {online.length > 0 && <h3 className="member-group">Online — {online.length}</h3>}
      {online.map((user) => (
        <MemberRow key={user.id} user={user} online />
      ))}
      {offline.length > 0 && <h3 className="member-group">Offline — {offline.length}</h3>}
      {offline.map((user) => (
        <MemberRow key={user.id} user={user} online={false} />
      ))}
    </aside>
  );
}
