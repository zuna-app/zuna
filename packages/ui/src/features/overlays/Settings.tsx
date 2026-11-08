import type { DeviceView } from "@zuna/core";
import {
  Bell,
  Camera,
  Check,
  Mic,
  MonitorUp,
  Copy,
  Info,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Palette,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "@/platform";
import { Avatar, ConfirmPasswordField, Field, Logo, Modal, PasswordField, Spinner, Switch, useAction, useReturnFocus } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { useEscape } from "@/lib/escape";
import { PROJECT_URL, TERMS_URL } from "@/lib/links";
import { formatFull, MIN_PASSWORD } from "@/lib/format";
import { usePasswordStrength } from "@/lib/password";
import { prepareAvatar } from "@/lib/media";
import type { AppSettings } from "@/state/settings";
import { useActiveServer, useApp } from "@/state/store";
import { ScreenSettingsSection } from "@/features/voice/ScreenSettings";
import { VoiceSettingsSection } from "@/features/voice/VoiceSettings";

const ACCENTS: { id: AppSettings["accent"]; color: string; check: string; label: string }[] = [
  { id: "neutral", color: "#ececee", check: "#111113", label: "Neutral" },
  { id: "blue", color: "#4b8fe0", check: "#fff", label: "Blue" },
  { id: "green", color: "#3fa772", check: "#fff", label: "Green" },
  { id: "red", color: "#d9534f", check: "#fff", label: "Red" },
  { id: "amber", color: "#d9962a", check: "#111113", label: "Amber" },
];

const SECTIONS = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "privacy", label: "Privacy", icon: Lock },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "voice", label: "Voice and video", icon: Mic },
  { id: "screen", label: "Screen sharing", icon: MonitorUp },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "about", label: "About", icon: Info },
] as const;

