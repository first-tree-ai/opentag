import lockupDark from "../assets/opentag/lockup-dark-transparent.svg";
import lockupLight from "../assets/opentag/lockup-light-transparent.svg";
import markDark from "../assets/opentag/logo-dark-transparent.svg";
import markLight from "../assets/opentag/logo-light-transparent.svg";
import wordmarkLight from "../assets/opentag/wordmark-black.svg";
import wordmarkDark from "../assets/opentag/wordmark-white.svg";

const ART = {
  lockup: { light: lockupLight, dark: lockupDark, width: 2525, height: 900 },
  mark: { light: markLight, dark: markDark, width: 1254, height: 1254 },
  wordmark: { light: wordmarkLight, dark: wordmarkDark, width: 4524, height: 1273 },
};

/** Official artwork, with one accessible label shared by the app's light and dark variants. */
export function OpenTagLogo({ variant = "lockup", label }: { variant?: keyof typeof ART; label: string }) {
  const art = ART[variant];
  return (
    <span aria-hidden={label ? undefined : true} className={`opentag-logo opentag-logo--${variant}`}>
      <img alt="" className="opentag-logo__light" height={art.height} src={art.light} width={art.width} />
      <img alt="" className="opentag-logo__dark" height={art.height} src={art.dark} width={art.width} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
