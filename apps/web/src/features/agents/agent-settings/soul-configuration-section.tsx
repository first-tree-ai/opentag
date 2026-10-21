import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button, Text } from "../../../ui/design-system.js";
import { AgentSettingsPageHeader } from "./settings-layout.js";
import { SoulEditor } from "./soul-editor.js";
import { SoulEmptyState } from "./soul-empty-state.js";
import { SoulFooter } from "./soul-footer.js";
import { SoulTemplateBrowser } from "./soul-template-browser.js";

export function SoulConfigurationSection({
  busy,
  dirty,
  feedback,
  id,
  onDiscard,
  onEdit,
  onSubmit,
  onValueChange,
  standalone,
  value,
}: {
  busy: boolean;
  dirty: boolean;
  feedback: { kind: "error" | "success"; text: string } | undefined;
  id: string;
  onDiscard: () => void;
  onEdit: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  onValueChange: (value: string) => void;
  standalone: boolean;
  value: string;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState(dirty);
  const focusEditorRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const writeRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const hasContent = value.trim().length > 0;
  const showEditor = editing || dirty || hasContent;
  useLayoutEffect(() => {
    if (editing && showEditor && focusEditorRef.current) {
      returnFocusRef.current = editorRef.current;
      editorRef.current?.focus({ preventScroll: true });
      focusEditorRef.current = false;
    }
  });
  function startEditing() {
    focusEditorRef.current = true;
    setEditing(true);
    onEdit();
  }
  function focusReadingAction() {
    requestAnimationFrame(() => (editRef.current ?? writeRef.current)?.focus({ preventScroll: true }));
  }
  function browse(trigger: HTMLButtonElement) {
    returnFocusRef.current = trigger;
    setBrowsing(true);
  }
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {standalone ? (
          <AgentSettingsPageHeader
            description={m.agent_settings_instructions_description()}
            id={`${id}-heading`}
            title={m.agent_settings_instructions_title()}
          />
        ) : (
          <header className="grid gap-2">
            <Text as="h3" id={`${id}-heading`} variant="heading">
              {m.agent_settings_instructions_title()}
            </Text>
            <p className="text-sm text-kumo-subtle">{m.agent_settings_instructions_description()}</p>
          </header>
        )}
        <Button disabled={busy} type="button" variant="secondary" onClick={(event) => browse(event.currentTarget)}>
          {m.agent_settings_soul_browse_templates()}
        </Button>
      </div>
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          if (await onSubmit(event)) {
            setEditing(false);
            focusReadingAction();
          }
        }}
      >
        {showEditor ? (
          <SoulEditor
            disabled={busy}
            footerRef={footerRef}
            inputRef={editorRef}
            id={id}
            readOnly={!editing}
            value={value}
            onValueChange={onValueChange}
          />
        ) : (
          <SoulEmptyState disabled={busy} onBrowse={browse} writeRef={writeRef} onWrite={startEditing} />
        )}
        <div ref={footerRef}>
          <SoulFooter
            busy={busy}
            dirty={dirty}
            editing={editing}
            empty={!hasContent}
            editRef={editRef}
            feedback={feedback}
            onEdit={startEditing}
            onDiscard={() => {
              setEditing(false);
              onDiscard();
              focusReadingAction();
            }}
          />
        </div>
      </form>
      <SoulTemplateBrowser
        open={browsing}
        onClose={() => setBrowsing(false)}
        onUse={(body) => {
          startEditing();
          onValueChange(body);
          returnFocusRef.current = editorRef.current;
          setBrowsing(false);
        }}
        replacesDraft={value.length > 0}
        returnFocusRef={returnFocusRef}
      />
    </section>
  );
}
