import { useState } from "react";
import { Icon } from "../../ui/design-system.js";

/** Decorative service identity with a stable footprint even when a bundled image fails. */
export function McpServiceIcon({ src, size = 32 }: { src?: string; size?: 24 | 32 }) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return (
    <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {src && src !== failedSrc ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          className="size-full object-contain"
          onError={() => setFailedSrc(src)}
          onLoad={() => setFailedSrc(undefined)}
        />
      ) : (
        <Icon name="integrations" className="size-full text-kumo-subtle" />
      )}
    </span>
  );
}
