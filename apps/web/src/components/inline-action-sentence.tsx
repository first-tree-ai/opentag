import type { ReactNode } from "react";
import { Button } from "../ui/design-system.js";

export interface InlineSentenceAction {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: (trigger: HTMLButtonElement) => void;
}

const FIRST = "￼";
const SECOND = "�";

/**
 * One sentence of an empty state whose phrases are its first actions, such as "Connect an existing tree,
 * or create a new one." `render` receives two placeholders and returns the translated sentence, so word
 * order stays with each locale's message.
 */
export function InlineActionSentence({
  render,
  first,
  second,
}: {
  render: (placeholders: { first: string; second: string }) => string;
  first: InlineSentenceAction;
  second: InlineSentenceAction;
}): ReactNode {
  const parts = render({ first: FIRST, second: SECOND }).split(/(￼|�)/u);
  return parts.map((part, index) => {
    const action = part === FIRST ? first : part === SECOND ? second : undefined;
    if (!action) return part;
    return (
      <Button
        // biome-ignore lint/suspicious/noArrayIndexKey: the sentence's parts are fixed for one render.
        key={index}
        variant="inline"
        disabled={action.disabled}
        className="inline! h-auto! min-h-0! rounded-sm! p-0! align-baseline whitespace-nowrap font-normal! text-kumo-brand hover:bg-transparent! hover:underline underline-offset-4"
        onClick={(event) => action.onClick(event.currentTarget)}
      >
        {action.label}
      </Button>
    );
  });
}
