import { useLayoutEffect, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { InputArea } from "../../../ui/design-system.js";

export function SoulEditor({
  disabled,
  id,
  onValueChange,
  value,
}: {
  disabled: boolean;
  id: string;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const exampleRef = useRef<HTMLDivElement>(null);
  const [exampleHeight, setExampleHeight] = useState<number>();
  const showExample = value.length === 0;
  const principles = [
    m.agent_settings_soul_example_voice(),
    m.agent_settings_soul_example_workflow(),
    m.agent_settings_soul_example_review(),
    m.agent_settings_soul_example_clarification(),
    m.agent_settings_soul_example_uncertainty(),
  ];
  const example = [
    m.agent_settings_soul_example_label(),
    m.agent_settings_soul_example_personality(),
    "",
    ...principles.map((principle) => `• ${principle}`),
  ].join("\n");

  useLayoutEffect(() => {
    if (!showExample) return;
    const element = exampleRef.current;
    if (!element) return;
    // Include the input's two border pixels so wrapped examples fit at narrow widths.
    const measure = () => setExampleHeight(element.getBoundingClientRect().height + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showExample]);

  return (
    <div className="relative">
      {/* Match example and input text: 16px in compact layouts, 14px on desktop. */}
      <InputArea
        aria-describedby={showExample ? `${id}-help ${id}-example` : `${id}-help`}
        aria-label={m.agent_settings_instructions_title()}
        autoResize
        className="min-h-72 w-full resize-y p-5 text-[1rem]! leading-relaxed md:text-[0.875rem]!"
        disabled={disabled}
        id={id}
        maxRows={24}
        minRows={12}
        name="instructions"
        style={showExample ? { minHeight: exampleHeight } : undefined}
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
          <p className="mt-2.5">{m.agent_settings_soul_example_personality()}</p>
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
