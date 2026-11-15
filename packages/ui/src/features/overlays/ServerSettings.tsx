import type { BanView, ReportView, UserView } from "@zuna/core";
import { AudioLines, Ban, Bot, Crown, Flag, HardDrive, Image as ImageIcon, Link as LinkIcon, LogOut, MonitorUp, Search, Server as ServerIcon, Smile, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Emote } from "@/components/Emote";
import { Avatar, BotBadge, Confirm, Field, PasswordField, PopupMenu, Spinner, Switch, useAction } from "@/components/ui";
import { BotsSection } from "@/features/bots/BotsSection";
import { formatFull } from "@/lib/format";
import { t, tx } from "@/lib/i18n";
import { prepareAvatar } from "@/lib/media";
import { REPORT_REASON_LABELS } from "@/lib/report";
import { ServerScreenSection } from "@/features/voice/ScreenSettings";
import { ServerSoundboardSection } from "@/features/voice/Soundboard";
import { useActiveServer, useApp } from "@/state/store";
import { InvitePanel } from "./Overlays";
import { SettingRow, SettingsFrame } from "./Settings";

function OverviewSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const [name, setName] = useState(server?.entry.name ?? "");
  const { busy, run } = useAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [iconVersion, setIconVersion] = useState(0);
  if (!server) return null;
  return (
    <>
      <h1>{t("serverSettings.overview.title")}</h1>
      <p className="settings-lead">{t("serverSettings.overview.lead")}</p>
      <div className="profile-edit">
        <button className="server-icon-edit" onClick={() => fileInput.current?.click()} aria-label={t("serverSettings.changePicture")}>
          <Avatar name={server.entry.name} seed={server.entry.url} size={72} rounded imageUrl={server.entry.hasIcon ? `${server.entry.url}/api/icon?v=${iconVersion}` : null} />
          <span><ImageIcon size={18} /></span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void run(async () => {
                await session().updateServerIcon(await prepareAvatar(file, 256));
                setIconVersion(Date.now());
              });
            }
            event.target.value = "";
          }}
        />
        <div className="col grow">
          <Field label={t("serverSettings.overview.name")} value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
        </div>
      </div>
      <div>
        <button
          className="btn btn-primary"
          disabled={!name.trim() || name === server.entry.name || busy}
          onClick={() => run(async () => {
            await session().updateServerSettings({ name: name.trim() });
            toast(t("common.saved"));
          })}
        >
          {busy ? <Spinner /> : t("common.saveChanges")}
        </button>
      </div>
      <div className="settings-divider" />
      <SettingRow title={t("serverSettings.overview.address")} hint={t("serverSettings.overview.addressHint")}>
        <span className="mono selectable" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{server.entry.address}</span>
      </SettingRow>
      <SettingRow title={t("serverSettings.overview.version")}>
        <span className="mono" style={{ fontSize: 12.5 }}>{server.info?.version}</span>
      </SettingRow>
    </>
  );
}

function InvitesSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const { run } = useAction();
  if (!server) return null;
  const open = server.info?.registration === "open";
  return (
    <>
      <h1>{t("serverSettings.sections.invites")}</h1>
      <p className="settings-lead">{t("serverSettings.invites.lead")}</p>
      <InvitePanel />
      <div className="settings-divider" />
      <SettingRow title={t("serverSettings.invites.memberInvites")} hint={t("serverSettings.invites.memberInvitesHint")}>
        <Switch on={server.info?.allow_member_invites ?? false} onChange={(value) => void run(() => session().updateServerSettings({ allow_member_invites: value }))} label={t("serverSettings.invites.memberInvites")} />
      </SettingRow>
      <SettingRow title={t("serverSettings.invites.openSignUps")} hint={t("serverSettings.invites.openSignUpsHint")}>
        <Switch on={open} onChange={(value) => void run(() => session().updateServerSettings({ registration: value ? "open" : "invite" }))} label={t("serverSettings.invites.openSignUps")} />
      </SettingRow>
    </>
  );
}

