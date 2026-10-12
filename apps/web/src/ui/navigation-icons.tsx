import { IconBase, type IconProps, type IconWeight } from "@phosphor-icons/react";
import { forwardRef, type ReactElement } from "react";

// Match Phosphor's regular stroke at the smaller 24-unit viewBox.
const skillsWeights = new Map<IconWeight, ReactElement>([
  [
    "regular",
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="9" height="14" rx="1.5" />
      <rect x="3" y="12" width="14" height="9" rx="1.5" />
      <rect x="16" y="3" width="7" height="7" rx="1.5" />
    </g>,
  ],
]);

const connectorWeights = new Map<IconWeight, ReactElement>([
  [
    "regular",
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3v6m6-6v6M6 9h12v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9Zm6 9v4" />
    </g>,
  ],
]);

export const SkillsIcon = forwardRef<SVGSVGElement, IconProps>(function SkillsIcon(props, ref) {
  return <IconBase {...props} ref={ref} viewBox="0 0 24 24" weight="regular" weights={skillsWeights} />;
});

export const ConnectorIcon = forwardRef<SVGSVGElement, IconProps>(function ConnectorIcon(props, ref) {
  return <IconBase {...props} ref={ref} viewBox="0 0 24 24" weight="regular" weights={connectorWeights} />;
});
