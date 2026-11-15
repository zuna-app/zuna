import type { DeviceView, ServerDataExport, ServerDataKind } from "@zuna/core";
import {
  Bell,
  Camera,
  Check,
  Mic,
  MonitorUp,
  Copy,
  Download,
  Info,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Palette,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { platform } from "@/platform";
import { Avatar, Confirm, ConfirmPasswordField, Field, Logo, PasswordField, Spinner, Switch, useAction, useReturnFocus } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { useEscape } from "@/lib/escape";
import { LANGUAGES, languageChoice, mark, resolveLanguage, t, tx, type MessageKey } from "@/lib/i18n";
import { PROJECT_URL, TERMS_URL } from "@/lib/links";
import { formatFull, MIN_PASSWORD } from "@/lib/format";
import { usePasswordStrength } from "@/lib/password";
import { prepareAvatar } from "@/lib/media";
import type { AppSettings } from "@/state/settings";
import { useActiveServer, useApp } from "@/state/store";
import { ScreenSettingsSection } from "@/features/voice/ScreenSettings";
import { VoiceSettingsSection } from "@/features/voice/VoiceSettings";

// Each swatch takes its colors from the accent's own tokens (styles/tokens.css), by data-accent.
const ACCENTS: { id: AppSettings["accent"]; label: MessageKey }[] = [
  { id: "neutral", label: mark("settings.appearance.accentNeutral") },
  { id: "blue", label: mark("settings.appearance.accentBlue") },
  { id: "green", label: mark("settings.appearance.accentGreen") },
  { id: "red", label: mark("settings.appearance.accentRed") },
  { id: "amber", label: mark("settings.appearance.accentAmber") },
];

const MESSAGE_SIZES: { id: AppSettings["messageSize"]; label: MessageKey }[] = [
  { id: "small", label: mark("settings.appearance.sizeSmall") },
  { id: "medium", label: mark("settings.appearance.sizeMedium") },
  { id: "large", label: mark("settings.appearance.sizeLarge") },
];

const SECTIONS = [
  { id: "profile", label: mark("settings.sections.profile"), icon: UserRound },
  { id: "privacy", label: mark("settings.sections.privacy"), icon: Lock },
  { id: "notifications", label: mark("settings.sections.notifications"), icon: Bell },
  { id: "voice", label: mark("settings.sections.voice"), icon: Mic },
  { id: "screen", label: mark("settings.sections.screen"), icon: MonitorUp },
  { id: "appearance", label: mark("settings.sections.appearance"), icon: Palette },
  { id: "security", label: mark("settings.sections.security"), icon: ShieldCheck },
  { id: "data", label: mark("settings.sections.data"), icon: Server },
  { id: "about", label: mark("settings.sections.about"), icon: Info },
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
          <button className="icon-btn settings-close" onClick={onClose} aria-label={t("settings.close")}>
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
      <h1>{t("settings.sections.profile")}</h1>
      <p className="settings-lead">{t("settings.profile.lead", { server: server?.entry.name ?? "" })}</p>
      <div className="profile-edit">
        <div className="avatar-edit">
          <Avatar name={self.displayName} seed={self.id} avatar={self.avatar} size={72} />
          <button className="avatar-edit-button" onClick={() => fileInput.current?.click()} aria-label={t("settings.profile.changePicture")}>
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
              {t("settings.profile.removePicture")}
            </button>
          )}
        </div>
      </div>
      <Field label={t("settings.profile.displayName")} value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)} />
      <label className="field">
        <span className="field-label">{t("settings.profile.bio")}</span>
        <textarea className="textarea" value={bio} maxLength={300} placeholder={t("settings.profile.bioPlaceholder")} onChange={(event) => setBio(event.target.value)} />
      </label>
      <div>
        <button
          className="btn btn-primary"
          disabled={!dirty || !displayName.trim() || busy}
          onClick={() =>
            run(async () => {
              await session().updateProfile({ displayName: displayName.trim(), bio });
              toast(t("settings.profile.saved"));
            })
          }
        >
          {busy ? <Spinner /> : t("common.saveChanges")}
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
      <h1>{t("settings.sections.privacy")}</h1>
      <p className="settings-lead">{t("settings.privacy.lead", { server: server.entry.name })}</p>
      <SettingRow title={t("settings.privacy.readReceipts")} hint={t("settings.privacy.readReceiptsHint")}>
        <Switch on={server.prefs.sendReadReceipts} onChange={(value) => void session().updatePreferences({ sendReadReceipts: value })} label={t("settings.privacy.readReceipts")} />
      </SettingRow>
      <SettingRow title={t("settings.privacy.showOnline")} hint={t("settings.privacy.showOnlineHint")}>
        <Switch on={!self.hidesLastSeen} onChange={(value) => void run(() => session().setHideLastSeen(!value))} label={t("settings.privacy.showOnline")} />
      </SettingRow>
      <div className="settings-divider" />
      <h3>{t("settings.privacy.blocked")}</h3>
      {blocked.length === 0 && <p className="setting-hint">{t("settings.privacy.blockedEmpty")}</p>}
      {blocked.map((user) => (
        <div key={user.id} className="setting-row">
          <Avatar name={user.displayName} seed={user.id} avatar={user.avatar} size={32} />
          <span className="grow">
            <b>{user.displayName}</b>
            {!user.deleted && <span className="setting-hint">@{user.username}</span>}
          </span>
          <button className="btn btn-small" onClick={() => void run(() => session().setBlocked(user.id, false))}>
            {t("settings.privacy.unblock")}
          </button>
        </div>
      ))}
      <p className="setting-hint">{t("settings.privacy.blockedHint")}</p>
      <div className="settings-divider" />
      <h3>{t("settings.privacy.onThisDevice")}</h3>
      <SettingRow title={t("settings.privacy.linkPreviews")} hint={t("settings.privacy.linkPreviewsHint")}>
        <Switch on={settings.linkPreviews} onChange={(value) => update({ linkPreviews: value })} label={t("settings.privacy.linkPreviews")} />
      </SettingRow>
      <SettingRow title={t("settings.privacy.removeMetadata")} hint={t("settings.privacy.removeMetadataHint")}>
        <Switch
          on={settings.removeMetadata}
          onChange={(value) => (value ? update({ removeMetadata: true }) : setConfirmingKeep(true))}
          label={t("settings.privacy.removeMetadata")}
        />
      </SettingRow>
      <SettingRow title={t("settings.privacy.playYouTube")} hint={t("settings.privacy.playYouTubeHint")}>
        <Switch on={settings.playYouTube} onChange={(value) => update({ playYouTube: value })} label={t("settings.privacy.playYouTube")} />
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
    <Confirm title={t("settings.privacy.keepMetadataTitle")} action={t("settings.privacy.keepMetadataAction")} width={440} onCancel={onCancel} onConfirm={onConfirm}>
      <p style={{ fontSize: 13.5 }}>{t("settings.privacy.keepMetadataText")}</p>
      <p className="muted" style={{ fontSize: 13.5 }}>{t("settings.privacy.keepMetadataNote")}</p>
    </Confirm>
  );
}

