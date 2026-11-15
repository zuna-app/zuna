// First-run flow. It's also reused inside the app for joining another server.

import type { InvitePreview } from "@zuna/core";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Download, KeyRound, LinkIcon, Lock, Server, ShieldCheck, Users } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { platform } from "@/platform";
import { Avatar, ConfirmPasswordField, Field, Logo, PasswordField, Spinner } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { t, tx } from "@/lib/i18n";
import { PROJECT_URL, TERMS_URL } from "@/lib/links";
import { MIN_PASSWORD } from "@/lib/format";
import { usePasswordStrength } from "@/lib/password";
import { useApp } from "@/state/store";

type Step =
  | { name: "welcome" }
  | { name: "link" }
  | { name: "signin"; url?: string }
  | { name: "recover"; url: string; username: string }
  | { name: "invite"; preview: InvitePreview }
  | { name: "recovery-key"; serverId: string; recoveryKey: string; setup: boolean }
  | { name: "name-server"; serverId: string };

/** What went wrong, as the core said it, in the person's language, or that the server couldn't be reached. */
function describeError(error: unknown): string {
  const { message, code } = error as { message?: string; code?: string };
  // The core marks a server it couldn't reach with its code; a fetch that failed outside it has none.
  if (code === "network" || (!code && /fetch/i.test(message ?? ""))) return t("onboarding.errors.unreachable");
  return message || t("onboarding.errors.generic");
}

/** The server's codes for a username it won't take, shown under the username rather than the form. */
const USERNAME_ERRORS = new Set(["invalid_username", "username_taken"]);

export function Onboarding() {
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <JoinFlow />
      </div>
    </div>
  );
}

/** Join, sign in or recover. `onDone` runs after the account is ready. */
export function JoinFlow({ initialLink, initialSignInUrl, onDone, embedded }: { initialLink?: string; initialSignInUrl?: string; onDone?: () => void; embedded?: boolean }) {
  const [step, setStep] = useState<Step>(
    initialSignInUrl ? { name: "signin", url: initialSignInUrl } : embedded || initialLink ? { name: "link" } : { name: "welcome" },
  );
  // Inside the app, for another server, the link is the first screen.
  const home: Step = embedded ? { name: "link" } : { name: "welcome" };
  // The link as it was last entered, there again on coming back to it. One opened from
  // outside goes ahead by itself only the first time, or Back would bounce forward again.
  const [link, setLink] = useState(initialLink ?? "");
  const [linkGoesAhead, setLinkGoesAhead] = useState(Boolean(initialLink));
  const leaveLink = (next: Step) => {
    setLinkGoesAhead(false);
    setStep(next);
  };
  const addServer = useApp((state) => state.addServer);
  const core = useApp((state) => state.core)!;

  const finish = async (serverId: string) => {
    await addServer(serverId);
    onDone?.();
  };

  return (
    <>
      <div key={step.name} className="onboarding-step">
        {step.name === "welcome" && (
          <WelcomeStep onJoin={() => setStep({ name: "link" })} onSignIn={() => setStep({ name: "signin" })} />
        )}
        {step.name === "link" && (
          <InviteLinkStep
            embedded={embedded}
            initialLink={link}
            goAhead={linkGoesAhead}
            onBack={embedded ? undefined : () => leaveLink({ name: "welcome" })}
            onInvite={(preview, used) => {
              setLink(used);
              leaveLink({ name: "invite", preview });
            }}
            onSignIn={() => leaveLink({ name: "signin" })}
          />
        )}
        {step.name === "invite" && (
          <InviteStep
            preview={step.preview}
            onBack={() => setStep({ name: "link" })}
            onCreated={(serverId, recoveryKey) =>
              setStep({ name: "recovery-key", serverId, recoveryKey, setup: step.preview.setup })
            }
          />
        )}
        {step.name === "recovery-key" && (
          <RecoveryKeyStep
            recoveryKey={step.recoveryKey}
            onDone={() => {
              if (step.setup) setStep({ name: "name-server", serverId: step.serverId });
              else void finish(step.serverId);
            }}
          />
        )}
        {step.name === "name-server" && <NameServerStep serverId={step.serverId} onDone={() => void finish(step.serverId)} />}
        {step.name === "signin" && (
          <SignInStep
            initialUrl={step.url}
            onBack={() => setStep(home)}
            onForgot={(url, username) => setStep({ name: "recover", url, username })}
            onSignedIn={(serverId) => void finish(serverId)}
          />
        )}
        {step.name === "recover" && (
          <RecoverStep
            url={step.url}
            username={step.username}
            onBack={() => setStep({ name: "signin", url: step.url })}
            onRecovered={(serverId) => void finish(serverId)}
            client={core.client}
          />
        )}
      </div>
    </>
  );
}

