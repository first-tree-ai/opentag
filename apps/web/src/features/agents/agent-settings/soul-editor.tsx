import { type RefObject, useRef } from "react";
import * as m from "../../../paraglide/messages.js";
import { InputArea } from "../../../ui/design-system.js";
import { useSoulEditorHeight } from "./use-soul-editor-height.js";

export function SoulEditor({
  disabled,
  footerRef,
  id,
  onValueChange,
  value,
}: {
  disabled: boolean;
  footerRef: RefObject<HTMLDivElement | null>;
  id: string;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const exampleRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useSoulEditorHeight(value, editorRef, exampleRef, footerRef);
  const showExample = value.length === 0;
  const principles = [
    m.agent_settings_soul_example_voice(),
    m.agent_settings_soul_example_uncertainty(),
    m.agent_settings_soul_example_workflow(),
    m.agent_settings_soul_example_review(),
    m.agent_settings_soul_example_clarification(),
  ];
  const example = [
    m.agent_settings_soul_example_label(),
    m.agent_settings_soul_example_role(),
    m.agent_settings_soul_example_personality(),
    "",
    ...principles.map((principle) => `• ${principle}`),
  ].join("\n");

  return (
    <div className="relative">
      {/* Match example and input text: 16px in compact layouts, 14px on desktop. */}
      <InputArea
        aria-describedby={showExample ? `${id}-help ${id}-example` : `${id}-help`}
        aria-label={m.agent_settings_instructions_title()}
        className="block w-full resize-y p-5 text-[1rem]! leading-relaxed md:text-[0.875rem]!"
        disabled={disabled}
        id={id}
        name="instructions"
        ref={editorRef}
        rows={12}
        value={value}
        onValueChange={onValueChange}
      />
      {showExample ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 p-5 text-[1rem] leading-relaxed text-kumo-inactive md:text-[0.875rem]"
          ref={exampleRef}
        >
          <span className="inline-block rounded bg-kumo-recessed px-2 py-0.5 text-xs font-medium text-kumo-subtle">
            {m.agent_settings_soul_example_label()}
          </span>
          <p className="mt-2.5">
            {m.agent_settings_soul_example_role()}
            <br />
            {m.agent_settings_soul_example_personality()}
          </p>
          <ul className="mt-4 list-disc space-y-2 pl-4">
            {principles.map((principle) => (
              <li key={principle}>{principle}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="sr-only" id={`${id}-help`}>
        {m.agent_settings_soul_editor_help()}
      </p>
      {showExample ? (
        <p className="sr-only" id={`${id}-example`}>
          {example}
        </p>
      ) : null}
    </div>
  );
}
