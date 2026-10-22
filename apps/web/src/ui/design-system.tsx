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
  LayerCard as KumoLayerCard,
  Select as KumoSelect,
  Switch as KumoSwitch,
  Tabs as KumoTabs,
  Text as KumoText,
  Toolbar as KumoToolbar,
  Link,
  LinkButton,
  Loader,
  Meter,
  Popover,
  Radio,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SkeletonLine,
  Surface,
  Table,
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
  ChartBar,
  ChartLine,
  ChatCircle,
  Check,
  Code,
  Compass,
  Copy,
  Cpu,
  DotsThreeVertical,
  Eye,
  EyeSlash,
  FileText,
  Fingerprint,
  Gear,
  House,
  type IconWeight,
  Info,
  Laptop,
  List,
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  Palette,
  PenNib,
  type Icon as PhosphorIcon,
  PlugsConnected,
  Plus,
  Shield,
  SquaresFour,
  TextB,
  TextH,
  Trash,
  TreeStructure,
  TrendUp,
  UploadSimple,
  User,
  Wrench,
  X,
} from "@phosphor-icons/react";
import {
  Children,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  cloneElement,
  type ForwardRefExoticComponent,
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefAttributes,
  type RefObject,
  type SelectHTMLAttributes,
  type SVGAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
} from "react";
import * as m from "../paraglide/messages.js";
import { designTokens } from "./design.tokens.js";

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
  Link,
  LinkButton,
  Loader,
  Meter,
  Popover,
  Radio,
  Sidebar,
  SidebarProvider,
  SidebarTrigger,
  SkeletonLine,
  Surface,
  Table,
  TimeseriesChart,
  Tooltip,
  TooltipProvider,
  useSidebar,
};

// Kumo's conditional generic props distribute differently through JSX. The implementation accepts
// their complete union; retain the original generic call signature for product callers.
type TextVariant = NonNullable<Parameters<typeof KumoText>[0]["variant"]>;
type HeadingSize = "page" | "section" | "body";
export const Text = (({ headingSize, ...props }: Parameters<typeof KumoText>[0] & { headingSize?: HeadingSize }) => (
  <KumoText
    {...props}
    data-heading-size={headingSize}
    data-text-size={props.size ?? "base"}
    data-text-variant={props.variant ?? "body"}
    DANGEROUS_className={classes("ui-text", props.DANGEROUS_className)}
  />
)) as <Variant extends TextVariant = "body">(
  props: Parameters<typeof KumoText<Variant>>[0] & { headingSize?: HeadingSize },
) => ReturnType<typeof KumoText>;

export const Toolbar: typeof KumoToolbar = Object.assign(
  forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof KumoToolbar>>(function Toolbar(props, ref) {
    return <KumoToolbar {...props} ref={ref} />;
  }),
  {
    Link: KumoToolbar.Link,
    Input: KumoToolbar.Input,
    InputGroup: KumoToolbar.InputGroup,
    Button: forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof KumoToolbar.Button>>(function ToolbarButton(
      { className, shape, ...props },
      ref,
    ) {
      return (
        <KumoToolbar.Button
          {...props}
          ref={ref}
          shape={shape}
          className={classes("ui-button", shape && shape !== "base" && "ui-button--icon", className)}
        />
      );
    }),
  },
);