export function SettingsFrame({
  title,
  sections,
  section,
  onSection,
  onClose,
  children,
}: {
  title: string;
  sections: readonly { id: string; label: string; icon: typeof Bell; danger?: boolean }[];
  section: string;
  onSection: (id: string) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useReturnFocus();
  useEscape(onClose);
  return createPortal(
    <div className="settings-layer">
      <div className="settings">
        <nav className="settings-nav">
          <h2>{title}</h2>
          {sections.map((item) => (
            <button key={item.id} className={`settings-nav-item${section === item.id ? " is-active" : ""}${item.danger ? " is-danger" : ""}`} onClick={() => onSection(item.id)}>
              <item.icon size={17} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <button className="icon-btn settings-close" onClick={onClose} aria-label="Close settings">
            <X size={19} />
          </button>
          <div key={section} className="settings-page">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function SettingRow({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="setting-row">
      <span className="grow">
        <b>{title}</b>
        {hint && <span className="setting-hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function ProfileSection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const self = server?.self ? server.users[server.self.userId] : null;
  const [displayName, setDisplayName] = useState(self?.displayName ?? "");
  const [bio, setBio] = useState(self?.bio ?? "");
  const { busy, run } = useAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty = displayName.trim() !== self?.displayName || bio !== self?.bio;

  if (!self) return null;
  return (
    <>
      <h1>Profile</h1>
      <p className="settings-lead">Only members of {server?.entry.name} can see this. Your server stores it encrypted.</p>
      <div className="profile-edit">
        <div className="avatar-edit">
          <Avatar name={self.displayName} seed={self.id} avatar={self.avatar} size={72} />
          <button className="avatar-edit-button" onClick={() => fileInput.current?.click()} aria-label="Change profile picture">
            <Camera size={17} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void run(async () => session().updateProfile({}, await prepareAvatar(file)));
              event.target.value = "";
            }}
          />
        </div>
        <div className="col grow">
          <span style={{ fontWeight: 600, fontSize: 15 }}>{self.displayName}</span>
          <span className="muted">@{self.username}</span>
          {self.avatar && (
            <button className="link-button" style={{ justifyContent: "flex-start" }} onClick={() => run(() => session().updateProfile({}, null))}>
              Remove picture
            </button>
          )}
        </div>
      </div>
      <Field label="Display name" value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)} />
      <label className="field">
        <span className="field-label">Bio</span>
        <textarea className="textarea" value={bio} maxLength={300} placeholder="A few words about you" onChange={(event) => setBio(event.target.value)} />
      </label>
      <div>
        <button
          className="btn btn-primary"
          disabled={!dirty || !displayName.trim() || busy}
          onClick={() =>
            run(async () => {
              await session().updateProfile({ displayName: displayName.trim(), bio });
              toast("Profile saved");
            })
          }
        >
          {busy ? <Spinner /> : "Save changes"}
        </button>
      </div>
    </>
  );
}

function PrivacySection() {
  const server = useActiveServer();
  const session = useApp((state) => state.session);
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  const { run } = useAction();
  const [confirmingKeep, setConfirmingKeep] = useState(false);
  const self = server?.self ? server.users[server.self.userId] : null;
  if (!server || !self) return null;
  const blocked = (server.prefs.blocked ?? []).flatMap((id) => server.users[id] ?? []).sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <>
      <h1>Privacy</h1>
      <p className="settings-lead">These apply to {server.entry.name}. Each server you join has its own settings.</p>
      <SettingRow title="Send read receipts" hint="Others see when you've read their messages. If off, your devices still stay in sync.">
        <Switch on={server.prefs.sendReadReceipts} onChange={(value) => void session().updatePreferences({ sendReadReceipts: value })} label="Send read receipts" />
      </SettingRow>
      <SettingRow title="Show when I'm online" hint="If off, people see “last seen recently” instead of your status.">
        <Switch on={!self.hidesLastSeen} onChange={(value) => void run(() => session().setHideLastSeen(!value))} label="Show when I'm online" />
      </SettingRow>
      <div className="settings-divider" />
      <h3>Blocked people</h3>
      {blocked.length === 0 && <p className="setting-hint">Nobody. You can block someone from their details in a chat, or from a group's members.</p>}
      {blocked.map((user) => (
        <div key={user.id} className="setting-row">
          <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={32} />
          <span className="grow">
            <b>{user.displayName}</b>
            {!user.deleted && <span className="setting-hint">@{user.username}</span>}
          </span>
          <button className="btn btn-small" onClick={() => void run(() => session().setBlocked(user.id, false))}>
            Unblock
          </button>
        </div>
      ))}
      <p className="setting-hint">You don't see messages from people you block, or hear about them. Nobody is told, and your server can't see who you block.</p>
      <div className="settings-divider" />
      <h3>On this device</h3>
      <SettingRow
        title="Link previews"
        hint="When you write a link, this device fetches the page to show its title and picture, and sends them encrypted with your message. The site sees your address, as when you open a link. Your server never sees it."
      >
        <Switch on={settings.linkPreviews} onChange={(value) => update({ linkPreviews: value })} label="Link previews" />
      </SettingRow>
      <SettingRow
        title="Remove metadata from files"
        hint="Before a file is sent, this device takes out where and when it was made, the camera or phone and its serial number, the program, and editing history. Photos: JPEG, PNG, WebP, GIF, HEIC and AVIF. Videos: MP4, MOV, 3GP, WebM and MKV. Drawings: SVG. Other files are sent as they are."
      >
        <Switch
          on={settings.removeMetadata}
          onChange={(value) => (value ? update({ removeMetadata: true }) : setConfirmingKeep(true))}
          label="Remove metadata from files"
        />
      </SettingRow>
      {confirmingKeep && (
        <KeepMetadataConfirm
          onCancel={() => setConfirmingKeep(false)}
          onConfirm={() => {
            update({ removeMetadata: false });
            setConfirmingKeep(false);
          }}
        />
      )}
    </>
  );
}

/** Turning metadata removal off says what it shows, and waits to be sure. */
function KeepMetadataConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal
      title="Send files with their metadata?"
      onClose={onCancel}
      width={440}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} autoFocus>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>Turn off</button>
        </>
      }
    >
      <p style={{ fontSize: 13.5 }}>
        Photos and videos from phones usually record where they were taken, to within a few meters, and when. With this off, everyone in a chat you send them to can see that, along with the camera or phone and its serial number, the program used, and what was changed in it. So can anyone they pass the files on to.
      </p>
      <p className="muted" style={{ fontSize: 13.5 }}>Your server still can't see any of it, as files are encrypted. This is only for this device, and for files you send from now on.</p>
    </Modal>
  );
}

