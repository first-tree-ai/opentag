import {
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  type SVGAttributes,
  useEffect,
  useId,
  useRef,
} from "react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "inline";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "default" | "compact";
  variant?: ButtonVariant;
};

export function buttonClassName({
  className,
  size = "default",
  variant = "primary",
}: {
  className?: string;
  size?: ButtonProps["size"];
  variant?: ButtonVariant;
} = {}): string {
  return classes("ds-button", `ds-button--${variant}`, size === "compact" && "ds-button--compact", className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size = "default", variant = "primary", type = "button", ...props },
  ref,
) {
  return <button className={buttonClassName({ className, size, variant })} ref={ref} type={type} {...props} />;
});

export function Tabs({
  children,
  className,
  collapseOnMobile = false,
  label,
}: {
  children: ReactNode;
  className?: string;
  collapseOnMobile?: boolean;
  label: string;
}) {
  return (
    <nav aria-label={label} className={classes("ds-tabs", collapseOnMobile && "ds-tabs--collapsible", className)}>
      {children}
    </nav>
  );
}

export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={classes("ds-settings-list", className)}>{children}</div>;
}

export function SettingsRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="ds-settings-row">
      <div className="ds-settings-row__copy">
        <strong>{label}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="ds-settings-row__control">{children}</div>
    </div>
  );
}

export function Field({
  children,
  className,
  error,
  errorId,
  hint,
  hintId,
  htmlFor,
  label,
}: {
  children: ReactNode;
  className?: string;
  error?: ReactNode;
  errorId?: string;
  hint?: ReactNode;
  hintId?: string;
  htmlFor: string;
  label: ReactNode;
}) {
  return (
    <div className={classes("ds-field", className)}>
      <label className="ds-field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="ds-field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="ds-field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

export function StatusIndicator({
  className,
  detail,
  label,
  tone = "neutral",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  detail?: ReactNode;
  label: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span className={classes("ds-status", `ds-status--${tone}`, className)} {...props}>
      <span className="ds-status__dot" aria-hidden="true" />
      <span className="ds-status__copy">
        <strong>{label}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </span>
  );
}

export type IconName =
  | "arrow-left"
  | "arrow-right"
  | "check"
  | "chevron-right"
  | "close"
  | "instructions"
  | "laptop"
  | "message"
  | "model"
  | "more-vertical"
  | "plus"
  | "settings"
  | "shield"
  | "user";

export function Icon({ className, name, ...props }: SVGAttributes<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      className={classes("ds-icon", className)}
      fill="none"
      focusable="false"
      viewBox="0 0 20 20"
      {...props}
    >
      {name === "close" ? <path d="m5 5 10 10M15 5 5 15" /> : null}
      {name === "check" ? <path d="m4.5 10.5 3.5 3.5 7.5-8" /> : null}
      {name === "more-vertical" ? <path d="M10 5.5h.01M10 10h.01M10 14.5h.01" /> : null}
      {name === "chevron-right" ? <path d="m7.5 4.5 5.5 5.5-5.5 5.5" /> : null}
      {name === "plus" ? <path d="M10 4v12M4 10h12" /> : null}
      {name === "arrow-right" ? <path d="M3.5 10h13m-5-5 5 5-5 5" /> : null}
      {name === "arrow-left" ? <path d="M16.5 10h-13m5-5-5 5 5 5" /> : null}
      {name === "settings" ? (
        <>
          <circle cx="10" cy="10" r="2.5" />
          <path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
        </>
      ) : null}
      {name === "instructions" ? <path d="M4 5h12M4 10h9M4 15h12" /> : null}
      {name === "model" ? (
        <>
          <rect x="4" y="4" width="12" height="12" rx="3" />
          <path d="M8 2v3M12 2v3M8 15v3M12 15v3M2 8h3M15 8h3M2 12h3M15 12h3M8 8h4v4H8z" />
        </>
      ) : null}
      {name === "message" ? <path d="M4 4.5h12v9H8l-4 3v-12Z" /> : null}
      {name === "user" ? (
        <>
          <circle cx="10" cy="7" r="3" />
          <path d="M4.5 17c.5-3.2 2.3-5 5.5-5s5 1.8 5.5 5" />
        </>
      ) : null}
      {name === "laptop" ? <path d="M4.5 4.5h11v8h-11zM3 15.5h14M5.5 12.5l-1 3M14.5 12.5l1 3" /> : null}
      {name === "shield" ? <path d="M10 2.8 16 5v4.8c0 3.5-2.1 6-6 7.4-3.9-1.4-6-3.9-6-7.4V5l6-2.2Z" /> : null}
    </svg>
  );
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  busy = false,
  children,
  className,
  closeLabel,
  description,
  eyebrow,
  onClose,
  returnFocusRef,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  title: ReactNode;
}) {
  const generatedId = useId().replaceAll(":", "");
  const titleId = `dialog-${generatedId}-title`;
  const descriptionId = description ? `dialog-${generatedId}-description` : undefined;
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = dialog.querySelector<HTMLElement>(FOCUSABLE);
    if (busy) {
      if (!activeElement || !dialog.contains(activeElement) || activeElement.matches(":disabled")) {
        (target ?? dialog).focus();
      }
    } else if (activeElement === dialog) {
      target?.focus();
    }
  }, [busy]);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!dialog?.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocusRef?.current?.focus();
    };
  }, [returnFocusRef]);

  return (
    <div className="dialog-layer">
      <button
        aria-label="Dismiss dialog"
        className="dialog-backdrop"
        disabled={busy}
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={classes("dialog-card", className)}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            {eyebrow ? <span className="eyebrow dialog-eyebrow">{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <Button
            aria-label={closeLabel ?? `Close ${typeof title === "string" ? title : "dialog"}`}
            className="dialog-close"
            disabled={busy}
            ref={closeButtonRef}
            variant="ghost"
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </header>
        {description ? (
          <p className="dialog-description" id={descriptionId}>
            {description}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
