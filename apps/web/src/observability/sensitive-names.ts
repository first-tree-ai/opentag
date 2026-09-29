/**
 * The vocabulary that marks a *name* as carrying a credential rather than configuration.
 *
 * One source for both the diagnostic redactor and the MCP configuration import: `X-Client-Secret` is
 * a secret wherever it appears, and the two consumers must not drift apart into different opinions
 * about which names are sensitive. The fragment is deliberately the same expression the redactor
 * already used, so extracting it changes no redaction behavior.
 *
 * Written as a fragment rather than a whole pattern because each caller composes it differently: the
 * redactor anchors it inside a `name: value` expression, while the importer matches a header name that
 * may carry a vendor prefix (`x-goog-api-key`) and treats `authorization` and the cookie headers as
 * credentials of their own.
 */
export const SENSITIVE_NAME_PATTERN =
  "(?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)";
