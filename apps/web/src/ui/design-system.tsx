import {
  Banner,
  Breadcrumbs,
  buttonVariants,
  ChartPalette,
  ClipboardText,
  Collapsible,
  cn,
  DropdownMenu,
  Empty,
  Flow,
  Badge as KumoBadge,
  Button as KumoButton,
  type ButtonProps as KumoButtonProps,
  Checkbox as KumoCheckbox,
  Dialog as KumoDialog,
  Field as KumoField,
  Input as KumoInput,
  InputArea as KumoInputArea,
  type InputAreaProps as KumoInputAreaProps,
  type InputProps as KumoInputProps,
  Select as KumoSelect,
  Switch as KumoSwitch,
  Tabs as KumoTabs,
  LayerCard,
  Link,
  LinkButton,
  Loader,
  Meter,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SkeletonLine,
  Surface,
  Table,
  Text,
  TimeseriesChart,
  Tooltip,
  TooltipProvider,
  useSidebar,
} from "@cloudflare/kumo";
import {
  ArrowLeft,
  ArrowRight,
  CaretRight,
  ChatCircle,
  Check,
  Cpu,
  DotsThreeVertical,
  Gear,
  Info,
  Laptop,
  List,
  MagnifyingGlass,
  type Icon as PhosphorIcon,
  Plus,
  Shield,
  User,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  type ButtonHTMLAttributes,
  Children,
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type SVGAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";

export {
  Banner,
  Breadcrumbs,
  ChartPalette,
  ClipboardText,
  Collapsible,
  DropdownMenu,
  Empty,
  Flow,
  KumoBadge as Badge,
  KumoSwitch,
  LayerCard,
  Link,
  LinkButton,
  Loader,
  Meter,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SkeletonLine,
  Surface,
  Table,
  Text,
  TimeseriesChart,
  Tooltip,
  TooltipProvider,
  useSidebar,
};

export const Input: typeof KumoInput = KumoInput;
export const InputArea: typeof KumoInputArea = KumoInputArea;
export const Select: typeof KumoSelect = KumoSelect;
export const Checkbox: typeof KumoCheckbox = KumoCheckbox;
export const Switch: typeof KumoSwitch = KumoSwitch;

function classes(...values: Array<string | false | null | undefined>): string {
  return cn(values.filter(Boolean).join(" "));
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "inline";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> & {
  size?: "default" | "compact";
  variant?: ButtonVariant;
} & Partial<Pick<KumoButtonProps, "loading" | "shape" | "icon" | "title">>;

function kumoButtonVariant(variant: ButtonVariant): "primary" | "secondary" | "outline" | "ghost" | "destructive" {
  if (variant === "danger") return "destructive";
  if (variant === "inline") return "ghost";
  return variant;
}

export function buttonClassName({
  className,
  size = "default",
  variant = "primary",
}: {
  className?: string;
  size?: ButtonProps["size"];
  variant?: ButtonVariant;
} = {}): string {
  return classes(
    buttonVariants({ variant: kumoButtonVariant(variant), size: size === "compact" ? "sm" : "base" }),
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size = "default", variant = "primary", type = "button", ...props },
  ref,
) {
  return (
    <KumoButton
      {...(props as KumoButtonProps)}
      className={buttonClassName({ className, size, variant })}
      ref={ref}
      size={size === "compact" ? "sm" : "base"}
      type={type}
      variant={kumoButtonVariant(variant)}
    />
  );
});

/** A controlled Kumo tab strip that keeps React Router links as its triggers. */
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
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{
    children?: ReactNode;
    className?: string;
    "aria-current"?: string;
  }>[];
  if (items.length === 0) return <nav aria-label={label} className={className} />;
  const selected = items.findIndex(
    (item) => item.props["aria-current"] === "page" || item.props.className?.includes("active"),
  );
  return (
    <nav aria-label={label} className={classes(collapseOnMobile && "max-w-full overflow-x-auto", className)}>
      <KumoTabs
        activateOnFocus
        className="max-w-full"
        selectedValue={String(selected < 0 ? 0 : selected)}
        size="sm"
        tabs={items.map((item, index) => ({
          label: item.props.children,
          nativeButton: false,
          value: String(index),
          render: (tabProps) => cloneElement(item, tabProps as never),
        }))}
        variant="underline"
      />
    </nav>
  );
}

