import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from "lucide-react";
import type { AccountStatus } from "@shared/types";
import { useUi } from "@renderer/store";
import styles from "./ui.module.css";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------------- Button ---------------- */

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "soft";
  size?: "sm" | "md" | "lg";
  block?: boolean;
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", block, icon: Icon, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        styles.button,
        styles[variant],
        size !== "md" && styles[size],
        block && styles.block,
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span className={styles.spinner} />
      ) : Icon ? (
        <Icon size={size === "sm" ? 14 : 16} strokeWidth={2.2} />
      ) : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  size?: "sm" | "md";
}

export function IconButton({ icon: Icon, label, active, size = "md", className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx(styles.iconButton, active && styles.active, size === "sm" && styles.sm, className)}
      title={label}
      aria-label={label}
      {...rest}
    >
      <Icon size={size === "sm" ? 14 : 17} strokeWidth={2} />
    </button>
  );
}

/* ---------------- Card / Badge / Dot ---------------- */

export function Card({
  children,
  className,
  padded = true,
  interactive,
  onClick,
  style,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  interactive?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cx(styles.card, padded && styles.padded, interactive && styles.interactive, className)}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={style}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "info" | "brand";
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx(styles.badge, tone !== "neutral" && styles[tone], className)}>{children}</span>;
}

export function StatusDot({ status, className }: { status: AccountStatus; className?: string }) {
  return <span className={cx(styles.dot, styles[status], className)} aria-hidden />;
}

export const STATUS_LABEL: Record<AccountStatus, string> = {
  online: "在线",
  offline: "未登录",
  needs_verification: "需验证",
  expiring: "即将过期",
  network_error: "网络异常",
  unknown: "未检测",
};

export const STATUS_TONE: Record<AccountStatus, "success" | "warning" | "danger" | "info" | "neutral"> = {
  online: "success",
  expiring: "warning",
  offline: "neutral",
  needs_verification: "danger",
  network_error: "info",
  unknown: "neutral",
};

/* ---------------- Avatar ---------------- */

/** Keyed by src at the call site: a new cache reference gets a fresh loading attempt. */
function MediaImage({
  src,
  className,
  fallback,
}: {
  src?: string | null;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  return src && !failed ? (
    <img
      className={className}
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    fallback
  );
}

export function Cover({ src, className }: { src?: string | null; className?: string }) {
  return (
    <MediaImage
      key={src ?? ""}
      src={src}
      className={className}
      fallback={<div className={className} role="img" aria-label="暂无封面" />}
    />
  );
}

export function Avatar({
  src,
  name,
  color,
  size = 36,
  round,
  badge,
  badgeColor,
  className,
}: {
  src?: string | null;
  name: string;
  color: string;
  size?: number;
  round?: boolean;
  badge?: React.ReactNode;
  badgeColor?: string;
  className?: string;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cx(styles.avatar, round && styles.round, className)}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.38) }}
    >
      <MediaImage key={src ?? ""} src={src} fallback={initial} />
      {badge ? (
        <span className={styles.avatarBadge} style={{ background: badgeColor ?? "#111" }}>
          {badge}
        </span>
      ) : null}
    </span>
  );
}

/* ---------------- Inputs ---------------- */

export function Field({ label, hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.field}>
      {label ? <label className={styles.label}>{label}</label> : null}
      {children}
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}

export function TextInput({
  icon: Icon,
  compact,
  className,
  right,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
  icon?: LucideIcon;
  compact?: boolean;
  right?: ReactNode;
}) {
  return (
    <div className={cx(styles.input, compact && styles.sm, className)}>
      {Icon ? <Icon size={15} color="var(--fg-subtle)" /> : null}
      <input {...rest} />
      {right}
    </div>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <div className={cx(styles.input, styles.textarea)}>
      <textarea {...props} />
    </div>
  );
}