function NotificationsSection() {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  const [permission, setPermission] = useState(() => platform.notificationPermission());
  useEffect(() => platform.onNotificationPermission(setPermission), []);
  // Turning them on is a click, which is when a browser can ask.
  const setNotifications = async (value: boolean) => {
    update({ notifications: value });
    if (value) {
      await platform.askToNotify();
      setPermission(platform.notificationPermission());
    }
  };
  return (
    <>
      <h1>{t("settings.sections.notifications")}</h1>
      <p className="settings-lead">{t("settings.notifications.lead")}</p>
      <SettingRow
        title={t("settings.notifications.desktop")}
        hint={settings.notifications && permission === "denied" ? t("settings.notifications.blockedByBrowser") : t("settings.notifications.desktopHint")}
      >
        <Switch on={settings.notifications} onChange={(value) => void setNotifications(value)} label={t("settings.notifications.desktop")} />
      </SettingRow>
      <SettingRow title={t("settings.notifications.sound")}>
        <Switch on={settings.notificationSound} onChange={(value) => update({ notificationSound: value })} label={t("settings.notifications.soundLabel")} />
      </SettingRow>
      <SettingRow title={t("settings.notifications.preview")} hint={t("settings.notifications.previewHint")}>
        <select className="select" style={{ width: 180 }} value={settings.notificationPreview} onChange={(event) => update({ notificationPreview: event.target.value as AppSettings["notificationPreview"] })}>
          <option value="full">{t("settings.notifications.previewFull")}</option>
          <option value="sender">{t("settings.notifications.previewSender")}</option>
          <option value="none">{t("settings.notifications.previewNone")}</option>
        </select>
      </SettingRow>
    </>
  );
}

