import { useState } from "react";
import { initials } from "../../i18n/format.js";

export function AgentAvatar({
  displayName,
  avatarUrl,
  className = "size-10",
  "data-ui": dataUi,
}: {
  displayName: string;
  avatarUrl?: string | null;
  className?: string;
  "data-ui"?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-kumo-tint font-semibold ${className}`}
      data-ui={dataUi}
    >
      {avatarUrl && failedUrl !== avatarUrl ? (
        <img
          alt=""
          className="size-full object-cover"
          src={avatarUrl}
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        initials(displayName.replaceAll("-", " "))
      )}
    </span>
  );
}
