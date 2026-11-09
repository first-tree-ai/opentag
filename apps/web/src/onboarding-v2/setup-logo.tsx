import { OpenTagLogo } from "../ui/opentag-logo.js";

/**
 * The setup header's logo: the full lockup from small tablets up, the mark alone on phones, so the
 * logo, Back to Agents, and the Account menu share one row. With a `label` it names itself; inside a
 * link the link carries the name instead.
 */
export function SetupLogo({ label }: { label?: string }) {
  const logos = (
    <>
      <span className="max-sm:hidden">
        <OpenTagLogo label="" />
      </span>
      <span className="sm:hidden">
        <OpenTagLogo label="" variant="mark" />
      </span>
    </>
  );
  return label ? (
    <span aria-label={label} className="inline-flex" role="img">
      {logos}
    </span>
  ) : (
    logos
  );
}
