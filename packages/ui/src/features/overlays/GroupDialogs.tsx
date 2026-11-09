// Making a group, adding people to one, and forwarding messages, with the list of people they
// pick from.

import type { UserView } from "@zuna/core";
import { Check, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Avatar, BotBadge, Confirm, Field, Modal, Spinner, Switch, useAction } from "@/components/ui";
import { BOT_READS, mayAddBot } from "@/lib/bots";
import { useActiveServer, useApp } from "@/state/store";

/** What adding a bot means, asked before it's added, each time one is. */
function AddBotConfirm({ bots, onCancel, onConfirm }: { bots: UserView[]; onCancel: () => void; onConfirm: () => void }) {
  const names = bots.map((bot) => bot.displayName).join(", ");
  return (
    <Confirm title={bots.length === 1 ? `Add the bot ${names}?` : `Add the bots ${names}?`} action={bots.length === 1 ? "Add the bot" : "Add the bots"} onCancel={onCancel} onConfirm={onConfirm}>
      {BOT_READS}
    </Confirm>
  );
}

/**
 * Where to forward a message: any chat on any server, this one first. Picking
 * one sends it there and opens it, as Telegram's desktop app does.
 */
export function ForwardPicker({ serverId, groupId, ids, onClose }: { serverId: string; groupId: string; ids: string[]; onClose: () => void }) {
  const servers = useApp((state) => state.servers);
  const order = useApp((state) => state.order);
  const toast = useApp((state) => state.toast);
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const sections = [serverId, ...order.filter((id) => id !== serverId)]
    .map((id) => servers[id])
    .filter((server): server is NonNullable<typeof server> => !!server)
    .map((server) => ({
      server,
      chats: [...server.conversations, ...server.channels.flatMap((channel) => channel.conversation ?? [])].filter((chat) => !server.prefs.hidden.includes(chat.key) && (!needle || chat.title.toLowerCase().includes(needle))),
    }))
    .filter((section) => section.chats.length > 0);

  const forward = async (toServerId: string, key: string) => {
    setSending(`${toServerId}/${key}`);
    try {
      await useApp.getState().core!.client.forwardMessages(serverId, groupId, ids, toServerId, key);
      const state = useApp.getState();
      state.toggleSelected("", null);
      if (state.activeServerId !== toServerId) state.selectServer(toServerId);
      useApp.getState().selectConversation(key);
      onClose();
    } catch (error) {
      toast((error as Error).message, "error");
      setSending(null);
    }
  };

  return (
    <Modal title="Forward to" onClose={onClose}>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder="Search chats" value={query} autoFocus onChange={(event) => setQuery(event.target.value)} aria-label="Search chats" />
      </div>
      <div className="people-list forward-list">
        {sections.map(({ server, chats }) => (
          <div key={server.entry.id} className="forward-section">
            {sections.length > 1 || server.entry.id !== serverId ? <span className="forward-server">{server.entry.name}</span> : null}
            {chats.map((chat) => {
              const id = `${server.entry.id}/${chat.key}`;
              return (
                <button key={id} className="person-row" disabled={sending !== null} onClick={() => void forward(server.entry.id, chat.key)}>
                  <Avatar name={chat.title} seed={chat.peerId ?? chat.groupId ?? chat.key} avatar={chat.avatar} size={36} />
                  <span className="grow truncate" style={{ fontWeight: 550 }}>{chat.title}</span>
                  {sending === id && <Spinner size={14} />}
                </button>
              );
            })}
          </div>
        ))}
        {sections.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 16 }}>No chats match that search.</p>}
      </div>
    </Modal>
  );
}

