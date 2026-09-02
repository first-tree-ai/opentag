import { cn, Tabs, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export const KUMO_PAGE_HEADER_VARIANTS = {
  spacing: {
    compact: {
      classes: "gap-1",
      description: "Compact spacing between header elements",
    },
    base: {
      classes: "gap-2",
      description: "Default spacing between header elements",
    },
    relaxed: {
      classes: "gap-4",
      description: "Relaxed spacing for more prominent headers",
    },
  },
} as const;

export const KUMO_PAGE_HEADER_DEFAULT_VARIANTS = {
  spacing: "base",
} as const;

export type KumoPageHeaderSpacing = keyof typeof KUMO_PAGE_HEADER_VARIANTS.spacing;

export interface KumoPageHeaderVariantsProps {
  spacing?: KumoPageHeaderSpacing;
}

export interface PageHeaderTab {
  value: string;
  label: ReactNode;
}

export function pageHeaderVariants({
  spacing = KUMO_PAGE_HEADER_DEFAULT_VARIANTS.spacing,
}: KumoPageHeaderVariantsProps = {}) {
  return cn("flex flex-col", KUMO_PAGE_HEADER_VARIANTS.spacing[spacing].classes);
}

export interface PageHeaderProps extends KumoPageHeaderVariantsProps {
  breadcrumbs?: ReactNode;
  eyebrow?: ReactNode;
  title?: string;
  description?: string;
  titleId?: string;
  tabs?: PageHeaderTab[];
  defaultTab?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children?: ReactNode;
}

export function PageHeader({
  breadcrumbs,
  eyebrow,
  title,
  description,
  titleId,
  tabs,
  defaultTab,
  onValueChange,
  spacing = "base",
  className,
  children,
}: PageHeaderProps) {
  return (
    <div className={cn(pageHeaderVariants({ spacing }), className)} data-ui="page-header">
      {breadcrumbs ? <div className="border-b border-kumo-line">{breadcrumbs}</div> : null}

      {(title || description || (!tabs && children)) && (
        <div className="flex flex-wrap items-start justify-between gap-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            {eyebrow ? (
              <Text as="span" size="xs" variant="secondary">
                {eyebrow}
              </Text>
            ) : null}
            {title && (
              <Text as="h1" id={titleId} size="lg" variant="heading">
                {title}
              </Text>
            )}
            {description && (
              <div className="max-w-prose">
                <Text as="p" variant="secondary">
                  {description}
                </Text>
              </div>
            )}
          </div>
          {!tabs && children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
        </div>
      )}

      {tabs && (
        <div className="flex w-full items-center justify-between border-b border-kumo-line pt-1 pb-3 pl-3">
          <Tabs
            tabs={tabs}
            selectedValue={defaultTab}
            onValueChange={(nextValue) => {
              const stringValue = String(nextValue);
              onValueChange?.(stringValue);
            }}
          />

          <div className="flex items-center gap-2">{children}</div>
        </div>
      )}
    </div>
  );
}
