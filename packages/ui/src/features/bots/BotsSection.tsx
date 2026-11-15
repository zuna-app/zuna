// A server's bots, in its settings: making one, the link its program is set up with,
// what it may do, the channels it's given, and taking it away. A bot is its owner's, and
// a listed one is also the server's admins' to give channels to or delete.

import type { BotAdd, BotView } from "@zuna/core";
import { Bot, Copy, Image as ImageIcon, MessageCircle, Plus, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, BotBadge, Confirm, Field, Spinner, Switch, useAction } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { mark, t, tx, type MessageKey } from "@/lib/i18n";
import { prepareAvatar } from "@/lib/media";
import { useActiveServer, useApp } from "@/state/store";
import { SettingRow } from "@/features/overlays/Settings";

const ADD_LABELS: Record<BotAdd, MessageKey> = {
  owner: mark("bots.add.owner"),
  admins: mark("bots.add.admins"),
  anyone: mark("bots.add.anyone"),
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
        <span>{t("bots.setup.note")}</span>
      </div>
      <div className="invite-link">
        <span className="mono truncate selectable">{command}</span>
        <button
          className="icon-btn is-small"
          onClick={() => void copyText(command).then(() => toast(t("bots.setup.copied")))}
          aria-label={t("bots.setup.copy")}
        >
          <Copy size={14} />
        </button>
      </div>
      <p className="setting-hint">{tx("bots.setup.then", { command: <span className="mono">zuna-bot run</span> })}</p>
      <div>
        <button className="btn btn-small" onClick={onDone}>{t("common.done")}</button>
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
          <Field label={t("common.name")} placeholder={t("bots.new.namePlaceholder")} value={name} maxLength={64} autoFocus onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="grow">
          <Field
            label={t("common.username")}
            placeholder={t("bots.new.usernamePlaceholder")}
            value={username}
            maxLength={32}
            error={username && !USERNAME.test(username) ? t("bots.new.usernameInvalid") : null}
            onChange={(event) => setUsername(event.target.value.trim())}
          />
        </div>
      </div>
      {canList && (
        <SettingRow title={t("bots.list")} hint={t("bots.listHintNew")}>
          <Switch on={listed} onChange={setListed} label={t("bots.list")} />
        </SettingRow>
      )}
      {listed && (
        <SettingRow title={t("bots.whoCanAdd")}>
          <select className="select" style={{ width: 250 }} value={add} onChange={(event) => setAdd(event.target.value as BotAdd)} aria-label={t("bots.whoCanAdd")}>
            {(Object.keys(ADD_LABELS) as BotAdd[]).map((value) => <option key={value} value={value}>{t(ADD_LABELS[value])}</option>)}
          </select>
        </SettingRow>
      )}
      <SettingRow title={t("bots.files")} hint={t("bots.filesHint")}>
        <Switch on={files} onChange={setFiles} label={t("bots.files")} />
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
          {busy ? <Spinner /> : t("bots.new.create")}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
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
  // A bot is never one of the server's admins, so admin-only channels aren't for it.
  const textChannels = server.channels.filter((channel) => channel.type === "text" && !channel.unreadable && !channel.adminOnly);
  const change = (changes: Parameters<ReturnType<typeof session>["updateBot"]>[1]) => void run(async () => {
    await session().updateBot(bot.id, changes);
    onChanged();
  });

  return (
    <div className="bot-settings">
      {!bot.setUp ? (
        <>
          <p className="setting-hint">{t("bots.settings.notSetUp")}</p>
          <div className="row">
            <button className="btn btn-small" disabled={busy || !own} onClick={() => void run(async () => onLink(await session().newBotLink(bot.id)))}>
              <RefreshCw size={13} /> {t("bots.settings.newLink")}
            </button>
          </div>
        </>
      ) : own ? (
        <>
          <div className="profile-edit">
            <button className="server-icon-edit" onClick={() => fileInput.current?.click()} aria-label={t("bots.settings.changePicture")}>
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
                  toast(t("bots.settings.sentToBot"));
                });
                event.target.value = "";
              }}
            />
            <div className="col grow" style={{ gap: 8 }}>
              <Field label={t("common.name")} value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
              <Field label={t("bots.settings.about")} value={bio} maxLength={300} placeholder={t("bots.settings.aboutPlaceholder")} onChange={(event) => setBio(event.target.value)} />
            </div>
          </div>
          <div className="row">
            <button
              className="btn btn-small btn-primary"
              disabled={busy || !name.trim() || (name === (user?.displayName ?? "") && bio === (user?.bio ?? ""))}
              onClick={() => void run(async () => {
                await session().updateBotProfile(bot.id, { displayName: name.trim(), bio: bio.trim() });
                toast(t("bots.settings.sentToBot"));
              })}
            >
              {t("common.save")}
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                selectConversation(`user:${bot.id}`);
                setOverlay(null);
              }}
            >
              <MessageCircle size={13} /> {t("bots.settings.message")}
            </button>
          </div>
          <SettingRow title={t("bots.list")} hint={isAdmin || bot.listed ? t("bots.listHint") : t("bots.listAdminsOnly")}>
            <Switch on={bot.listed} onChange={(listed) => (isAdmin || !listed ? change({ listed }) : undefined)} label={t("bots.list")} />
          </SettingRow>
          {bot.listed && (
            <SettingRow title={t("bots.whoCanAdd")}>
              <select className="select" style={{ width: 250 }} value={bot.add} onChange={(event) => change({ add: event.target.value as BotAdd })} aria-label={t("bots.whoCanAdd")}>
                {(Object.keys(ADD_LABELS) as BotAdd[]).map((value) => <option key={value} value={value}>{t(ADD_LABELS[value])}</option>)}
              </select>
            </SettingRow>
          )}
          <SettingRow title={t("bots.files")}>
            <Switch on={bot.files} onChange={(files) => change({ files })} label={t("bots.files")} />
          </SettingRow>
        </>
      ) : null}
      {bot.setUp && bot.listed && isAdmin && textChannels.length > 0 && (
        <div className="field">
          <span className="field-label">{t("bots.settings.channels")}</span>
          <span className="setting-hint">{t("bots.settings.channelsHint")}</span>
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
          <Trash2 size={13} /> {t("bots.settings.delete")}
        </button>
      </div>
      {deleting && (
        <Confirm
          title={t("bots.settings.deleteTitle", { name: user?.displayName ?? bot.username })}
          action={t("bots.settings.delete")}
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
          {bot.setUp ? t("bots.settings.deleteSetUp") : t("bots.settings.deleteNotSetUp")}
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
      <h1>{t("serverSettings.sections.bots")}</h1>
      <p className="settings-lead">{tx("bots.leadWithBadge", { badge: <BotBadge /> })}</p>
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
            <Plus size={15} /> {t("bots.new.button")}
          </button>
          {mine >= most && <p className="setting-hint" style={{ marginTop: 6 }}>{t("bots.limitReached")}</p>}
        </div>
      ) : (
        <div className="notice">
          <Bot size={15} />
          <span>{t("bots.adminsOnly")}</span>
        </div>
      )}
      {bots === null ? (
        <Spinner />
      ) : bots.length === 0 ? (
        <p className="muted">{t("bots.empty")}</p>
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
                      {owner && ` · ${t("bots.ownedBy", { owner })}`}
                    </span>
                  </span>
                  <span className="role-chip">{!bot.setUp ? t("bots.status.waiting") : bot.listed ? t("bots.status.listed") : t("bots.status.private")}</span>
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
          <SettingRow title={t("bots.memberBots")} hint={t("bots.memberBotsHint")}>
            <Switch on={server.info?.allow_member_bots ?? false} onChange={(value) => void run(() => session().updateServerSettings({ allow_member_bots: value }))} label={t("bots.memberBots")} />
          </SettingRow>
          <SettingRow title={t("bots.perPerson")}>
            <select className="select" style={{ width: 90 }} value={most} onChange={(event) => void run(() => session().updateServerSettings({ max_bots: Number(event.target.value) }))} aria-label={t("bots.perPerson")}>
              {[...new Set([1, 3, 5, 10, 25, most])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </SettingRow>
        </>
      )}
    </>
  );
}
