import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, DropdownMenu, Icon, Tooltip } from "../../../ui/design-system.js";

export type OverflowFilterItem = { value: string; label: string };

function fittingCount(widths: number[], width: number, gap: number, triggerWidth: number): number {
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  if (total <= width) return widths.length;
  let used = triggerWidth;
  let count = 0;
  for (const itemWidth of widths) {
    if (used + gap + itemWidth > width) break;
    used += gap + itemWidth;
    count++;
  }
  return count;
}

/** A fixed-order, single-choice filter whose trailing items move into an accessible menu. */
export function OverflowFilter({
  items,
  value,
  onValueChange,
  label,
  moreLabel,
  disabled = false,
  className,
}: {
  items: readonly OverflowFilterItem[];
  value: string | null;
  onValueChange: (value: string) => void;
  label: string;
  moreLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  const [count, setCount] = useState(items.length);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const measures = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    let disposed = false;
    function measure() {
      if (disposed || !container.current || !measures.current) return;
      const width = container.current.getBoundingClientRect().width;
      const buttons = [...measures.current.querySelectorAll("button")];
      const widths = buttons.slice(0, items.length).map((button) => button.getBoundingClientRect().width);
      const more = buttons.at(-1);
      if (!width || !widths.length || widths.some((width) => !width) || !more) return;
      const gap = Number.parseFloat(getComputedStyle(container.current).columnGap) || 0;
      const iconWidth = more.querySelector("svg")?.getBoundingClientRect().width ?? 0;
      const iconGap = Number.parseFloat(getComputedStyle(more).columnGap) || 0;
      // Reserve every possible selected label so choosing an overflow item never shifts its peers.
      const triggerWidth = Math.min(
        width,
        Math.max(more.getBoundingClientRect().width, ...widths.map((width) => width + iconWidth + iconGap)),
      );
      setCount(fittingCount(widths, width, gap, triggerWidth));
    }
    const observer = new ResizeObserver(measure);
    if (container.current) observer.observe(container.current);
    if (measures.current) observer.observe(measures.current);
    measure();
    document.fonts?.ready.then(measure);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", measure);
    };
  }, [items]);

  const visible = items.slice(0, count);
  const overflow = items.slice(count);
  const selected = overflow.find((item) => item.value === value);
  const triggerLabel = selected?.label ?? moreLabel;
  return (
    <div className={className}>
      <div aria-hidden="true" inert className="invisible absolute h-0 w-0 overflow-hidden">
        <div ref={measures} className="flex w-max" data-ui="overflow-filter-measures">
          {items.map((item) => (
            <Button key={item.value} className="shrink-0 whitespace-nowrap" size="compact" variant="filter">
              {item.label}
            </Button>
          ))}
          <Button className="shrink-0 gap-2 whitespace-nowrap" size="compact" variant="filter">
            {moreLabel}
            <Icon className="size-4" name="chevron-down" />
          </Button>
        </div>
      </div>
      <fieldset className="m-0 min-w-0 border-0 p-0" data-ui="overflow-filter">
        <legend className="sr-only">{label}</legend>
        <div ref={container} className="flex min-w-0 flex-nowrap items-center gap-2">
          {visible.map((item) => (
            <Button
              key={item.value}
              aria-pressed={item.value === value}
              className="shrink-0 whitespace-nowrap"
              disabled={disabled}
              size="compact"
              variant="filter"
              onClick={() => onValueChange(item.value)}
            >
              {item.label}
            </Button>
          ))}
          {overflow.length > 0 && (
            <DropdownMenu open={open && !disabled} onOpenChange={setOpen}>
              <Tooltip
                content={triggerLabel}
                disabled={!selected || open}
                render={
                  <DropdownMenu.Trigger
                    render={
                      <Button
                        className="min-w-0 gap-2"
                        data-selected={Boolean(selected)}
                        disabled={disabled}
                        size="compact"
                        variant="filter"
                      />
                    }
                  >
                    <span className="truncate">{triggerLabel}</span>
                    <Icon className="size-4 shrink-0 text-kumo-subtle" name="chevron-down" />
                  </DropdownMenu.Trigger>
                }
              />
              <DropdownMenu.Content align="end">
                <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
                  {overflow.map((item) => (
                    <DropdownMenu.RadioItem
                      key={item.value}
                      closeOnClick
                      className="gap-6 data-checked:bg-(--brand-soft) data-checked:font-semibold data-checked:text-kumo-default"
                      disabled={disabled}
                      value={item.value}
                    >
                      {item.label}
                      <DropdownMenu.RadioItemIndicator />
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu>
          )}
        </div>
      </fieldset>
    </div>
  );
}
