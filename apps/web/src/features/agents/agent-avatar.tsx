import { useState } from "react";
import { initials } from "../../i18n/format.js";

export function AgentAvatar({
  displayName,
  avatarPath,
  className = "size-10",
  "data-ui": dataUi,
}: {
  displayName: string;
  avatarPath?: string | null;
  className?: string;
  "data-ui"?: string;
}) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-kumo-tint font-semibold ${className}`}
      data-ui={dataUi}
    >
      {avatarPath && failedPath !== avatarPath ? (
        <img
          alt=""
          className="size-full object-cover"
          src={avatarPath}
          referrerPolicy="no-referrer"
          onError={() => setFailedPath(avatarPath)}
        />
      ) : (
        initials(displayName.replaceAll("-", " "))
      )}
    </span>
  );
}
