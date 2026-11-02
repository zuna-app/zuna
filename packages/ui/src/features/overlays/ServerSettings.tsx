import { Ban, Crown, HardDrive, Image as ImageIcon, Link as LinkIcon, LogOut, MonitorUp, Search, Server as ServerIcon, Smile, UserRound, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Emote } from "@/components/Emote";
import { Avatar, Field, PopupMenu, Spinner, Switch, useAction } from "@/components/ui";
import { prepareAvatar } from "@/lib/media";
import { ServerScreenSection } from "@/features/voice/ScreenSettings";
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
        <span className="mono selectable" style={{ fontSize: 12.5 }}>{server.entry.url}</span>
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

function MembersSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const { run } = useAction();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; userId: string } | null>(null);
  if (!server) return null;
  const selfRole = server.self?.role;
  const needle = query.trim().toLowerCase();
  const users = Object.values(server.users)
    .filter((user) => !needle || user.displayName.toLowerCase().includes(needle) || user.username.toLowerCase().includes(needle))
    .sort((a, b) => Number(a.banned) - Number(b.banned) || a.displayName.localeCompare(b.displayName));
  const target = menu ? server.users[menu.userId] : null;

  return (
    <>
      <h1>Members</h1>
      <div className="input-wrap search-wrap">
        <Search size={15} className="faint" />
        <input className="input" placeholder={`Search ${Object.keys(server.users).length} members`} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search members" />
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
              <span style={{ display: "block", fontWeight: 500 }}>{user.displayName}</span>
              <span className="faint" style={{ fontSize: 12 }}>@{user.username}</span>
            </span>
            {user.banned && <span className="role-chip is-danger">Banned</span>}
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
            ...(selfRole === "owner"
              ? [{
                  label: target.role === "admin" ? "Remove admin" : "Make admin",
                  icon: <Crown size={15} />,
                  onSelect: () => void run(() => session().setServerRole(target.id, target.role === "admin" ? "member" : "admin")),
                }]
              : []),
            target.banned
              ? { label: "Unban", icon: <UserRound size={15} />, onSelect: () => void run(() => session().unbanUser(target.id)) }
              : { label: "Ban from server", icon: <Ban size={15} />, danger: true, onSelect: () => void run(() => session().banUser(target.id)) },
          ]}
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
  if (!server) return null;
  const emotes = server.emotes.emotes;
  return (
    <>
      <h1>Emotes</h1>
      <p className="settings-lead">
        Everyone on this server shares one 7TV emote set. Your server downloads and caches the images, so 7TV never sees your members' addresses.
      </p>
      <div className="current-set">
        <Smile size={18} />
        <span className="grow">
          <b>{server.emotes.set_name || "No emote set"}</b>
          <span className="setting-hint">{emotes.length} emotes</span>
        </span>
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
          disabled={!link.trim() || busy}
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

export function ServerSettings({ initialSection, onClose }: { initialSection?: string; onClose: () => void }) {
  const server = useActiveServer();
  const isAdmin = server?.self?.role === "owner" || server?.self?.role === "admin";
  const [section, setSection] = useState(initialSection ?? (isAdmin ? "overview" : "leave"));
  const sections = [
    ...(isAdmin
      ? [
          { id: "overview", label: "Overview", icon: ServerIcon },
          { id: "invites", label: "Invites", icon: LinkIcon },
          { id: "members", label: "Members", icon: Users },
          { id: "emotes", label: "Emotes", icon: Smile },
          { id: "storage", label: "Storage", icon: HardDrive },
          // A server from before it had a say has nothing to change.
          ...(server?.info?.screen_share ? [{ id: "screen", label: "Screen sharing", icon: MonitorUp }] : []),
        ]
      : []),
    { id: "leave", label: "Sign out", icon: LogOut, danger: true },
  ];
  return (
    <SettingsFrame title={server?.entry.name ?? "Server"} sections={sections} section={section} onSection={setSection} onClose={onClose}>
      {section === "overview" && <OverviewSection />}
      {section === "invites" && <InvitesSection />}
      {section === "members" && <MembersSection />}
      {section === "emotes" && <EmotesSection />}
      {section === "storage" && <StorageSection />}
      {section === "screen" && <ServerScreenSection />}
      {section === "leave" && <LeaveSection onClose={onClose} />}
    </SettingsFrame>
  );
}