function StepHeader({ icon, title, children, onBack }: { icon?: ReactNode; title: string; children?: ReactNode; onBack?: () => void }) {
  return (
    <div className="step-header">
      {onBack && (
        <button type="button" className="icon-btn step-back" onClick={onBack} aria-label={t("common.back")}>
          <ArrowLeft size={18} />
        </button>
      )}
      {icon && <div className="step-icon">{icon}</div>}
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </div>
  );
}

/** The first screen: what Zuna is, and the two ways in, as on iOS. */
function WelcomeStep({ onJoin, onSignIn }: { onJoin: () => void; onSignIn: () => void }) {
  return (
    <div className="col" style={{ gap: 26 }}>
      <div className="step-header">
        <div className="hero-logo">
          <Logo size={64} />
        </div>
        <h1>{t("onboarding.welcome.title")}</h1>
        <p>{t("onboarding.welcome.tagline")}</p>
        <div className="trust-chips">
          <span><Lock size={13} /> {t("onboarding.welcome.encrypted")}</span>
          <span><ShieldCheck size={13} /> {t("onboarding.welcome.openSource")}</span>
          <span><Server size={13} /> {t("onboarding.welcome.selfHosted")}</span>
        </div>
      </div>
      <div className="col" style={{ gap: 10 }}>
        <button type="button" className="btn btn-primary btn-large btn-block" onClick={onJoin}>
          <LinkIcon size={16} /> {t("onboarding.welcome.join")}
        </button>
        <button type="button" className="btn btn-large btn-block" onClick={onSignIn}>
          {t("onboarding.signIn.title")}
        </button>
        <button
          type="button"
          className="link-button step-host"
          onClick={() => {
            platform.openExternal(`${PROJECT_URL}/blob/main/docs/SELF_HOSTING.md`);
          }}
        >
          <Server size={14} /> {t("onboarding.welcome.host")} <ArrowUpRight size={14} />
        </button>
      </div>
    </div>
  );
}

/** The invite link, pasted or typed. A plain address works for servers with open sign-ups.
 * Inside the app, for another server, it's the first screen, with signing in under it. */
function InviteLinkStep({
  embedded,
  initialLink,
  goAhead,
  onBack,
  onInvite,
  onSignIn,
}: {
  embedded?: boolean;
  initialLink: string;
  goAhead: boolean;
  onBack?: () => void;
  onInvite: (preview: InvitePreview, link: string) => void;
  onSignIn: () => void;
}) {
  const [link, setLink] = useState(initialLink);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const core = useApp((state) => state.core)!;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!link.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onInvite(await core.client.previewInvite(link.trim()), link.trim());
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const tried = useRef(false);
  useEffect(() => {
    if (goAhead && initialLink && !tried.current) {
      tried.current = true;
      void submit();
    }
  }, [goAhead, initialLink]);

  return (
    <form onSubmit={submit} className="col" style={{ gap: 18 }}>
      <StepHeader icon={<LinkIcon size={26} />} title={t("onboarding.link.title")} onBack={onBack}>
        {t("onboarding.link.lead")}
      </StepHeader>
      <Field
        placeholder="https://chat.example.com/invite/..."
        value={link}
        onChange={(event) => {
          setLink(event.target.value);
          setError(null);
        }}
        error={error}
        autoFocus
        spellCheck={false}
        aria-label={t("onboarding.link.label")}
      />
      <button className="btn btn-primary btn-large btn-block" disabled={!link.trim() || busy}>
        {busy ? <Spinner /> : <>{t("common.continue")} <ArrowRight size={17} /></>}
      </button>
      {/* On the first run the welcome screen offers signing in, one step back. */}
      {embedded && (
        <button type="button" className="btn btn-large btn-block" onClick={onSignIn}>
          {t("onboarding.link.haveAccount")}
        </button>
      )}
    </form>
  );
}

function suggestUsername(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 32);
}

function StrengthMeter({ strength }: { strength: { score: number; label: string } }) {
  const { score, label } = strength;
  const colors = ["var(--bg-5)", "var(--red)", "var(--amber)", "var(--text-2)", "var(--green)"];
  return (
    <div className="strength" aria-live="polite">
      <div className="strength-bars">
        {[1, 2, 3, 4].map((bar) => (
          <i key={bar} style={{ background: score >= bar ? colors[score] : "var(--bg-4)" }} />
        ))}
      </div>
      <span style={{ color: score ? colors[score] : "var(--text-3)" }}>{label || t("onboarding.passwordMinimum", { count: MIN_PASSWORD })}</span>
    </div>
  );
}