export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={classes("grid overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line", className)}
      data-ui="settings-list"
    >
      {children}
    </div>
  );
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
    <div className="grid gap-3 p-4 md:grid-cols-[2fr_1fr] md:items-center" data-ui="settings-row">
      <div className="grid gap-1">
        <strong className="text-sm font-medium text-kumo-strong">{label}</strong>
        {description ? <p className="text-sm text-kumo-subtle">{description}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
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
  htmlFor: _htmlFor,
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
  const labelId = `${_htmlFor}-label`;
  const childProps = isValidElement(children)
    ? (children.props as { "aria-label"?: string; "aria-labelledby"?: string })
    : undefined;
  const childType = isValidElement(children) ? children.type : undefined;
  const isKumoControl =
    childType === KumoInputControl || childType === KumoInputAreaControl || childType === KumoSelectControl;
  const labelledChildren =
    isKumoControl && !childProps?.["aria-label"] && !childProps?.["aria-labelledby"]
      ? cloneElement(children as ReactElement<{ "aria-labelledby"?: string }>, { "aria-labelledby": labelId })
      : children;
  return (
    <div className={classes("min-w-0", className)} data-ui="field">
      <label className="mb-1 block text-sm font-medium text-kumo-default" htmlFor={_htmlFor} id={labelId}>
        {label}
      </label>
      <KumoField
        description={hint ? <span id={hintId}>{hint}</span> : undefined}
        error={error ? { match: true, message: error } : undefined}
        hideLabel
        label={label}
      >
        {labelledChildren}
      </KumoField>
      {error ? (
        <span className="sr-only" id={errorId} role="alert">
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
  const variant =
    tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "danger" ? "error" : "neutral";
  return (
    <span className={classes("inline-flex items-center gap-2", className)} data-state={tone} {...props}>
      <KumoBadge appearance="dot" variant={variant}>
        {label}
      </KumoBadge>
      {detail ? <small className="text-sm text-kumo-subtle">{detail}</small> : null}
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

const icons: Record<IconName, PhosphorIcon> = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  check: Check,
  "chevron-right": CaretRight,
  close: X,
  instructions: List,
  laptop: Laptop,
  message: ChatCircle,
  model: Cpu,
  "more-vertical": DotsThreeVertical,
  plus: Plus,
  settings: Gear,
  shield: Shield,
  user: User,
};

export function Icon({ className, name, ...props }: SVGAttributes<SVGSVGElement> & { name: IconName }) {
  const Glyph = icons[name];
  return (
    <Glyph
      aria-hidden={props["aria-label"] ? undefined : true}
      className={classes("size-4 shrink-0", className)}
      focusable="false"
      {...props}
    />
  );
}

export const KumoInputControl = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & Pick<KumoInputProps, "size" | "variant">
>(function KumoInputControl(props, ref) {
  return <KumoInput {...props} ref={ref} />;
});

export const KumoInputAreaControl = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & Pick<KumoInputAreaProps, "size" | "variant">
>(function KumoInputAreaControl(props, ref) {
  return <KumoInputArea {...props} ref={ref} />;
});

/** Compatibility select bridge. New fields should use KumoSelect directly. */
export const KumoSelectControl = forwardRef<
  HTMLButtonElement,
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "size" | "value"> & {
    size?: "xs" | "sm" | "base" | "lg";
    value?: string;
    onValueChange?: (value: string) => void;
  }
>(function KumoSelectControl({ children, onChange, onValueChange, ...props }, _ref) {
  const options = Children.toArray(children).filter(isValidElement) as ReactElement<{
    value?: string;
    disabled?: boolean;
    children?: ReactNode;
  }>[];
  const labels = new Map(
    options.map((option) => [
      String(option.props.value ?? ""),
      String(option.props.children ?? option.props.value ?? ""),
    ]),
  );
  return (
    <KumoSelect
      {...(props as Parameters<typeof KumoSelect>[0])}
      itemToStringLabel={(value) => labels.get(String(value)) ?? String(value ?? "")}
      onValueChange={(value) => {
        onValueChange?.(String(value));
        if (onChange) onChange({ currentTarget: { value: String(value) }, target: { value: String(value) } } as never);
      }}
    >
      {options.map((option) => (
        <KumoSelect.Option
          data-value={String(option.props.value ?? "")}
          disabled={option.props.disabled}
          key={String(option.props.value)}
          value={option.props.value ?? ""}
        >
          {option.props.children}
        </KumoSelect.Option>
      ))}
    </KumoSelect>
  );
});

/** Kumo compound dialog with a controlled open state and busy dismissal guard. */
export function Dialog({
  busy = false,
  children,
  className,
  closeLabel,
  description,
  eyebrow,
  onClose,
  open = true,
  returnFocusRef,
  role = "dialog",
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  open?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  role?: "dialog" | "alertdialog";
  title: ReactNode;
}) {
  const id = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) returnFocusRef?.current?.focus();
  }, [open, returnFocusRef]);
  return (
    <KumoDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (!next) onClose();
      }}
      role={role === "alertdialog" ? "alertdialog" : "dialog"}
    >
      <KumoDialog className={classes("max-h-[min(90vh,42rem)] overflow-y-auto p-6", className)}>
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="grid gap-1">
            {eyebrow ? <span className="text-xs font-medium text-kumo-subtle">{eyebrow}</span> : null}
            <KumoDialog.Title id={`${id}-title`} className="text-lg font-semibold text-kumo-strong">
              {title}
            </KumoDialog.Title>
          </div>
          <Button
            aria-label={closeLabel ?? `Close ${typeof title === "string" ? title : "dialog"}`}
            className="shrink-0"
            disabled={busy}
            ref={closeRef}
            shape="square"
            variant="ghost"
            onClick={onClose}
          >
            <Icon name="close" />
          </Button>
        </header>
        {description ? (
          <KumoDialog.Description className="mb-4 text-sm text-kumo-subtle">{description}</KumoDialog.Description>
        ) : null}
        {children}
      </KumoDialog>
    </KumoDialog.Root>
  );
}

export { Info, MagnifyingGlass, Wrench };
