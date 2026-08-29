import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button, Icon } from "../ui/design-system.js";

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
 */
export function CommandBlock({
  comment,
  command,
  copyLabel,
  copiedLabel,
  fallbackHint,
  footer,
  inert = false,
  muted = false,
}: {
  comment: string;
  command: string;
  copyLabel: string;
  copiedLabel: string;
  fallbackHint: string;
  footer?: ReactNode;
  /** Renders the block's shape with nothing to act on, while its real contents are still coming. */
  inert?: boolean;
  /** Dims the block when its contents can no longer be used, such as an expired code. */
  muted?: boolean;
}) {
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
    const payload = `${comment}\n${command}`;
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

  return (
    <div className="otv2-command" data-muted={muted ? "true" : undefined}>
      <div className="otv2-command__body">
        <pre className="otv2-command__code">
          <code ref={codeRef}>
            <span className="otv2-command__comment">{comment}</span>
            {"\n"}
            {command}
          </code>
        </pre>
        <Button
          className="otv2-command__copy"
          data-copied={copied ? "true" : undefined}
          disabled={inert}
          onClick={() => void copy()}
          size="compact"
          variant="secondary"
        >
          <Icon name={copied ? "check" : "instructions"} />
          <span>{copied ? copiedLabel : copyLabel}</span>
        </Button>
      </div>
      {/* Always rendered, even when empty: the countdown disappearing must not move the page. */}
      <div className="otv2-command__footer">{footer}</div>
      {hint ? (
        <p className="otv2-command__hint" role="status">
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