function NotificationsSection() {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  const [permission, setPermission] = useState(() => platform.notificationPermission?.() ?? "granted");
  const notifies = !!platform.notify;
  // Turning them on is a click, which is when a browser can ask.
  const setNotifications = async (value: boolean) => {
    update({ notifications: value });
    if (value && platform.askToNotify) {
      await platform.askToNotify();
      setPermission(platform.notificationPermission?.() ?? "granted");
    }
  };
  return (
    <>
      <h1>Notifications</h1>
      <p className="settings-lead">Previews are decrypted on this device. No notification service ever sees them.</p>
      {notifies && (
        <>
          <SettingRow
            title="Desktop notifications"
            hint={
              settings.notifications && permission === "denied"
                ? "Your browser blocks notifications from this site. Allow them in its settings for the site."
                : "While you're on another device, they wait 30 seconds, and don't show if you read the chat there."
            }
          >
            <Switch on={settings.notifications} onChange={(value) => void setNotifications(value)} label="Desktop notifications" />
          </SettingRow>
          <SettingRow title="Sound">
            <Switch on={settings.notificationSound} onChange={(value) => update({ notificationSound: value })} label="Notification sound" />
          </SettingRow>
        </>
      )}
      {notifies && (
        <SettingRow title="What notifications show" hint="Choose less if others can see your screen.">
          <select className="select" style={{ width: 180 }} value={settings.notificationPreview} onChange={(event) => update({ notificationPreview: event.target.value as AppSettings["notificationPreview"] })}>
            <option value="full">Sender and message</option>
            <option value="sender">Sender only</option>
            <option value="none">Nothing</option>
          </select>
        </SettingRow>
      )}
    </>
  );
}

