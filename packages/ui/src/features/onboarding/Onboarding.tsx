// First-run flow. It's also reused inside the app for joining another server.

import type { InvitePreview } from "@zuna/core";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Download, KeyRound, LinkIcon, Lock, Server, ShieldCheck, Users } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { platform } from "@/platform";
import { Avatar, Field, Logo, PasswordField, Spinner } from "@/components/ui";
import { copyText } from "@/lib/clipboard";
import { PROJECT_URL } from "@/lib/links";
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

function describeError(error: unknown): string {
  const message = (error as Error).message ?? "";
  if (/Couldn't reach|fetch/i.test(message)) return "Couldn't reach that server. Check the address and your connection.";
  return message || "Something went wrong. Please try again.";
}

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
        <button type="button" className="icon-btn step-back" onClick={onBack} aria-label="Back">
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
        <h1>Welcome to Zuna</h1>
        <p>Private chat on servers you and your friends run.</p>
        <div className="trust-chips">
          <span><Lock size={13} /> End-to-end encrypted</span>
          <span><ShieldCheck size={13} /> Open source</span>
          <span><Server size={13} /> Self-hosted</span>
        </div>
      </div>
      <div className="col" style={{ gap: 10 }}>
        <button type="button" className="btn btn-primary btn-large btn-block" onClick={onJoin}>
          <LinkIcon size={16} /> Join with an invite
        </button>
        <button type="button" className="btn btn-large btn-block" onClick={onSignIn}>
          Sign in
        </button>
        <button
          type="button"
          className="link-button step-host"
          onClick={() => {
            platform.openExternal(`${PROJECT_URL}/blob/main/docs/SELF_HOSTING.md`);
          }}
        >
          <Server size={14} /> Host your own server <ArrowUpRight size={14} />
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
      <StepHeader icon={<LinkIcon size={26} />} title="Join a server" onBack={onBack}>
        Paste the invite link someone sent you.
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
        aria-label="Invite link"
      />
      <button className="btn btn-primary btn-large btn-block" disabled={!link.trim() || busy}>
        {busy ? <Spinner /> : <>Continue <ArrowRight size={17} /></>}
      </button>
      {/* On the first run the welcome screen offers signing in, one step back. */}
      {embedded && (
        <button type="button" className="btn btn-large btn-block" onClick={onSignIn}>
          I already have an account
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
      <span style={{ color: score ? colors[score] : "var(--text-3)" }}>{label || `At least ${MIN_PASSWORD} characters`}</span>
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const server = preview.server;

  const validUsername = /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,31}$/.test(username);
  const strength = usePasswordStrength(password, [username, displayName]);
  const canSubmit = displayName.trim() && validUsername && password.length >= MIN_PASSWORD && strength.current && strength.score >= 2 && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await core.client.register(preview, username, password, { displayName: displayName.trim() });
      onCreated(result.serverId, result.recoveryKey);
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="col" style={{ gap: 14 }}>
      <div className="invite-preview">
        <button type="button" className="icon-btn step-back" onClick={onBack} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <Avatar name={server.name} seed={preview.url} size={56} rounded imageUrl={server.has_icon ? `${preview.url}/api/icon` : null} />
        <h1>{preview.setup ? "Set up your server" : `Join ${server.name}`}</h1>
        <p className="muted">
          {preview.setup ? (
            "You're creating the owner account."
          ) : server.user_count > 0 ? (
            <span className="row" style={{ gap: 5, justifyContent: "center" }}>
              <Users size={13} /> {server.user_count} {server.user_count === 1 ? "member" : "members"}
            </span>
          ) : (
            "Open sign-ups"
          )}
        </p>
      </div>
      <Field
        label="Your name"
        placeholder="How people will see you"
        value={displayName}
        autoFocus
        maxLength={64}
        onChange={(event) => {
          setDisplayName(event.target.value);
          if (!usernameEdited) setUsername(suggestUsername(event.target.value));
        }}
      />
      <Field
        label="Username"
        placeholder="alex"
        value={username}
        spellCheck={false}
        maxLength={32}
        hint="Letters, numbers, dots, dashes and underscores."
        error={error?.toLowerCase().includes("username") ? error : username && !validUsername ? "Usernames need at least 2 valid characters." : null}
        onChange={(event) => {
          setUsername(event.target.value);
          setUsernameEdited(true);
          setError(null);
        }}
      />
      <div className="field">
        <PasswordField
          label="Password"
          value={password}
          autoComplete="new-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        <StrengthMeter strength={strength} />
      </div>
      <div className="notice">
        <Lock size={15} />
        <span>Your password unlocks your encryption keys. It never leaves this device, and your server can't reset it.</span>
      </div>
      {error && !error.toLowerCase().includes("username") && <div className="field-error">{error}</div>}
      <button className="btn btn-primary btn-large btn-block" disabled={!canSubmit}>
        {busy ? (
          <>
            <Spinner /> Securing your account
          </>
        ) : (
          "Create account"
        )}
      </button>
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
    const blob = new Blob([`Zuna recovery key\n\n${recoveryKey}\n\nKeep this somewhere safe. It's the only way back into your account if you forget your password.\n`], {
      type: "text/plain",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "zuna-recovery-key.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <StepHeader icon={<KeyRound size={26} />} title="Save your recovery key">
        If you forget your password, this key is the only way back in. Nobody can reset it for you, not even your server's admin.
      </StepHeader>
      <div className="recovery-key mono selectable">
        {recoveryKey.split("-").map((part, index) => (
          <span key={index}>{part}</span>
        ))}
      </div>
      <div className="row">
        <button className="btn grow" onClick={copy}>
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy"}
        </button>
        <button className="btn grow" onClick={download}>
          <Download size={15} /> Save as file
        </button>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        <span className="check-box">{saved && <Check size={13} strokeWidth={3} />}</span>
        I've stored it somewhere safe
      </label>
      <button className="btn btn-primary btn-large btn-block" disabled={!saved} onClick={onDone}>
        Continue
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
      <StepHeader icon={<Server size={26} />} title="Name your server">
        People see this name when you invite them. You can change it later.
      </StepHeader>
      <Field placeholder="Our corner of the internet" value={name} autoFocus maxLength={64} onChange={(event) => setName(event.target.value)} />
      <button className="btn btn-primary btn-large btn-block" disabled={busy}>
        {busy ? <Spinner /> : name.trim() ? "Finish" : "Skip for now"}
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
  // Only `npm run dev` sets these, for its local test server. They're empty in a real build.
  const [url, setUrl] = useState(initialUrl ?? import.meta.env.RENDERER_VITE_DEV_SERVER ?? platform.defaultServer ?? "");
  const [username, setUsername] = useState(import.meta.env.RENDERER_VITE_DEV_USERNAME ?? "");
  const [password, setPassword] = useState(import.meta.env.RENDERER_VITE_DEV_PASSWORD ?? "");
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
      <StepHeader title="Sign in" onBack={onBack}>
        Your history will load on this device after you sign in.
      </StepHeader>
      <Field
        label="Server address"
        placeholder="chat.example.com"
        hint="Or paste any link to the server."
        value={url}
        autoFocus
        spellCheck={false}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Field label="Username" value={username} spellCheck={false} onChange={(event) => setUsername(event.target.value)} />
      <PasswordField label="Password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
      {error && <div className="field-error">{error}</div>}
      <button className="btn btn-primary btn-large btn-block" disabled={!url || !username || !password || busy}>
        {busy ? (
          <>
            <Spinner /> Unlocking your keys
          </>
        ) : (
          "Sign in"
        )}
      </button>
      <div className="step-links">
        <button type="button" className="link-button" disabled={!url || !username} onClick={() => onForgot(url, username)}>
          Forgot your password?
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = usePasswordStrength(password, [username]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
      <StepHeader title="Use your recovery key" onBack={onBack}>
        Enter the key you saved when you created your account, then choose a new password for <b>{username}</b>.
      </StepHeader>
      <Field label="Recovery key" className="input mono" value={key} autoFocus spellCheck={false} onChange={(event) => setKey(event.target.value)} />
      <div className="field">
        <PasswordField label="New password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        <StrengthMeter strength={strength} />
      </div>
      {error && <div className="field-error">{error}</div>}
      <button className="btn btn-primary btn-large btn-block" disabled={!key || password.length < MIN_PASSWORD || !strength.current || strength.score < 2 || busy}>
        {busy ? <Spinner /> : "Recover account"}
      </button>
    </form>
  );
}
