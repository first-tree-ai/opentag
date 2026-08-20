import type { ReactNode } from "react";

export function Notice({
  children,
  inline = false,
  tone = "default",
}: {
  children: ReactNode;
  inline?: boolean;
  tone?: "default" | "error";
}) {
  const className = tone === "error" ? "notice error" : "notice";
  if (inline) return <span className={className}>{children}</span>;
  return (
    <div className={className} role={tone === "error" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return <p role="status">{children}</p>;
}
