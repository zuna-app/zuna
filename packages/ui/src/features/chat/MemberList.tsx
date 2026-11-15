import type { GroupMemberView, UserView } from "@zuna/core";
import { Crown, MessageCircle, UserRound } from "lucide-react";
import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar, BotBadge, PopupMenu, Tooltip, useContextMenu } from "@/components/ui";
import { nameColor } from "@/lib/format";
import { useApp } from "@/state/store";
import { t } from "@/lib/i18n";

const byName = (a: UserView, b: UserView) => a.displayName.localeCompare(b.displayName);

const MemberRow = memo(function MemberRow({ user, online }: { user: UserView; online: boolean }) {
  const menu = useContextMenu();
  const openProfile = () => useApp.getState().setOverlay({ type: "verify", userId: user.id });
  return (
    <>
      <button className={`member-item${online ? "" : " is-offline"}${menu.menu ? " is-menu-open" : ""}`} onClick={openProfile} onContextMenu={menu.open}>
        <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={32} online={online && !user.bot} />
        <span className="member-name truncate" style={{ color: nameColor(user.id) }}>
          {user.displayName}
        </span>
        {user.bot && <BotBadge />}
        {user.role === "owner" && (
          <Tooltip text={t("channels.members.owner")}>
            <Crown size={14} className="member-crown" aria-label={t("channels.members.owner")} />
          </Tooltip>
        )}
      </button>
      {menu.menu && (
        <PopupMenu
          x={menu.menu.x}
          y={menu.menu.y}
          onClose={menu.close}
          entries={[
            { label: t("channels.members.profile"), icon: <UserRound size={15} />, onSelect: openProfile },
            ...(user.isSelf ? [] : [{ label: t("channels.members.message"), icon: <MessageCircle size={15} />, onSelect: () => useApp.getState().selectConversation(`user:${user.id}`) }]),
          ]}
        />
      )}
    </>
  );
});

/**
 * Who can read a channel, which is everyone on the server, or only its admins and owner
 * when it's admin-only, as Discord lists them on the right: those online first, then the
 * rest, faded. A bot only reads the channels it was given, so the bots listed are the ones
 * in this channel, by themselves.
 */
export function MemberList({ members, groupId }: { members: GroupMemberView[]; groupId: string | null }) {
  const everyone = useApp(
    useShallow((state) => {
      const server = state.activeServerId ? state.servers[state.activeServerId] : undefined;
      const adminsOnly = !!server?.channels.find((channel) => channel.id === groupId)?.adminOnly;
      return Object.values(server?.users ?? {}).filter((user) => !user.banned && !user.deleted && (!adminsOnly || user.role !== "member"));
    }),
  );
  const [online, offline, bots] = useMemo(() => {
    const users = everyone.filter((user) => !user.bot);
    const here = users.filter((user) => user.online || user.isSelf).sort(byName);
    const inChannel = new Set(members.map((member) => member.userId));
    return [here, users.filter((user) => !here.includes(user)).sort(byName), everyone.filter((user) => user.bot && inChannel.has(user.id)).sort(byName)];
  }, [everyone, members]);
  return (
    <aside className="member-list" aria-label={t("channels.members.title")}>
      {bots.length > 0 && <h3 className="member-group">{t("channels.members.bots", { count: bots.length })}</h3>}
      {bots.map((user) => (
        <MemberRow key={user.id} user={user} online />
      ))}
      {online.length > 0 && <h3 className="member-group">{t("channels.members.online", { count: online.length })}</h3>}
      {online.map((user) => (
        <MemberRow key={user.id} user={user} online />
      ))}
      {offline.length > 0 && <h3 className="member-group">{t("channels.members.offline", { count: offline.length })}</h3>}
      {offline.map((user) => (
        <MemberRow key={user.id} user={user} online={false} />
      ))}
    </aside>
  );
}
