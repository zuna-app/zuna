// Small shared building blocks.

import type { AvatarRef } from "@zuna/core";
import { Eye, EyeOff, X } from "lucide-react";
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
import { useDecryptedUrl } from "@/lib/media";
import { useApp } from "@/state/store";

/** The motion used everywhere: quick, with no bounce. */
export const quick = { duration: 0.12, ease: [0.2, 0, 0, 1] } as const;

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#ececee" />
      <path d="M19 17h26v5.5L27.5 42H45v5H18.5v-5.2L36.2 22H19z" fill="#111113" />
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
  const source = imageUrl ?? url;
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

export interface MenuEntry {
  label?: string;
  icon?: ReactNode;
  danger?: boolean;
  separator?: boolean;
  onSelect?: () => void;
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
  useReturnFocus();

  useLayoutEffect(() => {
    const rect = ref.current!.getBoundingClientRect();
    let left = alignRight ? x - rect.width : x;
    let top = y;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width;
    if (left < 8) left = 8;
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, y - rect.height);
    setPosition({ left, top });
  }, [x, y, alignRight]);

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
      {header}
      {entries.map((entry, index) =>
        entry.separator ? (
          <div key={index} className="menu-sep" />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={`menu-item${entry.danger ? " is-danger" : ""}`}
            onClick={() => {
              onClose();
              entry.onSelect?.();
            }}
          >
            {entry.icon}
            {entry.label}
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