function InviteStep({
  preview,
  onBack,
  onCreated,
}: {
  preview: InvitePreview;
  onBack: () => void;
  onCreated: (serverId: string, recoveryKey: string) => void;
}) {
  const core = useApp((state) => state.core)!;
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [failure, setFailure] = useState<{ message: string; username: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const server = preview.server;

  const validUsername = /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,31}$/.test(username);
  const strength = usePasswordStrength(password, [username, displayName]);
  const canSubmit = displayName.trim() && validUsername && password.length >= MIN_PASSWORD && strength.score >= 2 && confirm === password && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !strength.accepts()) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await core.client.register(preview, username, password, { displayName: displayName.trim() });
      onCreated(result.serverId, result.recoveryKey);
    } catch (error) {
      setFailure({ message: describeError(error), username: USERNAME_ERRORS.has((error as { code?: string }).code ?? "") });
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="col" style={{ gap: 14 }}>
      <div className="invite-preview">
        <button type="button" className="icon-btn step-back" onClick={onBack} aria-label={t("common.back")}>
          <ArrowLeft size={18} />
        </button>
        <Avatar name={server.name} seed={preview.url} size={56} rounded imageUrl={server.has_icon ? `${preview.url}/api/icon` : null} />
        <h1>{preview.setup ? t("onboarding.invite.setUpTitle") : t("onboarding.invite.joinTitle", { server: server.name })}</h1>
        <p className="muted">
          {preview.setup ? (
            t("onboarding.invite.owner")
          ) : server.user_count > 0 ? (
            <span className="row" style={{ gap: 5, justifyContent: "center" }}>
              <Users size={13} /> {t("onboarding.invite.members", { count: server.user_count })}
            </span>
          ) : (
            t("onboarding.invite.openSignUps")
          )}
        </p>
      </div>
      <Field
        label={t("onboarding.invite.yourName")}
        placeholder={t("onboarding.invite.yourNamePlaceholder")}
        value={displayName}
        autoFocus
        maxLength={64}
        onChange={(event) => {
          setDisplayName(event.target.value);
          if (!usernameEdited) setUsername(suggestUsername(event.target.value));
        }}
      />
      <Field
        label={t("common.username")}
        placeholder={t("onboarding.invite.usernamePlaceholder")}
        value={username}
        spellCheck={false}
        maxLength={32}
        hint={t("onboarding.invite.usernameHint")}
        error={failure?.username ? failure.message : username && !validUsername ? t("onboarding.invite.usernameInvalid") : null}
        onChange={(event) => {
          setUsername(event.target.value);
          setUsernameEdited(true);
          setFailure(null);
        }}
      />
      <div className="field">
        <PasswordField
          label={t("common.password")}
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        <StrengthMeter strength={strength} />
      </div>
      <ConfirmPasswordField password={password} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      <div className="notice">
        <Lock size={15} />
        <span>{t("onboarding.invite.passwordNote")}</span>
      </div>
      {failure && !failure.username && <div className="field-error">{failure.message}</div>}
      <button className="btn btn-primary btn-large btn-block" disabled={!canSubmit}>
        {busy ? (
          <>
            <Spinner /> {t("onboarding.invite.securing")}
          </>
        ) : (
          t("onboarding.invite.create")
        )}
      </button>
      <p className="faint" style={{ fontSize: 12.5, textAlign: "center", margin: 0 }}>
        {tx("onboarding.invite.terms", {
          terms: (
            <button type="button" className="link-button" onClick={() => platform.openExternal(TERMS_URL)}>
              {t("onboarding.invite.termsLink")}
            </button>
          ),
        })}
      </p>
    </form>
  );
}

function RecoveryKeyStep({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await copyText(recoveryKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const blob = new Blob([`${t("onboarding.recovery.fileTitle")}\n\n${recoveryKey}\n\n${t("onboarding.recovery.fileNote")}\n`], {
      type: "text/plain",
    });
    // In the page while it's clicked, and the address kept for a while after, as some
    // WebKit versions drop a download whose address goes at once, and this file is the
    // account's only way back.
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "zuna-recovery-key.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <StepHeader icon={<KeyRound size={26} />} title={t("onboarding.recovery.title")}>
        {t("onboarding.recovery.lead")}
      </StepHeader>
      <div className="recovery-key mono selectable">
        {recoveryKey.split("-").map((part, index) => (
          <span key={index}>{part}</span>
        ))}
      </div>
      <div className="row">
        <button className="btn grow" onClick={copy}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? t("common.copied") : t("common.copy")}
        </button>
        <button className="btn grow" onClick={download}>
          <Download size={15} /> {t("common.saveAsFile")}
        </button>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        <span className="check-box">{saved && <Check size={13} strokeWidth={3} />}</span>
        {t("onboarding.recovery.stored")}
      </label>
      <button className="btn btn-primary btn-large btn-block" disabled={!saved} onClick={onDone}>
        {t("common.continue")}
      </button>
    </div>
  );
}

