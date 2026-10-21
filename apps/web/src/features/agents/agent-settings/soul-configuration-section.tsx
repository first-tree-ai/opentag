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
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  onValueChange: (value: string) => void;
  standalone: boolean;
  value: string;
}) {
  const [browsing, setBrowsing] = useState(false);
  const [writing, setWriting] = useState(false);
  const focusEditorRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const writeRef = useRef<HTMLButtonElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const showEditor = writing || dirty || value.length > 0;
  useLayoutEffect(() => {
    if (showEditor && focusEditorRef.current) {
      returnFocusRef.current = editorRef.current;
      editorRef.current?.focus();
      focusEditorRef.current = false;
    }
  }, [showEditor]);
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
          if (await onSubmit(event)) setWriting(false);
        }}
      >
        {showEditor ? (
          <SoulEditor
            disabled={busy}
            footerRef={footerRef}
            inputRef={editorRef}
            id={id}
            value={value}
            onValueChange={onValueChange}
          />
        ) : (
          <SoulEmptyState
            disabled={busy}
            onBrowse={browse}
            writeRef={writeRef}
            onWrite={() => {
              focusEditorRef.current = true;
              setWriting(true);
              onValueChange(value);
            }}
          />
        )}
        <div ref={footerRef}>
          <SoulFooter
            busy={busy}
            dirty={dirty}
            empty={value === ""}
            feedback={feedback}
            onDiscard={() => {
              setWriting(false);
              onDiscard();
              requestAnimationFrame(() => (editorRef.current ?? writeRef.current)?.focus());
            }}
          />
          {writing && !dirty && value === "" ? (
            <div className="flex justify-end">
              <Button
                disabled={busy}
                type="button"
                variant="ghost"
                onClick={() => {
                  setWriting(false);
                  requestAnimationFrame(() => writeRef.current?.focus());
                }}
              >
                {m.common_cancel()}
              </Button>
            </div>
          ) : null}
        </div>
      </form>
      <SoulTemplateBrowser
        open={browsing}
        onClose={() => setBrowsing(false)}
        onUse={(body) => {
          focusEditorRef.current = !showEditor;
          setWriting(true);
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
