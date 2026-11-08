// Small shared building blocks.

import type { AvatarRef } from "@zuna/core";
import { ChevronRight, Eye, EyeOff, X } from "lucide-react";
import { motion } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { avatarColor, initialsOf } from "@/lib/format";
import { refocusComposer } from "@/lib/focus";
import { useDecryptedUrl, useRemoteImage } from "@/lib/media";
import { useApp } from "@/state/store";

/** The motion used everywhere: quick, with no bounce. */
export const quick = { duration: 0.12, ease: [0.2, 0, 0, 1] } as const;

export function TypingDots() {
  return (
    <span className="typing-dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** The app's icon, as in apps/desktop/resources/icon.svg: a white Z on black. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <rect width="1024" height="1024" rx="160" fill="#000000" />
      <path d="M248 524V392A144 144 0 0 1 392 248H776L248 776H632A144 144 0 0 0 776 632V500" fill="none" stroke="#ffffff" strokeWidth="96" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Avatar({
  name,
  seed,
  avatar,
  size = 44,
  online,
  rounded,
  serverId,
  imageUrl,
}: {
  name: string;
  seed: string;
  avatar?: AvatarRef | null;
  size?: number;
  online?: boolean;
  rounded?: boolean;
  serverId?: string | null;
  imageUrl?: string | null;
}) {
  const activeServerId = useApp((state) => state.activeServerId);
  const { url } = useDecryptedUrl(serverId ?? activeServerId, avatar ?? null, !!avatar);
  const remote = useRemoteImage(imageUrl);
  const source = remote.url ?? url;
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        borderRadius: rounded ? size * 0.28 : "50%",
        background: source ? "var(--bg-3)" : avatarColor(seed),
        fontSize: size * 0.38,
      }}
    >
      {source ? <img className="avatar-img" src={source} alt="" draggable={false} /> : initialsOf(name)}
      {online && <i className="presence-dot" />}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  suffix,
  ...input
}: { label?: string; hint?: ReactNode; error?: string | null; suffix?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <span className={`input-wrap${error ? " has-error" : ""}`}>
        <input className="input" {...input} />
        {suffix && <span className="input-suffix">{suffix}</span>}
      </span>
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function PasswordField({ label, hint, error, ...input }: { label?: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      type={visible ? "text" : "password"}
      suffix={
        <button type="button" className="icon-btn is-small" tabIndex={-1} onClick={() => setVisible(!visible)} aria-label={visible ? "Hide password" : "Show password"}>
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      }
      {...input}
    />
  );
}

/**
 * A new password typed again, as a typo would lock the account: nobody can reset a
 * password. While it's still being typed, it's only wrong once it stops matching.
 */
export function ConfirmPasswordField({
  password,
  label = "Confirm password",
  ...input
}: { password: string; value: string; label?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <PasswordField
      label={label}
      autoComplete="new-password"
      error={input.value && !password.startsWith(input.value) ? "The passwords don't match." : null}
      {...input}
    />
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (value: boolean) => void; label?: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? " is-on" : ""}`} onClick={() => onChange(!on)}>
      <i />
    </button>
  );
}

export function Spinner({ size = 18, delayed }: { size?: number; delayed?: boolean }) {
  return <span className={`spinner${delayed ? " spinner-delayed" : ""}`} style={{ width: size, height: size }} />;
}

/** Returns focus to the message box when a dialog, menu or picker goes away. */
export function useReturnFocus(): void {
  useEffect(() => () => refocusComposer(), []);
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
  bare,
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  bare?: boolean;
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
    <motion.div
      className="modal-layer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.08 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <motion.div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={width ? { maxWidth: width } : undefined}
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.99 }}
        transition={quick}
      >
        {bare ? (
          children
        ) : (
          <>
            <div className="modal-head">
              <h2>{title}</h2>
              <button className="icon-btn is-small" onClick={onClose} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-foot">{footer}</div>}
          </>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/**
 * Asks before something that can't be taken back, such as a ban. Cancel, Escape or a
 * click outside say no, and Escape closes only this, not what's behind it.
 */
export function Confirm({
  title,
  action,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} autoFocus>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>{action}</button>
        </>
      }
    >
      <p style={{ fontSize: 13.5 }}>{children}</p>
    </Modal>
  );
}

export interface MenuEntry {
  label?: string;
  icon?: ReactNode;
  danger?: boolean;
  separator?: boolean;
  onSelect?: () => void;
  /** Choices that replace the menu's entries when this one is picked. */
  submenu?: MenuEntry[];
}

/** A popup menu at a screen position, kept inside the window. */
export function PopupMenu({
  x,
  y,
  entries,
  onClose,
  header,
  alignRight,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
  header?: ReactNode;
  alignRight?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [submenu, setSubmenu] = useState<MenuEntry[] | null>(null);
  useReturnFocus();

  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    let left = alignRight ? x - rect.width : x;
    let top = y;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width;
    if (left < 8) left = 8;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height);
    setPosition({ left, top });
  }, [x, y, alignRight, submenu]);

  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    const dismiss = () => latestClose.current();
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) dismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("contextmenu", close);
    });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", dismiss);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  return createPortal(
    <motion.div
      ref={ref}
      className="menu"
      role="menu"
      style={position}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.06 } }}
      transition={{ duration: 0.08, ease: [0.2, 0, 0, 1] }}
    >
      {!submenu && header}
      {(submenu ?? entries).map((entry, index) =>
        entry.separator ? (
          <div key={index} className="menu-sep" />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={`menu-item${entry.danger ? " is-danger" : ""}`}
            onClick={() => {
              if (entry.submenu) {
                setSubmenu(entry.submenu);
                return;
              }
              onClose();
              entry.onSelect?.();
            }}
          >
            {entry.icon}
            <span className="grow">{entry.label}</span>
            {entry.submenu && <ChevronRight size={14} className="menu-more" />}
          </button>
        ),
      )}
    </motion.div>,
    document.body,
  );
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return {
    menu,
    open: (event: { clientX: number; clientY: number; preventDefault?: () => void }) => {
      event.preventDefault?.();
      setMenu({ x: event.clientX, y: event.clientY });
    },
    close: () => setMenu(null),
  };
}

export function Tooltip({ text, children, side = "bottom" }: { text: string; children: ReactElement<ComponentProps<"span">>; side?: "top" | "bottom" | "right" }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const style = rect
    ? side === "right"
      ? { left: rect.right + 8, top: rect.top + rect.height / 2, translate: "0 -50%" }
      : side === "top"
        ? { left: rect.left + rect.width / 2, top: rect.top - 6, translate: "-50% -100%" }
        : { left: rect.left + rect.width / 2, top: rect.bottom + 6, translate: "-50% 0" }
    : undefined;
  return (
    <>
      <span
        style={{ display: "inline-flex" }}
        onMouseEnter={(event) => {
          const target = event.currentTarget;
          timer.current = setTimeout(() => setRect(target.getBoundingClientRect()), 400);
        }}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          setRect(null);
        }}
        onMouseDown={() => {
          clearTimeout(timer.current);
          setRect(null);
        }}
      >
        {children}
      </span>
      {rect &&
        createPortal(
          <div className="tooltip" style={style}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The active server's connection while it isn't simply online. */
export function ConnectionStatus() {
  const connection = useApp((state) => (state.activeServerId ? state.servers[state.activeServerId]?.connection : undefined));
  const status =
    connection === "connecting" ? "Connecting" : connection === "offline" ? "Waiting for network" : connection === "syncing" ? "Updating" : null;
  if (!status) return null;
  return (
    <span className="titlebar-status" role="status">
      <i />
      {status}
    </span>
  );
}

export function Toasts() {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`} onClick={() => dismiss(toast.id)}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

/** Catches a failed async action and shows it as a toast. */
export function useAction() {
  const toast = useApp((state) => state.toast);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      toast((error as Error).message, "error");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