/** Who was reported, how often and why: never what was said, which nobody here can read, nor who reported them. */
function ReportsSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const [reports, setReports] = useState<ReportView[] | null>(null);
  const [banning, setBanning] = useState<{ userId: string; name: string } | null>(null);
  const { run } = useAction();
  const load = useCallback(() => {
    void session()
      .getReports()
      .then(setReports)
      .catch(() => setReports([]));
  }, [session]);
  useEffect(load, [load]);
  if (!server) return null;
  const selfRole = server.self?.role;
  return (
    <>
      <h1>{t("serverSettings.sections.reports")}</h1>
      <p className="settings-lead">{tx("serverSettings.reports.lead", { server: <b>{server.entry.name}</b> })}</p>
      {reports === null ? (
        <Spinner />
      ) : reports.length === 0 ? (
        <p className="muted">{t("serverSettings.reports.empty")}</p>
      ) : (
        <div className="device-list">
          {reports.map((report) => {
            const user = server.users[report.userId];
            const name = user?.displayName ?? t("chat.unknown");
            const canBan = !!user && !user.banned && !user.deleted && user.role !== "owner" && (selfRole === "owner" || user.role === "member");
            return (
              <div key={report.userId} className="device-row">
                <Avatar name={name} seed={report.userId} avatar={user?.avatar ?? null} size={36} />
                <span className="grow">
                  <span style={{ display: "block", fontWeight: 500 }}>{name}</span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {t("serverSettings.reports.count", { count: report.count })} · {report.reasons.map((reason) => REPORT_REASON_LABELS[reason]).join(", ")} · {formatFull(report.lastAt)}
                  </span>
                </span>
                <button className="btn btn-small" onClick={() => void run(async () => { await session().dismissReports(report.userId); load(); })}>
                  {t("serverSettings.reports.dismiss")}
                </button>
                {canBan && (
                  <button className="btn btn-small btn-danger" onClick={() => setBanning({ userId: report.userId, name })}>
                    <Ban size={13} /> {t("serverSettings.reports.ban")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {banning && (
        <BanConfirm
          name={banning.name}
          onCancel={() => setBanning(null)}
          onConfirm={() => {
            setBanning(null);
            void run(async () => {
              await session().banUser(banning.userId);
              load();
            });
          }}
        />
      )}
    </>
  );
}

/** What a ban does, asked before it's done, wherever it's done from. */
function BanConfirm({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Confirm title={t("serverSettings.ban.title", { name })} action={t("serverSettings.ban.action")} onCancel={onCancel} onConfirm={onConfirm}>
      {t("serverSettings.ban.text")}
    </Confirm>
  );
}

/** Who is banned, when and by whom, to let them back in. */
function BansSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const [bans, setBans] = useState<BanView[] | null>(null);
  const { run } = useAction();
  // Read again whenever someone is banned or unbanned, from here or anywhere else.
  const banned = Object.values(server?.users ?? {})
    .filter((user) => user.banned && !user.deleted)
    .map((user) => user.id)
    .sort()
    .join();
  const load = useCallback(() => {
    void session()
      .getBans()
      .then(setBans)
      .catch(() => setBans([]));
  }, [session]);
  useEffect(load, [load, banned]);
  if (!server) return null;
  const selfRole = server.self?.role;
  const shown = (bans ?? []).filter((ban) => server.users[ban.userId]?.banned !== false);
  return (
    <>
      <h1>{t("serverSettings.sections.bans")}</h1>
      <p className="settings-lead">{tx("serverSettings.bans.lead", { server: <b>{server.entry.name}</b> })}</p>
      {bans === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="muted">{t("serverSettings.bans.empty")}</p>
      ) : (
        <div className="device-list">
          {shown.map((ban) => {
            const user = server.users[ban.userId];
            const name = user?.displayName ?? t("chat.unknown");
            const date = formatFull(ban.bannedAt);
            const by = ban.bannedBy && ban.bannedBy !== server.self?.userId ? server.users[ban.bannedBy]?.displayName : undefined;
            const banned =
              ban.bannedBy === server.self?.userId
                ? t("serverSettings.bans.bannedByYou", { date })
                : by
                  ? t("serverSettings.bans.bannedBy", { name: by, date })
                  : t("serverSettings.bans.bannedOn", { date });
            // The owner can unban anyone, and admins only members, as with banning.
            const canUnban = !!user && (selfRole === "owner" || user.role === "member");
            return (
              <div key={ban.userId} className="device-row">
                <Avatar name={name} seed={ban.userId} avatar={user?.avatar ?? null} size={36} />
                <span className="grow">
                  <span style={{ display: "block", fontWeight: 500 }}>{name}</span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {user && `@${user.username} · `}
                    {banned}
                  </span>
                </span>
                <button
                  className="btn btn-small"
                  disabled={!canUnban}
                  title={canUnban ? undefined : t("serverSettings.bans.ownerOnly")}
                  onClick={() => void run(async () => { await session().unbanUser(ban.userId); load(); })}
                >
                  <UserRound size={13} /> {t("serverSettings.bans.unban")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function MembersSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const { run } = useAction();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; userId: string } | null>(null);
  const [banning, setBanning] = useState<UserView | null>(null);
  if (!server) return null;
  const selfRole = server.self?.role;
  const needle = query.trim().toLowerCase();
  // Nothing can be done about an account that's gone, and someone banned is in Bans.
  const members = Object.values(server.users).filter((user) => !user.deleted && !user.banned);
  const users = members
    .filter((user) => !needle || user.displayName.toLowerCase().includes(needle) || user.username.toLowerCase().includes(needle))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const target = menu ? server.users[menu.userId] : null;

  return (
    <>
      <h1>{t("serverSettings.sections.members")}</h1>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder={t("serverSettings.members.search", { count: members.length })} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("serverSettings.members.searchLabel")} />
      </div>
      <div className="device-list">
        {users.map((user) => (
          <button
            key={user.id}
            className="device-row is-button"
            onClick={(event) => {
              const canAct = user.id !== server.self?.userId && user.role !== "owner" && (selfRole === "owner" || user.role === "member");
              if (canAct) setMenu({ x: event.clientX, y: event.clientY, userId: user.id });
            }}
          >
            <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={36} online={user.online} />
            <span className="grow">
              <span style={{ display: "block", fontWeight: 500 }}>{user.displayName}{user.bot && <> <BotBadge /></>}</span>
              <span className="faint" style={{ fontSize: 12 }}>@{user.username}</span>
            </span>
            {user.role !== "member" && (
              <span className="role-chip">
                <Crown size={12} /> {user.role === "owner" ? t("serverSettings.members.owner") : t("serverSettings.members.admin")}
              </span>
            )}
          </button>
        ))}
      </div>
      {menu && target && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          entries={[
            // A bot is never one of the server's admins.
            ...(selfRole === "owner" && !target.bot
              ? [{
                  label: target.role === "admin" ? t("serverSettings.members.removeAdmin") : t("serverSettings.members.makeAdmin"),
                  icon: <Crown size={15} />,
                  onSelect: () => void run(() => session().setServerRole(target.id, target.role === "admin" ? "member" : "admin")),
                }]
              : []),
            { label: t("serverSettings.ban.action"), icon: <Ban size={15} />, danger: true, onSelect: () => setBanning(target) },
          ]}
        />
      )}
      {banning && (
        <BanConfirm
          name={banning.displayName}
          onCancel={() => setBanning(null)}
          onConfirm={() => {
            setBanning(null);
            void run(() => session().banUser(banning.id));
          }}
        />
      )}
    </>
  );
}

function EmotesSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const [link, setLink] = useState("");
  const { busy, run } = useAction();
  const refresh = useAction();
  if (!server) return null;
  const emotes = server.emotes.emotes;
  const setId = server.emotes.set_id;
  return (
    <>
      <h1>{t("serverSettings.sections.emotes")}</h1>
      <p className="settings-lead">{t("serverSettings.emotes.lead")}</p>
      <div className="current-set">
        <Smile size={18} />
        <span className="grow">
          <b>{server.emotes.set_name || t("serverSettings.emotes.noSet")}</b>
          <span className="setting-hint">{t("serverSettings.emotes.count", { count: emotes.length })}</span>
        </span>
        {setId && (
          <button
            className="btn btn-small"
            disabled={refresh.busy || busy}
            onClick={() =>
              refresh.run(async () => {
                const result = await session().setEmoteSet(setId);
                toast(t("serverSettings.emotes.updated", { name: result.set_name, count: result.count }));
              })
            }
          >
            {refresh.busy ? <Spinner /> : t("serverSettings.emotes.refresh")}
          </button>
        )}
      </div>
      <Field
        label={t("serverSettings.emotes.useDifferent")}
        placeholder="https://7tv.app/emote-sets/..."
        value={link}
        spellCheck={false}
        hint={t("serverSettings.emotes.linkHint")}
        onChange={(event) => setLink(event.target.value)}
      />
      <div>
        <button
          className="btn btn-primary"
          disabled={!link.trim() || busy || refresh.busy}
          onClick={() =>
            run(async () => {
              const result = await session().setEmoteSet(link.trim());
              setLink("");
              toast(t("serverSettings.emotes.nowUsing", { name: result.set_name, count: result.count }));
            })
          }
        >
          {busy ? <Spinner /> : t("serverSettings.emotes.useSet")}
        </button>
      </div>
      {emotes.length > 0 && (
        <div className="emote-preview">
          {emotes.slice(0, 80).map((emote) => (
            <Emote key={emote.id} name={emote.name} emote={{ id: emote.id, animated: emote.animated }} serverUrl={server.entry.url} size="picker" />
          ))}
        </div>
      )}
    </>
  );
}

function StorageSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const { busy, run } = useAction();
  const [maxUpload, setMaxUpload] = useState(String(server?.info?.max_upload_mb ?? 100));
  const [retention, setRetention] = useState(String(server?.info?.retention_days ?? 0));
  useEffect(() => {
    if (server?.info) {
      setMaxUpload(String(server.info.max_upload_mb));
      setRetention(String(server.info.retention_days));
    }
  }, [server?.info?.max_upload_mb, server?.info?.retention_days]);
  return (
    <>
      <h1>{t("serverSettings.sections.storage")}</h1>
      <Field label={t("serverSettings.storage.maxUpload")} type="number" min={1} value={maxUpload} suffix={t("serverSettings.storage.megabytes")} onChange={(event) => setMaxUpload(event.target.value)} />
      <Field
        label={t("serverSettings.storage.retention")}
        type="number"
        min={0}
        value={retention}
        suffix={t("serverSettings.storage.days")}
        hint={t("serverSettings.storage.retentionHint")}
        onChange={(event) => setRetention(event.target.value)}
      />
      <div>
        <button
          className="btn btn-primary"
          disabled={busy || Number(maxUpload) < 1 || Number(retention) < 0}
          onClick={() =>
            run(async () => {
              await session().updateServerSettings({ max_upload_mb: Number(maxUpload), retention_days: Number(retention) });
              toast(t("common.saved"));
            })
          }
        >
          {busy ? <Spinner /> : t("common.saveChanges")}
        </button>
      </div>
    </>
  );
}

function LeaveSection({ onClose }: { onClose: () => void }) {
  const server = useActiveServer();
  const core = useApp((state) => state.core);
  const removeServer = useApp((state) => state.removeServer);
  const { busy, run } = useAction();
  if (!server) return null;
  return (
    <>
      <h1>{t("serverSettings.sections.leave")}</h1>
      <p className="settings-lead">{tx("serverSettings.leave.lead", { server: <b>{server.entry.name}</b> })}</p>
      <div>
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const id = server.entry.id;
              await core!.client.leaveServer(id);
              onClose();
              removeServer(id);
            })
          }
        >
          {busy ? <Spinner /> : <><LogOut size={15} /> {t("serverSettings.leave.action")}</>}
        </button>
      </div>
    </>
  );
}

/**
 * Deleting the account on this server, once the password is typed. What was sent
 * stays with everyone who has it, from "Deleted account".
 */
function DeleteAccountSection({ onClose }: { onClose: () => void }) {
  const server = useActiveServer();
  const core = useApp((state) => state.core);
  const removeServer = useApp((state) => state.removeServer);
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useAction();
  if (!server) return null;
  const name = server.entry.name;
  if (server.self?.role === "owner") {
    return (
      <>
        <h1>{t("serverSettings.sections.delete")}</h1>
        <p className="settings-lead">{tx("serverSettings.delete.ownerLead", { server: <b>{name}</b> })}</p>
      </>
    );
  }
  return (
    <>
      <h1>{t("serverSettings.sections.delete")}</h1>
      <p className="settings-lead">{tx("serverSettings.delete.lead", { server: <b>{name}</b> })}</p>
      <PasswordField label={t("common.password")} value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
      <div>
        <button className="btn btn-danger" disabled={!password || busy} onClick={() => setConfirming(true)}>
          {busy ? <Spinner /> : <><Trash2 size={15} /> {t("serverSettings.delete.action")}</>}
        </button>
      </div>
      {confirming && (
        <Confirm
          title={t("serverSettings.delete.confirmTitle", { server: name })}
          action={t("serverSettings.sections.delete")}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void run(async () => {
              const id = server.entry.id;
              await core!.client.deleteAccount(id, password);
              onClose();
              removeServer(id);
            });
          }}
        >
          {t("serverSettings.delete.confirmText")}
        </Confirm>
      )}
    </>
  );
}

export function ServerSettings({ initialSection, onClose }: { initialSection?: string; onClose: () => void }) {
  const server = useActiveServer();
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";
  // For whoever may make a bot, and whoever has one already.
  const hasBots = isAdmin || !!server?.info?.allow_member_bots || Object.values(server?.users ?? {}).some((user) => user.bot?.ownerId === server?.self?.userId && !user.deleted);
  const [section, setSection] = useState(initialSection ?? (isAdmin ? "overview" : "leave"));
  const sections = [
    ...(isAdmin
      ? [
          { id: "overview", label: t("serverSettings.sections.overview"), icon: ServerIcon },
          { id: "invites", label: t("serverSettings.sections.invites"), icon: LinkIcon },
          { id: "members", label: t("serverSettings.sections.members"), icon: Users },
          { id: "reports", label: t("serverSettings.sections.reports"), icon: Flag },
          { id: "bans", label: t("serverSettings.sections.bans"), icon: Ban },
          { id: "emotes", label: t("serverSettings.sections.emotes"), icon: Smile },
          { id: "soundboard", label: t("serverSettings.sections.soundboard"), icon: AudioLines },
          { id: "storage", label: t("serverSettings.sections.storage"), icon: HardDrive },
          { id: "screen", label: t("serverSettings.sections.screen"), icon: MonitorUp },
        ]
      : []),
    ...(hasBots ? [{ id: "bots", label: t("serverSettings.sections.bots"), icon: Bot }] : []),
    { id: "leave", label: t("serverSettings.sections.leave"), icon: LogOut, danger: true },
    { id: "delete", label: t("serverSettings.sections.delete"), icon: Trash2, danger: true },
  ];
  return (
    <SettingsFrame title={server?.entry.name ?? t("serverSettings.overview.title")} sections={sections} section={section} onSection={setSection} onClose={onClose}>
      {section === "overview" && <OverviewSection />}
      {section === "invites" && <InvitesSection />}
      {section === "members" && <MembersSection />}
      {section === "reports" && <ReportsSection />}
      {section === "bans" && <BansSection />}
      {section === "emotes" && <EmotesSection />}
      {section === "soundboard" && <ServerSoundboardSection />}
      {section === "storage" && <StorageSection />}
      {section === "screen" && <ServerScreenSection />}
      {section === "bots" && <BotsSection />}
      {section === "leave" && <LeaveSection onClose={onClose} />}
      {section === "delete" && <DeleteAccountSection onClose={onClose} />}
    </SettingsFrame>
  );
}
