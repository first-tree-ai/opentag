import mark from "../assets/opentag/site-brand-mark.png";
import lockup from "../assets/opentag/site-lockup.svg";

const MARK = { src: mark, width: 300, height: 300 };

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
      <img alt="" className="opentag-logo__light" src={variant === "mark" ? MARK.src : lockup} />
      <img alt="" className="opentag-logo__dark" height={MARK.height} src={MARK.src} width={MARK.width} />

      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