function NameServerStep({ serverId, onDone }: { serverId: string; onDone: () => void }) {
  const core = useApp((state) => state.core)!;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (name.trim()) await core.session(serverId).updateServerSettings({ name: name.trim() });
    } finally {
      onDone();
    }
  };

  return (
    <form onSubmit={submit} className="col" style={{ gap: 16 }}>
      <StepHeader icon={<Server size={26} />} title={t("onboarding.nameServer.title")}>
        {t("onboarding.nameServer.lead")}
      </StepHeader>
      <Field placeholder={t("onboarding.nameServer.placeholder")} value={name} autoFocus maxLength={64} onChange={(event) => setName(event.target.value)} />
      <button className="btn btn-primary btn-large btn-block" disabled={busy}>
        {busy ? <Spinner /> : name.trim() ? t("onboarding.nameServer.finish") : t("onboarding.nameServer.skip")}
      </button>
    </form>
  );
}

function SignInStep({
  initialUrl,
  onBack,
  onForgot,
  onSignedIn,
}: {
  initialUrl?: string;
  onBack: () => void;
  onForgot: (url: string, username: string) => void;
  onSignedIn: (serverId: string) => void;
}) {
  const core = useApp((state) => state.core)!;
  // Only `npm run dev:web` sets these, for its local test server. They're empty in a real build.
  // npm run dev:web fills the form in with the test server's account. A build never reads
  // these, so nothing a shell happens to hold under those names goes into it.
  const dev: { server?: string; username?: string; password?: string } = import.meta.env.DEV
    ? { server: import.meta.env.ZUNA_DEV_SERVER, username: import.meta.env.ZUNA_DEV_USERNAME, password: import.meta.env.ZUNA_DEV_PASSWORD }
    : {};
  const [url, setUrl] = useState(initialUrl ?? dev.server ?? platform.defaultServer ?? "");
  const [username, setUsername] = useState(dev.username ?? "");
  const [password, setPassword] = useState(dev.password ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await core.client.login(url, username, password));
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="col" style={{ gap: 14 }}>
      <StepHeader title={t("onboarding.signIn.title")} onBack={onBack}>
        {t("onboarding.signIn.lead")}
      </StepHeader>
      <Field
        label={t("onboarding.signIn.address")}
        placeholder="chat.example.com"
        hint={t("onboarding.signIn.addressHint")}
        value={url}
        autoFocus
        spellCheck={false}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Field label={t("common.username")} value={username} spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
      <PasswordField label={t("common.password")} value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
      {error && <div className="field-error">{error}</div>}
      <button className="btn btn-primary btn-large btn-block" disabled={!url || !username || !password || busy}>
        {busy ? (
          <>
            <Spinner /> {t("onboarding.signIn.unlocking")}
          </>
        ) : (
          t("onboarding.signIn.title")
        )}
      </button>
      <div className="step-links">
        <button type="button" className="link-button" disabled={!url || !username} onClick={() => onForgot(url, username)}>
          {t("onboarding.signIn.forgot")}
        </button>
      </div>
    </form>
  );
}

function RecoverStep({
  url,
  username,
  onBack,
  onRecovered,
  client,
}: {
  url: string;
  username: string;
  onBack: () => void;
  onRecovered: (serverId: string) => void;
  client: { recover(url: string, username: string, key: string, password: string): Promise<string> };
}) {
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = usePasswordStrength(password, [username]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!strength.accepts()) return;
    setBusy(true);
    setError(null);
    try {
      onRecovered(await client.recover(url, username, key, password));
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="col" style={{ gap: 14 }}>
      <StepHeader title={t("onboarding.recover.title")} onBack={onBack}>
        {tx("onboarding.recover.lead", { username: <b>{username}</b> })}
      </StepHeader>
      <Field label={t("onboarding.recover.key")} className="input mono" value={key} autoFocus spellCheck={false} onChange={(event) => setKey(event.target.value)} />
      <div className="field">
        <PasswordField label={t("onboarding.recover.newPassword")} value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        <StrengthMeter strength={strength} />
      </div>
      <ConfirmPasswordField label={t("onboarding.recover.confirmPassword")} password={password} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      {error && <div className="field-error">{error}</div>}
      <button className="btn btn-primary btn-large btn-block" disabled={!key || password.length < MIN_PASSWORD || strength.score < 2 || confirm !== password || busy}>
        {busy ? <Spinner /> : t("onboarding.recover.button")}
      </button>
    </form>
  );
}
