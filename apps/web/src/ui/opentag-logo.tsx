import markDark from "../assets/opentag/logo-dark-transparent.svg";
import markLight from "../assets/opentag/logo-light-transparent.svg";

const MARK = { light: markLight, dark: markDark, width: 1254, height: 1254 };

/**
 * Homepage brand identity: the official OpenTag mark beside Sora 700 "OpenTag" lettering, as in
 * the https://opentag.build/ navigation. The mark pair keeps the light/dark artwork swap driven by
 * data-opentag-mode; the lettering follows the app foreground. One accessible label covers the
 * whole treatment, so the visual text is the label and stays hidden when none is given.
 */
export function OpenTagLogo({
  variant = "lockup",
  label,
}: {
  variant?: "lockup" | "mark" | "wordmark";
  label: string;
}) {
  return (
    <span aria-hidden={label ? undefined : true} className={`opentag-logo opentag-logo--${variant}`}>
      {variant === "wordmark" ? null : (
        <>
          <img alt="" className="opentag-logo__light" height={MARK.height} src={MARK.light} width={MARK.width} />
          <img alt="" className="opentag-logo__dark" height={MARK.height} src={MARK.dark} width={MARK.width} />
        </>
      )}
      {variant === "mark" ? null : <span className="opentag-logo__text">{label || "OpenTag"}</span>}
      {variant === "mark" && label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
