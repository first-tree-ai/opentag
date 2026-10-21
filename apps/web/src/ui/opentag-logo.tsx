import markDark from "../assets/opentag/logo-dark-transparent.svg";
import markLight from "../assets/opentag/site-brand-mark.png";
import lockup from "../assets/opentag/site-lockup.svg";

const MARK = { light: markLight, dark: markDark, width: 1254, height: 1254 };

/** Official website artwork; cat avatars are owned separately. */
export function OpenTagLogo({
  variant = "lockup",
  label,
  className = "",
}: {
  variant?: "lockup" | "mark";
  label: string;
  className?: string;
}) {
  return (
    <span aria-hidden={label ? undefined : true} className={`opentag-logo opentag-logo--${variant} ${className}`}>
      <img alt="" className="opentag-logo__light" src={variant === "mark" ? MARK.light : lockup} />
      <img alt="" className="opentag-logo__dark" height={MARK.height} src={MARK.dark} width={MARK.width} />

      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