export function Select({ children, className, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx(styles.input, className)}>
      <select {...rest}>{children}</select>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx(styles.switch, checked && styles.on)}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Tabs<T extends string | number>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ value: T; label: ReactNode }>;
}) {
  return (
    <div className={styles.tabs} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={cx(styles.tab, item.value === value && styles.active)}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Modal ---------------- */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
  icon,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  icon?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    useUi.getState().pushOverlay();
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) ?? [],
      );
    (
      ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea") ??
      focusable()[0] ??
      ref.current
    )?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
      if (e.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items.at(-1);
        if (!first) {
          e.preventDefault();
          ref.current?.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      useUi.getState().popOverlay();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        className={cx(styles.modal, wide && styles.wide)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.modalHead}>
          {icon}
          <h3 id={titleId}>{title}</h3>
          <IconButton icon={X} label="关闭" onClick={onClose} />
        </div>
        <div className={styles.modalBody}>{children}</div>
        {footer ? <div className={styles.modalFoot}>{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- Menu (popover) ---------------- */

export function Menu({
  anchor,
  onClose,
  children,
}: {
  anchor: DOMRect | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const place = () => {
      const menu = ref.current;
      if (!menu) return;
      menu.style.maxHeight = `${Math.max(80, window.innerHeight - 16)}px`;
      const { width, height } = menu.getBoundingClientRect();
      const top =
        anchor.bottom + 6 + height <= window.innerHeight - 8 ? anchor.bottom + 6 : anchor.top - height - 6;
      menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
      menu.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [anchor]);
  useEffect(() => {
    if (!anchor) return;
    const previous = document.activeElement as HTMLElement | null;
    useUi.getState().pushOverlay();
    const items = () =>
      Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        close.current();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const buttons = items(),
        index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      useUi.getState().popOverlay();
      if (previous?.isConnected) previous.focus();
    };
  }, [anchor]);
  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      className={styles.menu}
      style={{ position: "fixed", top: 8, left: 8, overflowY: "auto", maxWidth: "calc(100vw - 16px)" }}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon: Icon,
  children,
  danger,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: LucideIcon; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={cx(styles.menuItem, danger && styles.danger)} {...rest}>
      {Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className={styles.menuSep} />;
}

/* ---------------- Feedback ---------------- */

export function Skeleton({
  width,
  height = 14,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return <div className={cx(styles.skeleton, className)} style={{ width, height, ...style }} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>
        <Icon size={24} />
      </div>
      <h4>{title}</h4>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx(styles.spinner, className)} />;
}

export function Delta({ value, suffix = "" }: { value: number | null | undefined; suffix?: string }) {
  if (value == null) return <span className={cx(styles.delta, styles.flat)}>—</span>;
  const tone = value > 0 ? "up" : value < 0 ? "down" : "flat";
  return (
    <span className={cx(styles.delta, styles[tone], "num")}>
      {value > 0 ? "+" : ""}
      {formatNumber(value)}
      {suffix}
    </span>
  );
}

/* ---------------- Toasts ---------------- */

export interface ToastItem {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  message?: string;
}

const TOAST_ICON = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info } as const;

export function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: number) => void }) {
  return createPortal(
    <div className={styles.toasts}>
      {items.map((toast) => {
        const Icon = TOAST_ICON[toast.kind];
        return (
          <div key={toast.id} className={cx(styles.toast, styles[toast.kind])}>
            <div className={styles.toastIcon}>
              <Icon size={16} />
            </div>
            <div className={styles.toastBody}>
              <strong>{toast.title}</strong>
              {toast.message ? <span>{toast.message}</span> : null}
            </div>
            <IconButton icon={X} label="关闭" size="sm" onClick={() => onDismiss(toast.id)} />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/* ---------------- Table ---------------- */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return <table className={cx(styles.table, className)}>{children}</table>;
}

export const tableStyles = styles;

/* ---------------- Formatting ---------------- */

export function formatNumber(value: number | null | undefined, compact = true): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (!compact) return value.toLocaleString("zh-CN");
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(abs >= 1_000_000_000 ? 0 : 1)}亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(abs >= 1_000_000 ? 0 : 1)}万`;
  return value.toLocaleString("zh-CN");
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "从未";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
