import { type RefObject, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as m from "../../../paraglide/messages.js";
import { Button, Dialog, Icon, Text } from "../../../ui/design-system.js";
import { type SoulTemplate, soulTemplates } from "./soul-templates.js";
import "./soul-document.css";

/** Browsing is local: only Use template changes the editor's draft. */
export function SoulTemplateBrowser({
  open,
  onClose,
  onUse,
  replacesDraft,
  returnFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  onUse: (body: string) => void;
  replacesDraft: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      className="flex h-[min(48rem,calc(100dvh-2rem))] max-h-none! w-[min(64rem,calc(100vw-2rem))]! max-w-none! flex-col overflow-hidden! p-0! [&>[data-ui=dialog-header]]:m-0 [&>[data-ui=dialog-header]]:shrink-0 [&>[data-ui=dialog-header]]:items-center [&>[data-ui=dialog-header]]:border-b [&>[data-ui=dialog-header]]:border-kumo-line [&>[data-ui=dialog-header]]:p-4 md:[&>[data-ui=dialog-header]]:px-6"
      open={open}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      title={m.agent_settings_soul_choose_template()}
    >
      {open ? <TemplateChoices onClose={onClose} onUse={onUse} replacesDraft={replacesDraft} /> : null}
    </Dialog>
  );
}

function TemplateChoices({
  onClose,
  onUse,
  replacesDraft,
}: {
  onClose: () => void;
  onUse: (body: string) => void;
  replacesDraft: boolean;
}) {
  const templates = soulTemplates();
  const [selectedId, setSelectedId] = useState<SoulTemplate["id"]>("engineering");
  const [showDetail, setShowDetail] = useState(false);
  const selected = templates.find((template) => template.id === selectedId) ?? templates[0];
  const readerRef = useRef<HTMLElement>(null);
  const selectedButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (showDetail && !window.matchMedia("(min-width: 768px)").matches) readerRef.current?.focus();
  }, [showDetail]);

  return (
    <>
      <div className="grid min-h-0 flex-1 md:grid-cols-[17rem_minmax(0,1fr)]">
        <nav
          aria-label={m.agent_settings_soul_template_list()}
          className={`${showDetail ? "hidden" : "block"} min-h-0 overflow-y-auto p-3 md:block md:border-r md:border-kumo-line`}
        >
          <ul className="grid gap-1">
            {templates.map((template) => (
              <li key={template.id}>
                <Button
                  aria-describedby={`soul-template-${template.id}-summary`}
                  aria-label={template.name}
                  aria-pressed={selectedId === template.id}
                  className="h-auto! min-h-16 w-full! justify-start gap-3 px-3 py-3 text-left whitespace-normal aria-pressed:bg-(--brand-soft) aria-pressed:text-kumo-brand"
                  ref={selectedId === template.id ? selectedButtonRef : undefined}
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (readerRef.current) readerRef.current.scrollTop = 0;
                    setSelectedId(template.id);
                    setShowDetail(true);
                  }}
                >
                  <Icon className="size-5" name={template.icon} />
                  <span className="grid min-w-0 gap-1">
                    <span className="font-medium">{template.name}</span>
                    <span
                      className="text-xs leading-relaxed font-normal text-kumo-subtle"
                      id={`soul-template-${template.id}-summary`}
                    >
                      {template.summary}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
        <section
          aria-labelledby="soul-template-name"
          className={`${showDetail ? "block" : "hidden"} min-h-0 overflow-y-auto overscroll-contain p-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset md:block md:p-8`}
          ref={readerRef}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The complete document is a keyboard-scrollable reading region.
          tabIndex={0}
        >
          <Button
            className="mb-4 md:hidden!"
            size="compact"
            type="button"
            variant="ghost"
            onClick={() => {
              setShowDetail(false);
              requestAnimationFrame(() => selectedButtonRef.current?.focus());
            }}
          >
            <Icon name="arrow-left" />
            {m.agent_settings_soul_template_back()}
          </Button>
          <Text as="h2" variant="heading" id="soul-template-name">
            {selected.name}
          </Text>
          <p className="mt-3 text-sm leading-relaxed text-kumo-subtle">{selected.overview}</p>
          <div className="soul-document mt-6 rounded-lg bg-kumo-tint p-4 md:p-6">
            <ReactMarkdown
              components={{
                h2: ({ children }) => (
                  <Text as="h3" variant="heading">
                    {children}
                  </Text>
                ),
              }}
            >
              {selected.body}
            </ReactMarkdown>
          </div>
        </section>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-kumo-line px-4 py-4 md:px-6">
        <p className="hidden flex-1 text-xs leading-relaxed text-kumo-subtle md:block">
          {replacesDraft ? m.agent_settings_soul_template_replace_hint() : m.agent_settings_soul_template_edit_hint()}
        </p>
        <p className="w-full text-xs leading-relaxed text-kumo-subtle md:hidden">
          {showDetail
            ? replacesDraft
              ? m.agent_settings_soul_template_replace_hint()
              : m.agent_settings_soul_template_edit_hint()
            : m.agent_settings_soul_template_choose_hint()}
        </p>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button
            className={showDetail ? undefined : "hidden! md:inline-flex!"}
            type="button"
            onClick={() => onUse(selected.body)}
          >
            {m.agent_settings_soul_use_template()}
          </Button>
        </div>
      </div>
    </>
  );
}