function PeoplePicker({ users, selected, onToggle }: { users: UserView[]; selected: Set<string>; onToggle: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => users.filter((user) => !needle || user.displayName.toLowerCase().includes(needle) || user.username.toLowerCase().includes(needle)),
    [users, needle],
  );
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder="Search people" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search people" />
      </div>
      <div className="people-list">
        {filtered.map((user) => (
          <button key={user.id} className={`person-row${selected.has(user.id) ? " is-selected" : ""}`} onClick={() => onToggle(user.id)} role="checkbox" aria-checked={selected.has(user.id)}>
            <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={36} online={user.online} />
            <span className="grow">
              <span className="truncate" style={{ display: "block", fontWeight: 550 }}>{user.displayName}{user.bot && <> <BotBadge /></>}</span>
              <span className="faint truncate" style={{ display: "block", fontSize: 12 }}>@{user.username}</span>
            </span>
            <span className="person-check">{selected.has(user.id) && <Check size={13} strokeWidth={3} />}</span>
          </button>
        ))}
        {filtered.length === 0 && <p className="muted" style={{ textAlign: "center", padding: 16 }}>Nobody matches that search.</p>}
      </div>
    </div>
  );
}

export function NewGroup({ onClose }: { onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const selectConversation = useApp((state) => state.selectConversation);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [history, setHistory] = useState(false);
  const [asking, setAsking] = useState(false);
  const { busy, run } = useAction();
  const selfId = server?.self?.userId;
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";
  // Of the bots, only the ones this person may add.
  const users = Object.values(server?.users ?? {})
    .filter((user) => user.id !== selfId && !user.banned && !user.deleted && mayAddBot(user, selfId, isAdmin))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const bots = users.filter((user) => user.bot && selected.has(user.id));

  const create = () =>
    run(async () => {
      const groupId = await session().createGroup(name.trim(), [...selected], history);
      selectConversation(`group:${groupId}`);
      onClose();
    });

  return (
    <Modal
      title="New group"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={() => (bots.length > 0 ? setAsking(true) : void create())}>
            {busy ? <Spinner /> : `Create${selected.size ? ` with ${selected.size + 1} people` : ""}`}
          </button>
        </>
      }
    >
      <Field label="Group name" placeholder="Weekend trip" value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} />
      <div className="field">
        <span className="field-label">Invite people</span>
        <PeoplePicker
          users={users}
          selected={selected}
          onToggle={(id) => {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelected(next);
          }}
        />
      </div>
      <div className="setting-row">
        <span className="grow">
          <b>New members can read earlier messages</b>
          <span className="setting-hint">If off, people only see what's sent after they join.</span>
        </span>
        <Switch on={history} onChange={setHistory} label="New members can read earlier messages" />
      </div>
      {asking && (
        <AddBotConfirm
          bots={bots}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void create();
          }}
        />
      )}
    </Modal>
  );
}

export function AddMembers({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const [selected, setSelected] = useState(new Set<string>());
  const [asking, setAsking] = useState(false);
  const { busy, run } = useAction();
  const conversation = server?.conversations.find((item) => item.groupId === groupId);
  const memberIds = new Set(conversation?.members.map((member) => member.userId));
  const selfId = server?.self?.userId;
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";
  // Of the bots, only the ones this person may add.
  const users = Object.values(server?.users ?? {})
    .filter((user) => !memberIds.has(user.id) && !user.banned && !user.deleted && mayAddBot(user, selfId, isAdmin))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const bots = users.filter((user) => user.bot && selected.has(user.id));
  const add = () =>
    run(async () => {
      await session().addMembers(groupId, [...selected]);
      onClose();
    });

  return (
    <Modal
      title="Add people"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={selected.size === 0 || busy}
            onClick={() => (bots.length > 0 ? setAsking(true) : void add())}
          >
            {busy ? <Spinner /> : "Add"}
          </button>
        </>
      }
    >
      {conversation?.historyVisible && (
        <div className="notice">
          <UsersRound size={15} />
          <span>This group shares its history, so they'll be able to read earlier messages. A bot never gets them.</span>
        </div>
      )}
      {asking && (
        <AddBotConfirm
          bots={bots}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            void add();
          }}
        />
      )}
      {users.length === 0 ? (
        <p className="muted" style={{ textAlign: "center", padding: 16 }}>Everyone on this server is already here.</p>
      ) : (
        <PeoplePicker
          users={users}
          selected={selected}
          onToggle={(id) => {
            const next = new Set(selected);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelected(next);
          }}
        />
      )}
    </Modal>
  );
}
