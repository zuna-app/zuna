import type { DeviceView } from "@zuna/core";
import {
  Bell,
  Camera,
  Check,
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
import { desktop } from "@/core/bridge";
import { Avatar, Field, Logo, PasswordField, Spinner, Switch, useAction, useReturnFocus } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { PROJECT_URL } from "@/lib/links";
import { formatFull, passwordStrength } from "@/lib/format";
import { prepareAvatar } from "@/lib/media";
import type { AppSettings } from "@/state/settings";
import { useActiveServer, useApp } from "@/state/store";

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
  const { run } = useAction();
  const self = server?.self ? server.users[server.self.userId] : null;
  if (!server || !self) return null;
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
    </>
  );
}

function NotificationsSection() {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  return (
    <>
      <h1>Notifications</h1>
      <p className="settings-lead">Previews are decrypted on this device. No notification service ever sees them.</p>
      <SettingRow title="Desktop notifications">
        <Switch
          on={settings.notifications}
          onChange={(value) => {
            update({ notifications: value });
            if (value && !desktop && "Notification" in window) void Notification.requestPermission();
          }}
          label="Desktop notifications"
        />
      </SettingRow>
      <SettingRow title="Sound">
        <Switch on={settings.notificationSound} onChange={(value) => update({ notificationSound: value })} label="Notification sound" />
      </SettingRow>
      <SettingRow
        title="Away from the computer after"
        hint="Until then, notifications show here and your phone keeps quiet. Locking the screen counts as away right away."
      >
        <select
          className="select"
          style={{ width: 180 }}
          value={settings.awayAfterMinutes}
          onChange={(event) => update({ awayAfterMinutes: Number(event.target.value) as AppSettings["awayAfterMinutes"] })}
        >
          {([1, 3, 5, 10] as const).map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 1 ? "1 minute" : `${minutes} minutes`}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="What notifications show" hint="Choose less if others can see your screen.">
        <select className="select" style={{ width: 180 }} value={settings.notificationPreview} onChange={(event) => update({ notificationPreview: event.target.value as AppSettings["notificationPreview"] })}>
          <option value="full">Sender and message</option>
          <option value="sender">Sender only</option>
          <option value="none">Nothing</option>
        </select>
      </SettingRow>
      {desktop && (
        <SettingRow title="Keep running when closed" hint="Zuna stays in the system tray so messages still arrive.">
          <Switch on={settings.closeToTray} onChange={(value) => update({ closeToTray: value })} label="Keep running when closed" />
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
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const { busy, run } = useAction();
  const strength = passwordStrength(next);

  return (
    <>
      <h1>Security</h1>
      {!keyProtected && desktop && (
        <div className="notice is-warn">
          <Lock size={15} />
          <span>Your system has no keychain available, so Zuna can't lock its local data to your login. Installing a secret service such as GNOME Keyring fixes this.</span>
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
      <PasswordField label="New password" value={next} autoComplete="new-password" hint={next ? strength.label : "At least 10 characters."} onChange={(event) => setNext(event.target.value)} />
      <div>
        <button
          className="btn"
          disabled={!current || next.length < 10 || strength.score < 2 || busy}
          onClick={() =>
            run(async () => {
              await session().changePassword(current, next);
              setCurrent("");
              setNext("");
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
  const open = (url: string) => {
    if (desktop) void desktop.openExternal(url);
    else window.open(url, "_blank");
  };
  return (
    <>
      <div className="about-hero">
        <Logo size={52} />
        <h1>Zuna</h1>
        <p className="muted">Version 0.1.0 · Free software under the GPL-3.0 license</p>
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
      {section === "appearance" && <AppearanceSection />}
      {section === "security" && <SecuritySection />}
      {section === "about" && <AboutSection />}
      {section === "profile" && (
        <>
          <div className="settings-divider" />
          <button className="btn btn-danger" style={{ alignSelf: "flex-start" }} onClick={() => setOverlay({ type: "server-settings", section: "leave" })}>
            <LogOut size={15} /> Sign out of this server
          </button>
        </>
      )}
    </SettingsFrame>
  );
}
