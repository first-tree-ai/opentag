import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, Icon } from "../ui/design-system.js";
import "./setup.css";

const COPY_FEEDBACK_MS = 1_600;

/**
 * A copyable shell command with a leading comment line.
 *
 * Callers key this component by the command it shows. A reissued command is therefore a fresh
 * instance rather than the same one with stale state, so "Copied" can never linger and claim the
 * clipboard holds something it no longer does.
 *
 * The comment is load-bearing rather than decorative: pasted into a terminal it is inert, and
 * pasted to an agent it becomes the instruction, which is what keeps an agent's behaviour
 * predictable. It is therefore part of the copied text, not page chrome around it.
 *
 * Being inert is why it is written as the POSIX null command rather than a `#` line. `#` only
 * introduces a comment where `interactive_comments` is set, which zsh — the macOS default shell —
 * leaves off for interactive use, so a pasted `#` line runs and answers `command not found: #`.
 * That opens a working command with what reads as a failure. `:` ignores its arguments and returns
 * zero in every POSIX shell, so the sentence stays silent in a terminal and still reads as an
 * instruction to an agent. The block shows exactly that line, because the manual-selection fallback
 * copies what is on screen rather than what the copy button would have written.
 */
interface CommandBlockSharedProps {
  copyLabel: string;
  copiedLabel: string;
  fallbackHint: string;
}

type CommandBlockProps = CommandBlockSharedProps &
  (
    | {
        /** Replaces the command with one centered action while preserving the command surface. */
        actionNotice: ReactNode;
        comment?: never;
        command?: never;
        expiredNotice?: never;
        inert?: never;
      }
    | {
        comment: string;
        command: string;
        /**
         * Shown across the block once its contents are dead. It speaks from the block itself rather
         * than from a line underneath, because the block is the thing that expired.
         */
        expiredNotice?: ReactNode;
        /** Renders the block's shape with nothing to act on, while its real contents are still coming. */
        inert?: boolean;
      }
  );

export function CommandBlock(props: CommandBlockProps) {
  if ("actionNotice" in props) {
    return <CommandActionBlock actionNotice={props.actionNotice} />;
  }
  return <CopyableCommandBlock {...props} />;
}

function CommandActionBlock({ actionNotice }: { readonly actionNotice: ReactNode }) {
  return (
    <div className="ots-command flex flex-col gap-1" data-action="true">
      <div className="ots-command__body flex items-start gap-3 rounded-lg border py-3 pr-3 pl-4">
        <div className="ots-command__action flex flex-wrap items-center justify-center gap-2 rounded-lg p-4 text-sm text-center">
          {actionNotice}
        </div>
      </div>
    </div>
  );
}

function CopyableCommandBlock({
  comment,
  command,
  copyLabel,
  copiedLabel,
  expiredNotice,
  fallbackHint,
  inert = false,
}: CommandBlockSharedProps & {
  readonly comment: string;
  readonly command: string;
  /**
   * Shown across the block once its contents are dead. It speaks from the block itself rather than
   * from a line underneath, because the block is the thing that expired.
   */
  readonly expiredNotice?: ReactNode;
  /** Renders the block's shape with nothing to act on, while its real contents are still coming. */
  readonly inert?: boolean;
}) {
  const commentLine = inertComment(comment);
  const split = command.lastIndexOf(" ") + 1;
  const lead = command.slice(0, split);
  const token = command.slice(split);
  const [copied, setCopied] = useState(false);
  const [hint, setHint] = useState<string>();
  const codeRef = useRef<HTMLElement>(null);
  const resetTimer = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(resetTimer.current);
    };
  }, []);

  async function copy() {
    const payload = `${commentLine}\n${command}`;
    try {
      await navigator.clipboard.writeText(payload);
      if (!mounted.current) return;
      setHint(undefined);
      setCopied(true);
      window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, COPY_FEEDBACK_MS);
    } catch {
      if (!mounted.current) return;
      setCopied(false);
      selectContents(codeRef.current);
      setHint(fallbackHint);
    }
  }

  const buttonLabel = copied ? copiedLabel : copyLabel;

  return (
    <div className="ots-command flex flex-col gap-1" data-expired={expiredNotice ? "true" : undefined}>
      <div className="ots-command__body flex items-start gap-3 rounded-lg border py-3 pr-3 pl-4">
        <pre className="ots-command__code flex-1 min-w-0">
          <code ref={codeRef}>
            <span className="ots-command__comment">{commentLine}</span>
            {"\n"}
            {lead}
            {/*
              The trailing token is an opaque secret — a connect code — and it breaks by character
              rather than at its own hyphens and underscores. Left to break at those, two codes of
              the same length wrap to a different number of lines and the block changes height when
              one is reissued; measured, that was 19px of movement below 640px. The rest of the
              command still breaks between words, so short tokens like `sh` stay whole.
            */}
            <span className="ots-command__token">{token}</span>
          </code>
        </pre>
        {/*
          Icon only, and deliberately so. A button whose label changes changes width, and this one
          sits beside the command: the swap from "Copy" to "Copied" was wide enough to reflow the
          comment line underneath it. An icon is the same size in both states.
        */}
        <Button
          aria-label={buttonLabel}
          className="ots-command__copy shrink-0"
          data-copied={copied ? "true" : undefined}
          disabled={inert || expiredNotice !== undefined}
          onClick={() => void copy()}
          size="compact"
          title={buttonLabel}
          variant="ghost"
        >
          <Icon name={copied ? "check" : "copy"} />
        </Button>
        {expiredNotice ? (
          <div className="ots-command__expired flex flex-wrap items-center justify-center gap-2 rounded-lg p-4 text-sm text-center">
            {expiredNotice}
          </div>
        ) : null}
      </div>
      {hint ? (
        <p className="text-sm text-kumo-subtle m-0" role="status">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Selects the command so a browser without clipboard access still allows a manual copy. */
function selectContents(node: HTMLElement | null): void {
  const selection = window.getSelection?.();
  if (!node || !selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Wraps a sentence as the POSIX null command so a terminal ignores it and an agent still reads it. */
function inertComment(comment: string): string {
  return `: '${comment.replace(/'/g, `'\\''`)}'`;
}
