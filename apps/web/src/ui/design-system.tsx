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
  CaretDown,
  CaretRight,
  CaretUp,
  ChartLine,
  ChatCircle,
  Check,
  Copy,
  Cpu,
  DotsThreeVertical,
  Gear,
  House,
  type IconWeight,
  Info,
  Laptop,
  List,
  MagnifyingGlass,
  type Icon as PhosphorIcon,
  PlugsConnected,
  Plus,
  Shield,
  User,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  Children,
  type ComponentPropsWithoutRef,
  cloneElement,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
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

type KumoSelectProps = ComponentPropsWithoutRef<typeof KumoSelect>;

function classes(...values: Array<string | false | null | undefined>): string {
  return cn(values.filter(Boolean).join(" "));
}

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "secondary-destructive"
  | "outline"
  | "ghost"
  | "danger"
  | "inline";

type KumoButtonAdapterProps = KumoButtonProps extends infer Props
  ? Props extends unknown
    ? Omit<Props, "size" | "variant">
    : never
  : never;

export type ButtonProps = KumoButtonAdapterProps & {
  size?: "default" | "compact";
  variant?: ButtonVariant;
};

function kumoButtonVariant(
  variant: ButtonVariant,
): "primary" | "secondary" | "secondary-destructive" | "outline" | "ghost" | "destructive" {
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
  const kumoProps: KumoButtonProps = {
    ...props,
    className: buttonClassName({ className, size, variant }),
    size: size === "compact" ? "sm" : "base",
    type,
    variant: kumoButtonVariant(variant),
  };
  return <KumoButton {...kumoProps} ref={ref} />;
});

/** A controlled Kumo tab strip that keeps React Router links as its triggers. */
type TabTriggerProps = HTMLAttributes<HTMLElement> & {
  children?: ReactNode;
  href?: string;
  ref?: Ref<HTMLElement>;
  "aria-current"?: HTMLAttributes<HTMLElement>["aria-current"];
};

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
  const items = Children.toArray(children).filter((child): child is ReactElement<TabTriggerProps> =>
    isValidElement<TabTriggerProps>(child),
  );
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
          render: (tabProps) => cloneElement(item, tabProps),
        }))}
        variant="underline"
      />
    </nav>
  );
}

export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={classes(
        "grid divide-y divide-kumo-line overflow-hidden rounded-lg bg-kumo-base ring ring-kumo-line",
        className,
      )}
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
  supportingContent,
}: {
  children: ReactNode;
  description?: ReactNode;
  label: ReactNode;
  supportingContent?: ReactNode;
}) {
  return (
    <div
      className="grid gap-3 p-4 @min-[44rem]/workspace:grid-cols-[2fr_1fr] @min-[44rem]/workspace:items-center"
      data-ui="settings-row"
    >
      <div className="grid gap-1">
        <strong className="text-sm font-medium text-kumo-strong">{label}</strong>
        {description ? <p className="text-sm text-kumo-subtle">{description}</p> : null}
        {supportingContent}
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
  type LabelableControlProps = {
    "aria-label"?: string;
    "aria-labelledby"?: string;
  };
  const child = isValidElement<LabelableControlProps>(children) ? children : undefined;
  const isKumoControl =
    child?.type === KumoInputControl || child?.type === KumoInputAreaControl || child?.type === KumoSelectControl;
  const labelledChildren =
    isKumoControl && !child.props["aria-label"] && !child.props["aria-labelledby"]
      ? cloneElement(child, { "aria-labelledby": labelId })
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
  | "chevron-down"
  | "chevron-right"
  | "chevron-up"
  | "close"
  | "copy"
  | "instructions"
  | "home"
  | "integrations"
  | "laptop"
  | "message"
  | "model"
  | "more-vertical"
  | "plus"
  | "settings"
  | "shield"
  | "sign-out"
  | "user"
  | "usage";

const icons: Record<IconName, PhosphorIcon> = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  check: Check,
  "chevron-down": CaretDown,
  "chevron-right": CaretRight,
  "chevron-up": CaretUp,
  close: X,
  copy: Copy,
  instructions: List,
  home: House,
  integrations: PlugsConnected,
  laptop: Laptop,
  message: ChatCircle,
  model: Cpu,
  "more-vertical": DotsThreeVertical,
  plus: Plus,
  settings: Gear,
  shield: Shield,
  "sign-out": ArrowRight,
  user: User,
  usage: ChartLine,
};

export function Icon({
  className,
  name,
  ...props
}: SVGAttributes<SVGSVGElement> & { name: IconName; weight?: IconWeight }) {
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

export type KumoInputControlProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> &
  Pick<KumoInputProps, "size" | "variant">;

export const KumoInputControl = forwardRef<HTMLInputElement, KumoInputControlProps>(
  function KumoInputControl(props, ref) {
    return <KumoInput {...props} ref={ref} />;
  },
);

export type KumoInputAreaControlProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  Pick<KumoInputAreaProps, "size" | "variant">;

export const KumoInputAreaControl = forwardRef<HTMLTextAreaElement, KumoInputAreaControlProps>(
  function KumoInputAreaControl(props, ref) {
    return <KumoInputArea {...props} ref={ref} />;
  },
);

/** Compatibility select bridge. New fields should use KumoSelect directly. */
export type SelectControlChangeEvent = {
  currentTarget: { value: string };
  target: { value: string };
};

type SelectControlChangeProps = {
  onChange?(event: SelectControlChangeEvent): void;
};

export type KumoSelectControlProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "size" | "value"> &
  SelectControlChangeProps & {
    size?: KumoSelectProps["size"];
    value?: string;
    onValueChange?: (value: string) => void;
  };

type SelectOptionProps = {
  value?: string | number | readonly string[];
  disabled?: boolean;
  children?: ReactNode;
};

function normalizeSelectOptionValue(value: SelectOptionProps["value"]): string {
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

export function KumoSelectControl({
  children,
  defaultValue,
  onChange,
  onValueChange,
  value,
  ...props
}: KumoSelectControlProps) {
  const options = Children.toArray(children).filter((child): child is ReactElement<SelectOptionProps> =>
    isValidElement<SelectOptionProps>(child),
  );
  const normalizedOptions = options.map((option) => ({
    label: String(option.props.children ?? option.props.value ?? ""),
    option,
    value: normalizeSelectOptionValue(option.props.value),
  }));
  const labels = new Map(normalizedOptions.map(({ label, value: optionValue }) => [optionValue, label]));
  const kumoProps: KumoSelectProps = {
    ...props,
    defaultValue: defaultValue === undefined ? undefined : normalizeSelectOptionValue(defaultValue),
    itemToStringLabel: (item) => labels.get(String(item)) ?? String(item ?? ""),
    value: value === undefined ? undefined : normalizeSelectOptionValue(value),
    onValueChange: (nextValue) => {
      const stringValue = String(nextValue ?? "");
      onValueChange?.(stringValue);
      onChange?.({ currentTarget: { value: stringValue }, target: { value: stringValue } });
    },
  };
  return (
    <KumoSelect {...kumoProps}>
      {normalizedOptions.map(({ option, value: optionValue }) => (
        <KumoSelect.Option disabled={option.props.disabled} key={optionValue} value={optionValue}>
          {option.props.children}
        </KumoSelect.Option>
      ))}
    </KumoSelect>
  );
}

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
