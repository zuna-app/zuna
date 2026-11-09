// A server's bots, in its settings: making one, the link its program is set up with,
// what it may do, the channels it's given, and taking it away. A bot is its owner's, and
// a listed one is also the server's admins' to give channels to or delete.

import type { BotAdd, BotView } from "@zuna/core";
import { Bot, Copy, Image as ImageIcon, MessageCircle, Plus, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, BotBadge, Confirm, Field, Spinner, Switch, useAction } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { prepareAvatar } from "@/lib/media";
import { useActiveServer, useApp } from "@/state/store";
import { SettingRow } from "@/features/overlays/Settings";

const ADD_LABELS: Record<BotAdd, string> = {
  owner: "Only its owner",
  admins: "Its owner and the server's admins",
  anyone: "Anyone on the server",
};

const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,31}$/;

/** The link a bot's program is set up with, shown once, with what to do with it. */
function SetupLink({ link, onDone }: { link: string; onDone: () => void }) {
  const toast = useApp((state) => state.toast);
  const command = `zuna-bot init "${link}"`;
  return (
    <div className="bot-setup">
      <div className="notice">
        <Terminal size={15} />
        <span>
          Set the bot up on the machine that will run it, within the hour. Its keys are made there, so not even you hold them. This link works once, and this is the only time it's shown.
        </span>
      </div>
      <div className="invite-link">
        <span className="mono truncate selectable">{command}</span>
        <button
          className="icon-btn is-small"
          onClick={() => void copyText(command).then(() => toast("Command copied"))}
          aria-label="Copy the command"
        >
          <Copy size={14} />
        </button>
      </div>
      <p className="setting-hint">
        Then start it with <span className="mono">zuna-bot run</span>. Whichever machine runs a bot can read that bot's chats.
      </p>
      <div>
        <button className="btn btn-small" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function NewBot({ canList, onCreated, onCancel }: { canList: boolean; onCreated: (link: string) => void; onCancel: () => void }) {
  const session = useApp((state) => state.session);
  const { busy, run } = useAction();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [listed, setListed] = useState(false);
  const [add, setAdd] = useState<BotAdd>("owner");
  const [files, setFiles] = useState(true);
  const valid = name.trim() !== "" && USERNAME.test(username);
  return (
    <div className="bot-form">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow">
          <Field label="Name" placeholder="Weather" value={name} maxLength={64} autoFocus onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="grow">
          <Field
            label="Username"
            placeholder="weather"
            value={username}
            maxLength={32}
            error={username && !USERNAME.test(username) ? "2 to 32 letters, numbers, dots, dashes and underscores." : null}
            onChange={(event) => setUsername(event.target.value.trim())}
          />
        </div>
      </div>
      {canList && (
        <SettingRow title="List it for everyone" hint="If off, it's private: only you see it, and whoever is in a chat with it. Other admins don't.">
          <Switch on={listed} onChange={setListed} label="List it for everyone" />
        </SettingRow>
      )}
      {listed && (
        <SettingRow title="Who can add it to groups">
          <select className="select" style={{ width: 250 }} value={add} onChange={(event) => setAdd(event.target.value as BotAdd)} aria-label="Who can add it to groups">
            {(Object.keys(ADD_LABELS) as BotAdd[]).map((value) => <option key={value} value={value}>{ADD_LABELS[value]}</option>)}
          </select>
        </SettingRow>
      )}
      <SettingRow title="Let it send files" hint="Within the server's limit on a file's size.">
        <Switch on={files} onChange={setFiles} label="Let it send files" />
      </SettingRow>
      <div className="row">
        <button
          className="btn btn-primary"
          disabled={!valid || busy}
          onClick={() =>
            run(async () => {
              const created = await session().createBot({ username, name: name.trim(), listed, add: listed ? add : "owner", files });
              onCreated(created.link);
            })
          }
        >
          {busy ? <Spinner /> : "Make the bot"}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** One bot's settings, under its row. */
function BotSettings({ bot, onChanged, onLink, onClose }: { bot: BotView; onChanged: () => void; onLink: (link: string) => void; onClose: () => void }) {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const selectConversation = useApp((state) => state.selectConversation);
  const setOverlay = useApp((state) => state.setOverlay);
  const toast = useApp((state) => state.toast);
  const { busy, run } = useAction();
  const user = server?.users[bot.id];
  const [name, setName] = useState(user?.displayName ?? bot.username);
  const [bio, setBio] = useState(user?.bio ?? "");
  const [deleting, setDeleting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!server) return null;
  const own = bot.ownerId === server.self?.userId;
  const isAdmin = server.self?.role === "owner" || server.self?.role === "admin";
  const textChannels = server.channels.filter((channel) => channel.type === "text" && !channel.unreadable);
  const change = (changes: Parameters<ReturnType<typeof session>["updateBot"]>[1]) => void run(async () => {
    await session().updateBot(bot.id, changes);
    onChanged();
  });

  return (
    <div className="bot-settings">
      {!bot.setUp ? (
        <>
          <p className="setting-hint">Its program hasn't been set up yet. If the link ran out or was lost, a new one ends the one before.</p>
          <div className="row">
            <button className="btn btn-small" disabled={busy || !own} onClick={() => void run(async () => onLink(await session().newBotLink(bot.id)))}>
              <RefreshCw size={13} /> New setup link
            </button>
          </div>
        </>
      ) : own ? (
        <>
          <div className="profile-edit">
            <button className="server-icon-edit" onClick={() => fileInput.current?.click()} aria-label="Change the bot's picture">
              <Avatar name={user?.displayName ?? bot.username} seed={bot.id} avatar={user?.avatar ?? null} size={56} />
              <span><ImageIcon size={16} /></span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void run(async () => {
                  await session().updateBotProfile(bot.id, {}, await prepareAvatar(file, 256));
                  toast("Sent to the bot, which sets it when it's running");
                });
                event.target.value = "";
              }}
            />
            <div className="col grow" style={{ gap: 8 }}>
              <Field label="Name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
              <Field label="About" value={bio} maxLength={300} placeholder="What it does" onChange={(event) => setBio(event.target.value)} />
            </div>
          </div>
          <div className="row">
            <button
              className="btn btn-small btn-primary"
              disabled={busy || !name.trim() || (name === (user?.displayName ?? "") && bio === (user?.bio ?? ""))}
              onClick={() => void run(async () => {
                await session().updateBotProfile(bot.id, { displayName: name.trim(), bio: bio.trim() });
                toast("Sent to the bot, which sets it when it's running");
              })}
            >
              Save
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                selectConversation(`user:${bot.id}`);
                setOverlay(null);
              }}
            >
              <MessageCircle size={13} /> Message
            </button>
          </div>
          <SettingRow title="List it for everyone" hint={isAdmin || bot.listed ? "If off, it's private: only you see it, and whoever is in a chat with it. It leaves its channels." : "Only the server's admins can list a bot."}>
            <Switch on={bot.listed} onChange={(listed) => (isAdmin || !listed ? change({ listed }) : undefined)} label="List it for everyone" />
          </SettingRow>
          {bot.listed && (
            <SettingRow title="Who can add it to groups">
              <select className="select" style={{ width: 250 }} value={bot.add} onChange={(event) => change({ add: event.target.value as BotAdd })} aria-label="Who can add it to groups">
                {(Object.keys(ADD_LABELS) as BotAdd[]).map((value) => <option key={value} value={value}>{ADD_LABELS[value]}</option>)}
              </select>
            </SettingRow>
          )}
          <SettingRow title="Let it send files">
            <Switch on={bot.files} onChange={(files) => change({ files })} label="Let it send files" />
          </SettingRow>
        </>
      ) : null}
      {bot.setUp && bot.listed && isAdmin && textChannels.length > 0 && (
        <div className="field">
          <span className="field-label">Channels</span>
          <span className="setting-hint">It joins the ones it's given, and reads what's said there from then on.</span>
          <div className="bot-channels">
            {textChannels.map((channel) => {
              const given = bot.channels.includes(channel.id);
              return (
                <label key={channel.id} className="bot-channel">
                  <input
                    type="checkbox"
                    checked={given}
                    disabled={busy}
                    onChange={() => void run(async () => {
                      await session().setBotChannels(bot.id, given ? bot.channels.filter((id) => id !== channel.id) : [...bot.channels, channel.id]);
                      onChanged();
                    })}
                  />
                  <span className="truncate"># {channel.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      <div className="row">
        <button className="btn btn-small btn-danger" disabled={busy} onClick={() => setDeleting(true)}>
          <Trash2 size={13} /> Delete bot
        </button>
      </div>
      {deleting && (
        <Confirm
          title={`Delete ${user?.displayName ?? bot.username}?`}
          action="Delete bot"
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void run(async () => {
              await session().deleteBot(bot.id);
              onClose();
              onChanged();
            });
          }}
        >
          {bot.setUp ? "It's signed out and taken out of every chat it's in. What it sent stays with the people it sent it to. It can't be undone." : "Its setup link stops working."}
        </Confirm>
      )}
    </div>
  );
}

export function BotsSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const [bots, setBots] = useState<BotView[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { run } = useAction();
  // Read again whenever a bot is set up, changed or gone, from here or anywhere else.
  const known = Object.values(server?.users ?? {})
    .filter((user) => user.bot)
    .map((user) => `${user.id}:${user.deleted}:${user.bot!.listed}:${user.bot!.add}`)
    .sort()
    .join();
  const load = useCallback(() => {
    void session()
      .getBots()
      .then(setBots)
      .catch(() => setBots([]));
  }, [session]);
  useEffect(load, [load, known]);
  if (!server) return null;
  const selfId = server.self?.userId;
  const isAdmin = server.self?.role === "owner" || server.self?.role === "admin";
  const mayMake = isAdmin || !!server.info?.allow_member_bots;
  const mine = (bots ?? []).filter((bot) => bot.ownerId === selfId).length;
  const most = server.info?.max_bots ?? 5;

  return (
    <>
      <h1>Bots</h1>
      <p className="settings-lead">
        A bot is an account a program runs, on a machine its owner chooses. It reads everything said in the chats it's in, from when it was added, and shows a <BotBadge /> wherever its name does.
      </p>
      {link ? (
        <SetupLink link={link} onDone={() => setLink(null)} />
      ) : creating ? (
        <NewBot
          canList={isAdmin}
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setLink(created);
            load();
          }}
        />
      ) : mayMake ? (
        <div>
          <button className="btn btn-primary" disabled={mine >= most} onClick={() => setCreating(true)}>
            <Plus size={15} /> New bot
          </button>
          {mine >= most && <p className="setting-hint" style={{ marginTop: 6 }}>You have as many bots as this server lets one person have.</p>}
        </div>
      ) : (
        <div className="notice">
          <Bot size={15} />
          <span>On this server, only admins can make bots.</span>
        </div>
      )}
      {bots === null ? (
        <Spinner />
      ) : bots.length === 0 ? (
        <p className="muted">No bots yet.</p>
      ) : (
        <div className="device-list">
          {bots.map((bot) => {
            const user = server.users[bot.id];
            const name = user?.displayName ?? bot.username;
            const owner = bot.ownerId === selfId ? null : server.users[bot.ownerId]?.displayName;
            return (
              <div key={bot.id} className="bot-entry">
                <button className="device-row is-button" onClick={() => setOpen(open === bot.id ? null : bot.id)} aria-expanded={open === bot.id}>
                  <Avatar name={name} seed={bot.id} avatar={user?.avatar ?? null} size={36} />
                  <span className="grow">
                    <span style={{ display: "block", fontWeight: 500 }}>{name}</span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      @{bot.username}
                      {owner && ` · ${owner}'s`}
                    </span>
                  </span>
                  <span className="role-chip">{!bot.setUp ? "Waiting to be set up" : bot.listed ? "Listed" : "Private"}</span>
                </button>
                {open === bot.id && <BotSettings bot={bot} onChanged={load} onLink={setLink} onClose={() => setOpen(null)} />}
              </div>
            );
          })}
        </div>
      )}
      {isAdmin && (
        <>
          <div className="settings-divider" />
          <SettingRow title="Let members make private bots" hint="If off, only admins make bots. Only admins ever make listed ones.">
            <Switch on={server.info?.allow_member_bots ?? false} onChange={(value) => void run(() => session().updateServerSettings({ allow_member_bots: value }))} label="Let members make private bots" />
          </SettingRow>
          <SettingRow title="Bots each person can have">
            <select className="select" style={{ width: 90 }} value={most} onChange={(event) => void run(() => session().updateServerSettings({ max_bots: Number(event.target.value) }))} aria-label="Bots each person can have">
              {[...new Set([1, 3, 5, 10, 25, most])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </SettingRow>
        </>
      )}
    </>
  );
}