export const Input: typeof KumoInput = forwardRef<HTMLInputElement, KumoInputProps>(function Input(
  { className, size = "base", ...props },
  ref,
) {
  return (
    <KumoInput
      {...props}
      ref={ref}
      size={size}
      data-control-size={size}
      data-control-error={Boolean(props.error) || props.variant === "error" || undefined}
      className={
        typeof className === "function"
          ? (state) => classes("ui-control ring-kumo-interact", className(state))
          : classes("ui-control ring-kumo-interact", className)
      }
    />
  );
});
export const InputArea: typeof KumoInputArea = forwardRef<HTMLTextAreaElement, KumoInputAreaProps>(function InputArea(
  { className, ...props },
  ref,
) {
  return (
    <KumoInputArea
      {...props}
      ref={ref}
      data-control-error={Boolean(props.error) || props.variant === "error" || undefined}
      className={classes("ui-control ring-kumo-interact", className)}
    />
  );
});
function ProductSelect<T, Multiple extends boolean | undefined = false>(
  props: Parameters<typeof KumoSelect<T, Multiple>>[0],
) {
  return (
    <KumoSelect
      {...props}
      render={props.render ?? <ProductSelectTrigger />}
      data-control-size={props.size ?? "base"}
      className={classes(
        "ui-control ring-kumo-interact",
        (props.size === "sm" || props.size === "xs") && "ui-control--compact",
        props.className,
      )}
    />
  );
}
const ProductSelectTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(
  function ProductSelectTrigger({ children, ...props }, ref) {
    return (
      <KumoButton {...props} ref={ref} variant="secondary">
        {Children.toArray(children).slice(0, -1)}
        <Icon name="chevron-down" className="size-4 text-kumo-subtle" />
      </KumoButton>
    );
  },
);
const ProductSelectOption: typeof KumoSelect.Option = ({ className, ...props }) => (
  <KumoSelect.Option {...props} className={classes("ui-select-option", className)} />
);
export const Select: typeof KumoSelect = Object.assign(ProductSelect, {
  Option: ProductSelectOption,
  Group: KumoSelect.Group,
  GroupLabel: KumoSelect.GroupLabel,
  Separator: KumoSelect.Separator,
});
export const LayerCard: typeof KumoLayerCard = Object.assign(
  forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof KumoLayerCard>>(function LayerCard(
    { className, ...props },
    ref,
  ) {
    return <KumoLayerCard {...props} ref={ref} className={classes("ui-surface", className)} />;
  }),
  { Primary: KumoLayerCard.Primary, Secondary: KumoLayerCard.Secondary },
);
export const Checkbox: typeof KumoCheckbox = KumoCheckbox;
type SwitchProps = Omit<ComponentPropsWithoutRef<typeof KumoSwitch>, "variant">;
type SwitchItemProps = Omit<ComponentPropsWithoutRef<typeof KumoSwitch.Item>, "variant">;

const SwitchItem: ForwardRefExoticComponent<SwitchItemProps & RefAttributes<HTMLButtonElement>> = forwardRef<
  HTMLButtonElement,
  SwitchItemProps
>(function SwitchItem({ className, ...props }, ref) {
  return (
    <KumoSwitch.Item
      {...props}
      ref={ref}
      variant="neutral"
      className={classes(
        "[&_[role=switch]]:bg-kumo-fill [&_[role=switch]]:ring-kumo-line [&_[role=switch][data-checked]]:bg-kumo-brand [&_[role=switch][data-checked]]:ring-kumo-brand [&_[role=switch]:focus-visible]:ring-kumo-focus [&_[role=switch][data-checked]:focus-visible]:ring-kumo-focus",
        className,
      )}
    />
  );
});

// Kumo's default switch uses fixed blue values rather than the theme's brand token.
// Both standalone and grouped switches use OpenTag selection colors at this shared seam.
export const Switch: ForwardRefExoticComponent<SwitchProps & RefAttributes<HTMLButtonElement>> &
  Pick<typeof KumoSwitch, "Group" | "Legend"> & { Item: typeof SwitchItem } = Object.assign(
  forwardRef<HTMLButtonElement, SwitchProps>(function Switch({ className, ...props }, ref) {
    return (
      <KumoSwitch
        {...props}
        ref={ref}
        variant="neutral"
        className={classes(
          "bg-kumo-fill ring-kumo-line data-[checked]:bg-kumo-brand data-[checked]:ring-kumo-brand focus-visible:ring-kumo-focus data-[checked]:focus-visible:ring-kumo-focus",
          className,
        )}
      />
    );
  }),
  { Group: KumoSwitch.Group, Item: SwitchItem, Legend: KumoSwitch.Legend },
);

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
  | "filter"
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
  if (variant === "inline" || variant === "filter") return "ghost";
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
  // Flat fills also replace Kumo's decorative gradient endpoints. Literal fallbacks keep
  // portal-mounted links usable when theme inheritance is unavailable; tests pin them to design.tokens.ts.
  return classes(
    buttonVariants({ variant: kumoButtonVariant(variant), size: size === "compact" ? "sm" : "base" }),
    "ui-button justify-center shadow-none",
    variant === "primary" && "ui-button--primary !text-(--on-primary)",
    variant === "danger" && "ui-button--danger",
    variant === "filter" && "ui-button--filter",
    (variant === "secondary" || variant === "outline") && "ui-button--secondary",
    size === "compact" && "ui-button--compact",
    variant === "primary" &&
      "[--kumo-button-emphasis-bg:var(--opentag-button-primary-bg,#00cbb4)] [--kumo-button-emphasis-gradient-end:var(--opentag-button-primary-bg,#00cbb4)] [--kumo-button-emphasis-gradient-start:var(--opentag-button-primary-bg,#00cbb4)] [--kumo-button-emphasis-ring:var(--opentag-button-primary-bg,#00cbb4)]",
    variant === "danger" &&
      "[--kumo-button-emphasis-bg:var(--opentag-button-danger-bg,#b42318)] [--kumo-button-emphasis-gradient-end:var(--opentag-button-danger-bg,#b42318)] [--kumo-button-emphasis-gradient-start:var(--opentag-button-danger-bg,#b42318)] [--kumo-button-emphasis-ring:var(--opentag-button-danger-bg,#b42318)]",
    className,
  );
}
type EmphasisButtonStyle = CSSProperties & {
  "--kumo-button-emphasis-bg": string;
  "--kumo-button-emphasis-gradient-end": string;
  "--kumo-button-emphasis-gradient-start": string;
  "--kumo-button-emphasis-ring": string;
};

