import type { BanView, ReportView, UserView } from "@zuna/core";
import { AudioLines, Ban, Bot, Crown, Flag, HardDrive, Image as ImageIcon, Link as LinkIcon, LogOut, MonitorUp, Search, Server as ServerIcon, Smile, Trash2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Emote } from "@/components/Emote";
import { Avatar, BotBadge, Confirm, Field, PasswordField, PopupMenu, Spinner, Switch, useAction } from "@/components/ui";
import { BotsSection } from "@/features/bots/BotsSection";
import { formatFull } from "@/lib/format";
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
      <h1>Server</h1>
      <p className="settings-lead">The name and picture are public: they appear on invite pages before anyone signs in.</p>
      <div className="profile-edit">
        <button className="server-icon-edit" onClick={() => fileInput.current?.click()} aria-label="Change server picture">
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
          <Field label="Server name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} />
        </div>
      </div>
      <div>
        <button
          className="btn btn-primary"
          disabled={!name.trim() || name === server.entry.name || busy}
          onClick={() => run(async () => {
            await session().updateServerSettings({ name: name.trim() });
            toast("Saved");
          })}
        >
          {busy ? <Spinner /> : "Save changes"}
        </button>
      </div>
      <div className="settings-divider" />
      <SettingRow title="Address" hint="People and apps reach your server here.">
        <span className="mono selectable" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{server.entry.address}</span>
      </SettingRow>
      <SettingRow title="Version">
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
      <h1>Invites</h1>
      <p className="settings-lead">Invite links are the safest way for people to join.</p>
      <InvitePanel />
      <div className="settings-divider" />
      <SettingRow title="Let members create invite links" hint="If off, only admins can.">
        <Switch on={server.info?.allow_member_invites ?? false} onChange={(value) => void run(() => session().updateServerSettings({ allow_member_invites: value }))} label="Let members create invite links" />
      </SettingRow>
      <SettingRow title="Open sign-ups" hint="Anyone who knows the address can join. This gives the server the key that protects profiles, so it can read display names and pictures. Messages stay encrypted.">
        <Switch on={open} onChange={(value) => void run(() => session().updateServerSettings({ registration: value ? "open" : "invite" }))} label="Open sign-ups" />
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
      <h1>Reports</h1>
      <p className="settings-lead">
        People others on <b>{server.entry.name}</b> reported, and why. Messages are encrypted, so nobody here sees what was said, and who reported them isn't kept.
      </p>
      {reports === null ? (
        <Spinner />
      ) : reports.length === 0 ? (
        <p className="muted">Nobody has been reported.</p>
      ) : (
        <div className="device-list">
          {reports.map((report) => {
            const user = server.users[report.userId];
            const name = user?.displayName ?? "Unknown";
            const canBan = !!user && !user.banned && !user.deleted && user.role !== "owner" && (selfRole === "owner" || user.role === "member");
            return (
              <div key={report.userId} className="device-row">
                <Avatar name={name} seed={report.userId} avatar={user?.avatar ?? null} size={36} />
                <span className="grow">
                  <span style={{ display: "block", fontWeight: 500 }}>{name}</span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {report.count === 1 ? "1 report" : `${report.count} reports`} · {report.reasons.map((reason) => REPORT_REASON_LABELS[reason]).join(", ")} · {formatFull(report.lastAt)}
                  </span>
                </span>
                <button className="btn btn-small" onClick={() => void run(async () => { await session().dismissReports(report.userId); load(); })}>
                  Dismiss
                </button>
                {canBan && (
                  <button className="btn btn-small btn-danger" onClick={() => setBanning({ userId: report.userId, name })}>
                    <Ban size={13} /> Ban
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
    <Confirm title={`Ban ${name}?`} action="Ban from server" onCancel={onCancel} onConfirm={onConfirm}>
      They're signed out everywhere and removed from every group and channel. An admin can unban them later, in Bans.
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
      <h1>Bans</h1>
      <p className="settings-lead">
        People banned from <b>{server.entry.name}</b>. Unbanned, they can sign in again, and they're back in their direct messages and channels. Groups have to add them again.
      </p>
      {bans === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="muted">Nobody is banned.</p>
      ) : (
        <div className="device-list">
          {shown.map((ban) => {
            const user = server.users[ban.userId];
            const name = user?.displayName ?? "Unknown";
            const by = ban.bannedBy === server.self?.userId ? "you" : ban.bannedBy ? server.users[ban.bannedBy]?.displayName : undefined;
            // The owner can unban anyone, and admins only members, as with banning.
            const canUnban = !!user && (selfRole === "owner" || user.role === "member");
            return (
              <div key={ban.userId} className="device-row">
                <Avatar name={name} seed={ban.userId} avatar={user?.avatar ?? null} size={36} />
                <span className="grow">
                  <span style={{ display: "block", fontWeight: 500 }}>{name}</span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {user && `@${user.username} · `}Banned {by && `by ${by} `}on {formatFull(ban.bannedAt)}
                  </span>
                </span>
                <button
                  className="btn btn-small"
                  disabled={!canUnban}
                  title={canUnban ? undefined : "Only the server's owner can unban an admin."}
                  onClick={() => void run(async () => { await session().unbanUser(ban.userId); load(); })}
                >
                  <UserRound size={13} /> Unban
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
      <h1>Members</h1>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder={`Search ${members.length} members`} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search members" />
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
                <Crown size={12} /> {user.role === "owner" ? "Owner" : "Admin"}
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
                  label: target.role === "admin" ? "Remove admin" : "Make admin",
                  icon: <Crown size={15} />,
                  onSelect: () => void run(() => session().setServerRole(target.id, target.role === "admin" ? "member" : "admin")),
                }]
              : []),
            { label: "Ban from server", icon: <Ban size={15} />, danger: true, onSelect: () => setBanning(target) },
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
      <h1>Emotes</h1>
      <p className="settings-lead">
        Everyone on this server shares one 7TV emote set. Your server downloads and caches the images, so 7TV never sees your members' addresses. It checks 7TV
        for changes to the set every few hours.
      </p>
      <div className="current-set">
        <Smile size={18} />
        <span className="grow">
          <b>{server.emotes.set_name || "No emote set"}</b>
          <span className="setting-hint">{emotes.length} emotes</span>
        </span>
        {setId && (
          <button
            className="btn btn-small"
            disabled={refresh.busy || busy}
            onClick={() =>
              refresh.run(async () => {
                const result = await session().setEmoteSet(setId);
                toast(`Updated ${result.set_name} (${result.count} emotes)`);
              })
            }
          >
            {refresh.busy ? <Spinner /> : "Refresh"}
          </button>
        )}
      </div>
      <Field
        label="Use a different set"
        placeholder="https://7tv.app/emote-sets/..."
        value={link}
        spellCheck={false}
        hint="Paste a link to any emote set on 7TV."
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
              toast(`Now using ${result.set_name} (${result.count} emotes)`);
            })
          }
        >
          {busy ? <Spinner /> : "Use this set"}
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
      <h1>Storage</h1>
      <Field label="Largest file members can send" type="number" min={1} value={maxUpload} suffix="MB" onChange={(event) => setMaxUpload(event.target.value)} />
      <Field
        label="Delete messages after"
        type="number"
        min={0}
        value={retention}
        suffix="days"
        hint="0 keeps messages forever. Pinned messages are kept. This is enforced by the server, so it only removes the server's copy."
        onChange={(event) => setRetention(event.target.value)}
      />
      <div>
        <button
          className="btn btn-primary"
          disabled={busy || Number(maxUpload) < 1 || Number(retention) < 0}
          onClick={() =>
            run(async () => {
              await session().updateServerSettings({ max_upload_mb: Number(maxUpload), retention_days: Number(retention) });
              toast("Saved");
            })
          }
        >
          {busy ? <Spinner /> : "Save changes"}
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
      <h1>Sign out</h1>
      <p className="settings-lead">
        This signs you out of <b>{server.entry.name}</b> on this device and erases its local copy of your messages. Your account and history stay on the server, and you can sign back in with your password.
      </p>
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
          {busy ? <Spinner /> : <><LogOut size={15} /> Sign out and erase local data</>}
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
        <h1>Delete account</h1>
        <p className="settings-lead">
          You own <b>{name}</b>, and a server can't be without its owner, so your account there can't be deleted. Stopping the server and deleting its data removes everything on it.
        </p>
      </>
    );
  }
  return (
    <>
      <h1>Delete account</h1>
      <p className="settings-lead">
        This deletes your account on <b>{name}</b>, with your profile and keys, signs out your other devices, and erases this device's copy of your messages. What you sent stays with the people you sent it to, from "Deleted account". Your username becomes free for someone else. It can't be undone.
      </p>
      <PasswordField label="Password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
      <div>
        <button className="btn btn-danger" disabled={!password || busy} onClick={() => setConfirming(true)}>
          {busy ? <Spinner /> : <><Trash2 size={15} /> Delete my account</>}
        </button>
      </div>
      {confirming && (
        <Confirm
          title={`Delete your account on ${name}?`}
          action="Delete account"
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
          It can't be undone. What you sent stays with the people you sent it to, from "Deleted account".
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
          { id: "overview", label: "Overview", icon: ServerIcon },
          { id: "invites", label: "Invites", icon: LinkIcon },
          { id: "members", label: "Members", icon: Users },
          { id: "reports", label: "Reports", icon: Flag },
          { id: "bans", label: "Bans", icon: Ban },
          { id: "emotes", label: "Emotes", icon: Smile },
          { id: "soundboard", label: "Soundboard", icon: AudioLines },
          { id: "storage", label: "Storage", icon: HardDrive },
          { id: "screen", label: "Screen sharing", icon: MonitorUp },
        ]
      : []),
    ...(hasBots ? [{ id: "bots", label: "Bots", icon: Bot }] : []),
    { id: "leave", label: "Sign out", icon: LogOut, danger: true },
    { id: "delete", label: "Delete account", icon: Trash2, danger: true },
  ];
  return (
    <SettingsFrame title={server?.entry.name ?? "Server"} sections={sections} section={section} onSection={setSection} onClose={onClose}>
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
