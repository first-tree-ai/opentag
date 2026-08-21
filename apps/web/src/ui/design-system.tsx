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

export type ButtonVariant = "primary" | "secondary" | "commit" | "tertiary" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "default" | "compact";
  variant?: ButtonVariant;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size = "default", variant = "primary", type = "button", ...props },
  ref,
) {
  return (
    <button
      className={classes("ds-button", `ds-button--${variant}`, size === "compact" && "ds-button--compact", className)}
      ref={ref}
      type={type}
      {...props}
    />
  );
});

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

export type IconName = "arrow-left" | "arrow-right" | "chevron-right" | "close";

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
      {name === "chevron-right" ? <path d="m7.5 4.5 5.5 5.5-5.5 5.5" /> : null}
      {name === "arrow-right" ? <path d="M3.5 10h13m-5-5 5 5-5 5" /> : null}
      {name === "arrow-left" ? <path d="M16.5 10h-13m5-5-5 5 5 5" /> : null}
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
            variant="tertiary"
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
