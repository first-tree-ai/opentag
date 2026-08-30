import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { Component, type ErrorInfo, type HTMLAttributes, type ReactNode } from "react";
import { Button, Text } from "../ui/design-system.js";

type BoundaryError = Error & { digest?: string };
type BoundaryErrorInfo = { componentStack?: string | null };
type BoundaryName = "app" | "route" | "root";

export type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error?: BoundaryError;
};

/**
 * Keeps an unexpected render failure from leaving the application root blank.
 *
 * TanStack Router catches errors thrown while rendering a route. This boundary is still needed
 * around the router itself because providers, the router boot process, and non-route UI can fail
 * before a route match has a chance to install its own boundary.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {};

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportBoundaryError("app", error, errorInfo);
  }

  private readonly reload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return <StandaloneErrorPage actionLabel="Try again" onAction={this.reload} />;
    }
    return this.props.children;
  }
}

/**
 * Error component used by route matches and as the router-wide fallback. It intentionally does not
 * display the thrown message: route errors can contain request URLs or provider details that are
 * useful in a local log but are not safe to put in a shared browser surface.
 */
export function RouteErrorPage({ reset }: ErrorComponentProps) {
  const router = useRouter();

  const retry = () => {
    // Reset the local boundary immediately, then invalidate the match so loaders and beforeLoad
    // handlers run again. reset() alone would only replay the same failed render.
    reset();
    void router.invalidate();
  };

  return (
    <BoundaryCard data-ui="route-error">
      <Text as="span" variant="secondary">
        OpenTag
      </Text>
      <Text as="h1" size="lg" variant="heading">
        Something went wrong
      </Text>
      <Text as="p" variant="secondary">
        OpenTag could not load this page. Try again, or return to Agents and continue from there.
      </Text>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={retry}>Try again</Button>
        <Link className="text-sm font-medium text-kumo-brand underline-offset-4 hover:underline" to="/agents">
          Back to Agents
        </Link>
      </div>
    </BoundaryCard>
  );
}

export function StandaloneErrorPage({ actionLabel, onAction }: { actionLabel: string; onAction: () => void }) {
  return (
    <main className="app-error-boundary grid bg-kumo-canvas p-6" data-ui="app-error-boundary">
      <BoundaryCard>
        <Text as="span" variant="secondary">
          OpenTag
        </Text>
        <Text as="h1" size="lg" variant="heading">
          Something went wrong
        </Text>
        <Text as="p" variant="secondary">
          OpenTag could not load the application. Reload the page and try again.
        </Text>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onAction}>{actionLabel}</Button>
          <a className="text-sm font-medium text-kumo-brand underline-offset-4 hover:underline" href="/agents">
            Back to Agents
          </a>
        </div>
      </BoundaryCard>
    </main>
  );
}

function BoundaryCard({ children, ...props }: { children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section
      {...props}
      className="app-error-boundary__card grid w-full gap-3 rounded-lg bg-kumo-base p-6 shadow-sm ring ring-kumo-line"
    >
      {children}
    </section>
  );
}

function normalizeError(value: unknown): BoundaryError {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Unknown application error");
}

/** Logs diagnostics without copying credential-shaped values into the browser console. */
export function reportBoundaryError(boundary: BoundaryName, error: unknown, errorInfo?: BoundaryErrorInfo) {
  const normalized = normalizeError(error);
  console.error("[OpenTag] Unhandled UI error", {
    boundary,
    error: {
      name: redactErrorMessage(normalized.name),
      message: redactErrorMessage(normalized.message),
    },
    componentStack: errorInfo?.componentStack ? redactErrorMessage(errorInfo.componentStack) : undefined,
  });
}

/** Replaces React 19's default root reporting so caught and uncaught errors stay sanitized. */
export const rootErrorHandlers = {
  onCaughtError: (error: unknown, errorInfo: BoundaryErrorInfo) => reportBoundaryError("root", error, errorInfo),
  onRecoverableError: (error: unknown, errorInfo: BoundaryErrorInfo) => reportBoundaryError("root", error, errorInfo),
  onUncaughtError: (error: unknown, errorInfo: BoundaryErrorInfo) => reportBoundaryError("root", error, errorInfo),
};

const credentialKey = "(?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)";
const quotedValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const arrayValue = String.raw`\[(?:${quotedValue}|[^\[\]"'])*\]`;
const objectValue = String.raw`\{(?:${quotedValue}|[^{}"'])*\}`;
const structuredValue = `(?:${arrayValue}|${objectValue}|${quotedValue})`;
const structuredValueWithBoundary = String.raw`${structuredValue}(?=\s*(?:[,}\n]|$))`;
const authorizationField = new RegExp(
  String.raw`(["']?authorization["']?\s*[:=]\s*)(${structuredValueWithBoundary}|[^\r\n]*)`,
  "gi",
);
const cookieField = new RegExp(
  String.raw`(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*)(${structuredValueWithBoundary}|[^\r\n]*)`,
  "gi",
);

function redactErrorMessage(message: string): string {
  return message
    .replace(
      authorizationField,
      (_match, prefix: string, value: string) => `${prefix}${redactAuthorizationValue(value)}`,
    )
    .replace(cookieField, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(
      new RegExp(
        `(["']?${credentialKey}["']?\\s*[:=]\\s*)(Bearer\\s+(?:"[^"]*"|'[^']*'|[^\\s,;}\\]]+)|"[^"]*"|'[^']*'|[^\\s,;}\\]]+)`,
        "gi",
      ),
      (_match, prefix: string, value: string) =>
        `${prefix}${/^Bearer\s/i.test(value) ? "Bearer [REDACTED]" : "[REDACTED]"}`,
    )
    .replace(/\bBearer\s+(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:code|client_secret|token|secret|password|key)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function redactAuthorizationValue(value: string): string {
  const trimmed = value.trim();
  const quote = /^(["'])Bearer\s/i.exec(trimmed)?.[1] ?? "";
  if (!/^['"]?Bearer\s/i.test(trimmed)) return "[REDACTED]";
  return `${quote}Bearer [REDACTED]${quote && trimmed.endsWith(quote) ? quote : ""}`;
}
