import type { RefObject } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button, Icon, Text } from "../../../ui/design-system.js";

export function SoulEmptyState({
  disabled,
  onBrowse,
  onWrite,
  writeRef,
}: {
  disabled: boolean;
  onBrowse: (trigger: HTMLButtonElement) => void;
  onWrite: () => void;
  writeRef: RefObject<HTMLButtonElement | null>;
}) {
  const description = m.agent_settings_soul_empty_description({
    browseTemplates: "\uFFFC",
    writeYourOwn: "\uFFFD",
  });
  const parts = description.split(/(\uFFFC|\uFFFD)/u);
  return (
    <div className="flex flex-col items-center gap-5 px-4 py-12 text-center sm:py-16" data-ui="soul-empty-state">
      <Icon name="soul" weight="light" className="size-8 text-kumo-inactive" />
      <div className="flex max-w-sm flex-col gap-2">
        <Text as="h2" size="lg" variant="heading">
          {m.agent_settings_soul_empty_title()}
        </Text>
        <Text as="p" size="sm" variant="secondary">
          {parts.map((part) =>
            part === "\uFFFC" || part === "\uFFFD" ? (
              <Button
                className="inline! h-auto! min-h-0! rounded-sm! p-0! align-baseline font-normal! text-kumo-brand hover:bg-transparent! hover:underline underline-offset-4"
                disabled={disabled}
                key={part}
                ref={part === "\uFFFD" ? writeRef : undefined}
                type="button"
                variant="inline"
                onClick={(event) => (part === "\uFFFC" ? onBrowse(event.currentTarget) : onWrite())}
              >
                {part === "\uFFFC" ? m.agent_settings_soul_empty_browse() : m.agent_settings_soul_write_own()}
              </Button>
            ) : (
              part
            ),
          )}
        </Text>
      </div>
    </div>
  );
}