function AppearanceSection() {
  const settings = useApp((state) => state.settings);
  const update = useApp((state) => state.updateSettings);
  const setOverlay = useApp((state) => state.setOverlay);
  return (
    <>
      <h1>{t("settings.sections.appearance")}</h1>
      <SettingRow title={t("settings.appearance.language")} hint={t("settings.appearance.languageHintBrowser")}>
        <select
          className="select"
          style={{ width: 180 }}
          // The language shown, the browser's until another is picked.
          value={resolveLanguage(settings.language)}
          onChange={(event) => {
            // The app is drawn again in the new language, Settings with it, which then opens here.
            setOverlay({ type: "settings", section: "appearance" });
            update({ language: languageChoice(event.target.value) });
          }}
          aria-label={t("settings.appearance.language")}
        >
          {/* Each language by its own name, which is never translated. */}
          {LANGUAGES.map((language) => (
            <option key={language.tag} value={language.tag} lang={language.tag}>
              {language.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <div className="field">
        <span className="field-label">{t("settings.appearance.accent")}</span>
        <div className="accent-row">
          {ACCENTS.map((accent) => (
            <button key={accent.id} className={`accent-swatch${settings.accent === accent.id ? " is-active" : ""}`} data-accent={accent.id} onClick={() => update({ accent: accent.id })} aria-label={t(accent.label)} aria-pressed={settings.accent === accent.id}>
              {settings.accent === accent.id && <Check size={15} strokeWidth={2.5} />}
            </button>
          ))}
        </div>
      </div>
      <SettingRow title={t("settings.appearance.messageSize")}>
        <div className="segmented">
          {MESSAGE_SIZES.map((size) => (
            <button key={size.id} className={settings.messageSize === size.id ? "is-active" : ""} onClick={() => update({ messageSize: size.id })}>
              {t(size.label)}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow title={t("settings.appearance.reduceMotion")} hint={t("settings.appearance.reduceMotionHint")}>
        <Switch on={settings.reduceMotion} onChange={(value) => update({ reduceMotion: value })} label={t("settings.appearance.reduceMotion")} />
      </SettingRow>
      <SettingRow title={t("settings.appearance.enterToSend")} hint={t("settings.appearance.enterToSendHint")}>
        <Switch on={settings.enterToSend} onChange={(value) => update({ enterToSend: value })} label={t("settings.appearance.enterToSend")} />
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
      <span className="field-label">{t("settings.devices.title")}</span>
      <div className="device-list">
        {devices.map((device) => (
          <div key={device.id} className="device-row">
            <span className="device-icon"><Laptop size={18} /></span>
            <span className="grow">
              <span style={{ display: "block", fontWeight: 500 }}>
                {device.name}
                {device.isCurrent && <span className="device-current">{t("settings.devices.thisDevice")}</span>}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>{t("settings.devices.signedIn", { when: formatFull(device.createdAt) })}</span>
            </span>
            {!device.isCurrent && (
              <button className="btn btn-small btn-danger" onClick={() => run(() => session().revokeDevice(device.id))}>
                <Trash2 size={13} /> {t("common.remove")}
              </button>
            )}
          </div>
        ))}
      </div>
      {server && (
        // A server that makes its own certificate needs its pin too, which only its links carry.
        <span className="field-hint">
          {tx("settings.devices.addDevice", { address: <span className="mono selectable" style={{ overflowWrap: "anywhere" }}>{server.entry.address}</span> })}
        </span>
      )}
    </div>
  );
}

function SecuritySection() {
  const session = useApp((state) => state.session);
  const toast = useApp((state) => state.toast);
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
      <h1>{t("settings.sections.security")}</h1>
      <div className="notice is-warn">
        <Lock size={15} />
        <span>{platform.keyWarning}</span>
      </div>
      <SettingRow title={t("settings.security.securityKey")} hint={t("settings.security.securityKeyHint")}>
        <button className="btn btn-small" onClick={() => server?.self && setOverlay({ type: "verify", userId: server.self.userId })}>
          <KeyRound size={14} /> {t("settings.security.view")}
        </button>
      </SettingRow>
      <DevicesCard />
      <div className="settings-divider" />
      <h3>{t("settings.security.changePassword")}</h3>
      <PasswordField label={t("settings.security.currentPassword")} value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} />
      <PasswordField label={t("settings.security.newPassword")} value={next} autoComplete="new-password" hint={next ? strength.label : t("settings.security.passwordMinimum", { count: MIN_PASSWORD })} onChange={(event) => setNext(event.target.value)} />
      <ConfirmPasswordField label={t("settings.security.confirmNewPassword")} password={next} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
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
              toast(t("settings.security.passwordChanged"));
            })
          }
        >
          {busy ? <Spinner /> : t("settings.security.changePassword")}
        </button>
      </div>
      <div className="settings-divider" />
      <h3>{t("settings.security.recoveryKey")}</h3>
      <p className="muted" style={{ fontSize: 13.5 }}>{t("settings.security.recoveryKeyHint")}</p>
      {recoveryKey ? (
        <div className="col">
          <div className="recovery-key mono selectable">
            {recoveryKey.split("-").map((part, index) => <span key={index}>{part}</span>)}
          </div>
          <button className="btn" onClick={() => void copyText(recoveryKey).then(() => toast(t("common.copied")))}>
            <Copy size={14} /> {t("common.copy")}
          </button>
        </div>
      ) : (
        <>
          <PasswordField label={t("settings.security.currentPassword")} value={recoveryPassword} autoComplete="current-password" onChange={(event) => setRecoveryPassword(event.target.value)} />
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
              {t("settings.security.newRecoveryKey")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

const DATA_TAGS: Record<ServerDataKind, MessageKey> = {
  readable: mark("settings.data.tagReadable"),
  encrypted: mark("settings.data.tagEncrypted"),
  public: mark("settings.data.tagPublic"),
  withheld: mark("settings.data.tagWithheld"),
  none: mark("settings.data.tagNone"),
};

/** Everything the server says it keeps about the account, in the core's plain words, and saved as its own answer. */
function ServerDataSection() {
  const session = useApp((state) => state.session);
  const server = useActiveServer();
  const [data, setData] = useState<{ serverId: string; export: ServerDataExport } | null>(null);
  const { busy, run } = useAction();
  const serverId = server?.entry.id;
  const ask = () => serverId && run(async () => setData({ serverId, export: await session().exportServerData() }));
  useEffect(() => {
    void ask();
    // Asked again only for another server, or by the button.
  }, [serverId]);
  if (!server) return null;
  const shown = data && data.serverId === serverId ? data.export : null;
  const save = (exported: ServerDataExport) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([exported.json], { type: "application/json" }));
    link.download = exported.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
  };
  return (
    <>
      <h1>{t("settings.sections.data")}</h1>
      <p className="settings-lead">{t("settings.data.lead", { server: server.entry.name })}</p>
      <div className="row" style={{ gap: 8 }}>
        {shown && (
          <button className="btn btn-primary" onClick={() => save(shown)}>
            <Download size={15} /> {t("common.saveAsFile")}
          </button>
        )}
        <button className="btn" disabled={busy} onClick={() => void ask()}>
          {busy ? <Spinner /> : <RefreshCw size={14} />} {shown ? t("settings.data.askAgain") : t("settings.data.ask")}
        </button>
      </div>
      {shown?.sections.map((section) => (
        <section key={section.id} className="data-section">
          <h3>{section.title}</h3>
          <p>{section.about}</p>
          <div className="data-rows">
            {section.rows.map((row, index) => (
              <div key={index} className="data-row">
                <span className="grow" style={{ minWidth: 0 }}>
                  <b>{row.label}</b>
                  {row.note && <span className="data-note">{row.note}</span>}
                </span>
                <span className="data-value">
                  <span className="selectable">{row.value}</span>
                  <span className={`data-tag is-${row.kind}`}>{t(DATA_TAGS[row.kind])}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {shown && (
        <p className="data-footnote">{t("settings.data.footnote", { server: server.entry.name })}</p>
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
        <p className="muted">{t("settings.about.version", { version: import.meta.env.ZUNA_VERSION })}</p>
      </div>
      <div className="notice">
        <ShieldCheck size={15} />
        <span>
          {t("settings.about.encryption")}{" "}
          {server &&
            (server.info
              ? t("settings.about.connectedVersion", { server: server.entry.name, version: server.info.version })
              : t("settings.about.connected", { server: server.entry.name }))}
        </span>
      </div>
      <div className="row">
        <button className="btn" onClick={() => open(PROJECT_URL)}>{t("settings.about.sourceCode")}</button>
        <button className="btn" onClick={() => open(`${PROJECT_URL}/blob/main/SECURITY.md`)}>{t("settings.about.securityModel")}</button>
        <button className="btn" onClick={() => open(TERMS_URL)}>{t("settings.about.terms")}</button>
      </div>
    </>
  );
}

export function Settings({ initialSection, onClose }: { initialSection?: string; onClose: () => void }) {
  const [section, setSection] = useState(initialSection ?? "profile");
  const setOverlay = useApp((state) => state.setOverlay);
  return (
    <SettingsFrame
      title={t("settings.title")}
      sections={SECTIONS.map((item) => ({ ...item, label: t(item.label) }))}
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
      {section === "data" && <ServerDataSection />}
      {section === "about" && <AboutSection />}
      {section === "profile" && (
        <>
          <div className="settings-divider" />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-danger" onClick={() => setOverlay({ type: "server-settings", section: "leave" })}>
              <LogOut size={15} /> {t("settings.account.signOut")}
            </button>
            <button className="btn btn-danger" onClick={() => setOverlay({ type: "server-settings", section: "delete" })}>
              <Trash2 size={15} /> {t("settings.account.delete")}
            </button>
          </div>
        </>
      )}
    </SettingsFrame>
  );
}
