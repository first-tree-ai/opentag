import type { ReactNode } from "react";
import { PageHeader } from "../../components/kumo/page-header/page-header.js";
import { Text } from "../../ui/design-system.js";

export function Page({
  title,
  eyebrow,
  description,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid w-full gap-6" data-ui="page">
      <PageHeader description={description} eyebrow={eyebrow} title={title} titleId="page-title">
        {action}
      </PageHeader>
      {children}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 rounded-lg bg-kumo-base p-8 text-center ring ring-kumo-line" data-ui="empty">
      <Text as="h2" variant="heading">
        {title}
      </Text>
      <Text as="p" variant="secondary">
        {children}
      </Text>
    </section>
  );
}