function emphasisButtonStyle(variant: ButtonVariant): EmphasisButtonStyle | undefined {
  const intent = variant === "primary" ? "primary" : variant === "danger" ? "danger" : undefined;
  if (!intent) return undefined;
  const fallback = intent === "primary" ? designTokens.light.action : designTokens.light.danger;
  const surface = `var(--opentag-button-${intent}-bg, ${fallback})`;
  return {
    "--kumo-button-emphasis-bg": surface,
    "--kumo-button-emphasis-gradient-end": surface,
    "--kumo-button-emphasis-gradient-start": surface,
    "--kumo-button-emphasis-ring": surface,
  };
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, size = "default", style, variant = "primary", type = "button", ...props },
  ref,
) {
  const emphasisStyle = emphasisButtonStyle(variant);
  const shape = props.shape;
  const kumoProps: KumoButtonProps = {
    ...props,
    className: buttonClassName({
      className: classes(
        shape && shape !== "base" && "ui-button--icon",
        shape === "circle" && "ui-button--round",
        className,
      ),
      size,
      variant,
    }),
    size: size === "compact" ? "sm" : "base",
    style: emphasisStyle ? { ...style, ...emphasisStyle } : style,
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
      className={classes("ui-surface grid divide-y divide-kumo-line overflow-hidden bg-kumo-base", className)}
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
      className="grid gap-3 p-4 @min-[44rem]/content:grid-cols-[2fr_1fr] @min-[44rem]/content:items-center"
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
  hideLabel = false,
  hint,
  hintId,
  htmlFor: _htmlFor,
  label,
}: {
  children: ReactNode;
  className?: string;
  error?: ReactNode;
  errorId?: string;
  hideLabel?: boolean;
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
    child?.type === KumoInputControl ||
    child?.type === KumoInputAreaControl ||
    child?.type === Input ||
    child?.type === InputArea ||
    child?.type === Select ||
    child?.type === KumoSelect ||
    child?.type === KumoSelectControl;
  const labelledChildren =
    isKumoControl && !child.props["aria-label"] && !child.props["aria-labelledby"]
      ? cloneElement(child, { "aria-labelledby": labelId })
      : children;
  return (
    <div className={classes("min-w-0", className)} data-ui="field">
      <label
        className={classes(hideLabel ? "sr-only" : "mb-1 block text-sm font-medium text-kumo-default")}
        htmlFor={_htmlFor}
        id={labelId}
      >
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
    <span className={classes("ui-status inline-flex items-center gap-2", className)} data-state={tone} {...props}>
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
  | "code"
  | "compass"
  | "chart-bar"
  | "chevron-down"
  | "chevron-right"
  | "chevron-up"
  | "close"
  | "connector"
  | "copy"
  | "eye"
  | "eye-slash"
  | "file"
  | "instructions"
  | "overview"
  | "home"
  | "integrations"
  | "laptop"
  | "message"
  | "memory"
  | "model"
  | "more-vertical"
  | "plus"
  | "palette"
  | "pen-nib"
  | "search"
  | "settings"
  | "shield"
  | "skills"
  | "soul"
  | "sign-out"
  | "tree"
  | "trash"
  | "trend-up"
  | "tasks"
  | "text-bold"
  | "text-heading"
  | "list-bullets"
  | "list-checks"
  | "upload"
  | "user"
  | "usage";

const icons: Record<IconName, PhosphorIcon> = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  check: Check,
  code: Code,
  compass: Compass,
  "chart-bar": ChartBar,
  "chevron-down": CaretDown,
  "chevron-right": CaretRight,
  "chevron-up": CaretUp,
  close: X,
  connector: PlugsConnected,
  copy: Copy,
  eye: Eye,
  "eye-slash": EyeSlash,
  file: FileText,
  instructions: List,
  home: House,
  overview: SquaresFour,
  integrations: PlugsConnected,
  laptop: Laptop,
  message: ChatCircle,
  memory: TreeStructure,
  model: Cpu,
  "more-vertical": DotsThreeVertical,
  plus: Plus,
  palette: Palette,
  "pen-nib": PenNib,
  search: MagnifyingGlass,
  settings: Gear,
  shield: Shield,
  skills: Shield,
  soul: Fingerprint,
  "sign-out": ArrowRight,
  tree: TreeStructure,
  trash: Trash,
  tasks: List,
  "trend-up": TrendUp,
  "text-bold": TextB,
  "text-heading": TextH,
  "list-bullets": ListBullets,
  "list-checks": ListChecks,
  upload: UploadSimple,
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
    return <Input {...props} ref={ref} />;
  },
);

export type KumoInputAreaControlProps = TextareaHTMLAttributes<HTMLTextAreaElement> &
  Pick<KumoInputAreaProps, "size" | "variant">;

export const KumoInputAreaControl = forwardRef<HTMLTextAreaElement, KumoInputAreaControlProps>(
  function KumoInputAreaControl(props, ref) {
    return <InputArea {...props} ref={ref} />;
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
    container?: KumoSelectProps["container"];
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
    <Select {...kumoProps}>
      {normalizedOptions.map(({ option, value: optionValue }) => (
        <KumoSelect.Option disabled={option.props.disabled} key={optionValue} value={optionValue}>
          {option.props.children}
        </KumoSelect.Option>
      ))}
    </Select>
  );
}

/** Kumo compound dialog with a controlled open state and busy dismissal guard. */
export function Dialog({
  busy = false,
  children,
  className,
  closeLabel,
  headerActions,
  description,
  eyebrow,
  initialFocusRef,
  onBack,
  onClose,
  open = true,
  returnFocusRef,
  role = "dialog",
  showCloseButton = true,
  title,
}: {
  busy?: boolean;
  children: ReactNode;
  className?: string;
  closeLabel?: string;
  headerActions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onBack?: () => void;
  onClose: () => void;
  open?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  role?: "dialog" | "alertdialog";
  showCloseButton?: boolean;
  title: ReactNode;
}) {
  const id = useId();
  const headingRef = useRef<HTMLDivElement>(null);
  const returnFocusTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(returnFocusTimer.current), []);
  useEffect(() => {
    window.clearTimeout(returnFocusTimer.current);
    if (!open) return;
    const timer = window.setTimeout(() => (initialFocusRef?.current ?? headingRef.current)?.focus());
    return () => window.clearTimeout(timer);
  }, [initialFocusRef, open]);
  return (
    <KumoDialog.Root
      open={open}
      onOpenChangeComplete={(next) => {
        window.clearTimeout(returnFocusTimer.current);
        if (next) initialFocusRef?.current?.focus();
        // Restore after the focus trap and background inertness finish closing. In particular,
        // deletion may replace the original trigger with another row or the empty page.
        else returnFocusTimer.current = window.setTimeout(() => returnFocusRef?.current?.focus(), 0);
      }}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (!next) onClose();
      }}
      role={role === "alertdialog" ? "alertdialog" : "dialog"}
    >
      <KumoDialog className={classes("ui-dialog max-h-[min(90vh,42rem)] overflow-y-auto p-6", className)}>
        <div data-ui="dialog-header" className="mb-4 flex items-start justify-between gap-4">
          <div className="grid gap-1 outline-none" data-ui="dialog-heading" ref={headingRef} tabIndex={-1}>
            {eyebrow ? <span className="text-xs font-medium text-kumo-subtle">{eyebrow}</span> : null}
            <div className="flex items-center gap-3">
              {onBack ? (
                <Button
                  aria-label={m.common_back()}
                  disabled={busy}
                  shape="square"
                  size="compact"
                  variant="ghost"
                  onClick={onBack}
                >
                  <Icon name="arrow-left" />
                </Button>
              ) : null}
              <KumoDialog.Title id={`${id}-title`} className="text-lg font-semibold text-kumo-strong">
                {title}
              </KumoDialog.Title>
            </div>
          </div>
          {headerActions || showCloseButton ? (
            <div className="flex shrink-0 items-center gap-2">
              {headerActions}
              {showCloseButton ? (
                <Button
                  aria-label={
                    closeLabel ??
                    (typeof title === "string" ? m.common_close_title({ title }) : m.common_close_dialog())
                  }
                  className="shrink-0"
                  disabled={busy}
                  shape="square"
                  size="compact"
                  variant="ghost"
                  onClick={onClose}
                >
                  <Icon name="close" />
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        {description ? (
          <KumoDialog.Description className="mb-4 text-sm text-kumo-subtle">{description}</KumoDialog.Description>
        ) : null}
        {children}
      </KumoDialog>
    </KumoDialog.Root>
  );
}

export { Info, MagnifyingGlass, Wrench };