function AppearanceSection() {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  return (
    <>
      <h1>Appearance</h1>
      <div className="field">
        <span className="field-label">Accent color</span>
        <div className="accent-row">
          {ACCENTS.map((accent) => (
            <button key={accent.id} className={`accent-swatch${settings.accent === accent.id ? " is-active" : ""}`} style={{ background: accent.color, color: accent.check }} onClick={() => update({ accent: accent.id })} aria-label={accent.label} aria-pressed={settings.accent === accent.id}>
              {settings.accent === accent.id && <Check size={15} strokeWidth={2.5} />}
            </button>
          ))}
        </div>
      </div>
      <SettingRow title="Message size">
        <div className="segmented">
          {(["small", "medium", "large"] as const).map((size) => (
            <button key={size} className={settings.messageSize === size ? "is-active" : ""} onClick={() => update({ messageSize: size })}>
              {size[0]!.toUpperCase() + size.slice(1)}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow title="Reduce motion" hint="Turns off most animations.">
        <Switch on={settings.reduceMotion} onChange={(value) => update({ reduceMotion: value })} label="Reduce motion" />
      </SettingRow>
      <SettingRow title="Press Enter to send" hint="If off, use Ctrl+Enter to send and Enter for new lines.">
        <Switch on={settings.enterToSend} onChange={(value) => update({ enterToSend: value })} label="Press Enter to send" />
      </SettingRow>
    </>
  );
}

function DevicesCard() {
  const session = useApp((state) => state.session);
  const server = useActiveServer();
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const { run } = useAction();
  useEffect(() => {
    void session().getDevices().then(setDevices);
  }, [session, server?.users]);
  return (
    <div className="field">
      <span className="field-label">Your devices on this server</span>
      <div className="device-list">
        {devices.map((device) => (
          <div key={device.id} className="device-row">
            <span className="device-icon"><Laptop size={18} /></span>
            <span className="grow">
              <span style={{ display: "block", fontWeight: 500 }}>
                {device.name}
                {device.isCurrent && <span className="device-current">This device</span>}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>Signed in {formatFull(device.createdAt)}</span>
            </span>
            {!device.isCurrent && (
              <button className="btn btn-small btn-danger" onClick={() => run(() => session().revokeDevice(device.id))}>
                <Trash2 size={13} /> Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {server && (
        // A server that makes its own certificate needs its pin too, which only its links carry.
        <span className="field-hint">
          To add one, sign in there to <span className="mono selectable" style={{ overflowWrap: "anywhere" }}>{server.entry.address}</span>
        </span>
      )}
    </div>
  );
}

function SecuritySection() {
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
  const keyProtected = useApp((state) => state.keyProtected);
  const setOverlay = useApp((state) => state.setOverlay);
  const server = useActiveServer();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const { busy, run } = useAction();
  const self = server?.self ? server.users[server.self.userId] : undefined;
  const strength = usePasswordStrength(next, [server?.self?.username ?? "", self?.displayName ?? ""]);

  return (
    <>
      <h1>Security</h1>
      {!keyProtected && platform.keyWarning && (
        <div className="notice is-warn">
          <Lock size={15} />
          <span>{platform.keyWarning}</span>
        </div>
      )}
      <SettingRow title="Your security key" hint="Compare it with friends to prove nobody is in between.">
        <button className="btn btn-small" onClick={() => server?.self && setOverlay({ type: "verify", userId: server.self.userId })}>
          <KeyRound size={14} /> View
        </button>
      </SettingRow>
      <DevicesCard />
      <div className="settings-divider" />
      <h3>Change password</h3>
      <PasswordField label="Current password" value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} />
      <PasswordField label="New password" value={next} autoComplete="new-password" hint={next ? strength.label : `At least ${MIN_PASSWORD} characters.`} onChange={(event) => setNext(event.target.value)} />
      <ConfirmPasswordField label="Confirm new password" password={next} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      <div>
        <button
          className="btn"
          disabled={!current || next.length < MIN_PASSWORD || strength.score < 2 || confirm !== next || busy}
          onClick={() =>
            strength.accepts() &&
            run(async () => {
              await session().changePassword(current, next);
              setCurrent("");
              setNext("");
              setConfirm("");
              toast("Password changed");
            })
          }
        >
          {busy ? <Spinner /> : "Change password"}
        </button>
      </div>
      <div className="settings-divider" />
      <h3>Recovery key</h3>
      <p className="muted" style={{ fontSize: 13.5 }}>Create a new key if you've lost the old one or think someone saw it. The old key stops working immediately.</p>
      {recoveryKey ? (
        <div className="col">
          <div className="recovery-key mono selectable">
            {recoveryKey.split("-").map((part, index) => <span key={index}>{part}</span>)}
          </div>
          <button className="btn" onClick={() => void copyText(recoveryKey).then(() => toast("Copied"))}>
            <Copy size={14} /> Copy
          </button>
        </div>
      ) : (
        <>
          <PasswordField label="Current password" value={recoveryPassword} autoComplete="current-password" onChange={(event) => setRecoveryPassword(event.target.value)} />
          <div>
            <button
              className="btn"
              disabled={!recoveryPassword || busy}
              onClick={() =>
                run(async () => {
                  setRecoveryKey(await session().regenerateRecoveryKey(recoveryPassword));
                  setRecoveryPassword("");
                })
              }
            >
              Create new recovery key
            </button>
          </div>
        </>
      )}
    </>
  );
}

function AboutSection() {
  const server = useActiveServer();
  const open = (url: string) => platform.openExternal(url);
  return (
    <>
      <div className="about-hero">
        <Logo size={52} />
        <h1>Zuna</h1>
        <p className="muted">Version 0.1.0 · Free software under the AGPL-3.0 license</p>
      </div>
      <div className="notice">
        <ShieldCheck size={15} />
        <span>
          Messages use MLS (RFC 9420) through the independently audited OpenMLS library. Your server stores only ciphertext. {server && <>Connected to {server.entry.name}{server.info ? `, running server version ${server.info.version}` : ""}.</>}
        </span>
      </div>
      <div className="row">
        <button className="btn" onClick={() => open(PROJECT_URL)}>Source code</button>
        <button className="btn" onClick={() => open(`${PROJECT_URL}/blob/main/SECURITY.md`)}>Security model</button>
        <button className="btn" onClick={() => open(TERMS_URL)}>Terms of Use</button>
      </div>
    </>
  );
}

export function Settings({ initialSection, onClose }: { initialSection?: string; onClose: () => void }) {
  const [section, setSection] = useState(initialSection ?? "profile");
  const setOverlay = useApp((state) => state.setOverlay);
  return (
    <SettingsFrame
      title="Settings"
      sections={SECTIONS}
      section={section}
      onSection={setSection}
      onClose={onClose}
    >
      {section === "profile" && <ProfileSection />}
      {section === "privacy" && <PrivacySection />}
      {section === "notifications" && <NotificationsSection />}
      {section === "voice" && <VoiceSettingsSection />}
      {section === "screen" && <ScreenSettingsSection />}
      {section === "appearance" && <AppearanceSection />}
      {section === "security" && <SecuritySection />}
      {section === "about" && <AboutSection />}
      {section === "profile" && (
        <>
          <div className="settings-divider" />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-danger" onClick={() => setOverlay({ type: "server-settings", section: "leave" })}>
              <LogOut size={15} /> Sign out of this server
            </button>
            <button className="btn" onClick={() => setOverlay({ type: "server-settings", section: "delete" })}>
              <Trash2 size={15} /> Delete account
            </button>
          </div>
        </>
      )}
    </SettingsFrame>
  );
}
