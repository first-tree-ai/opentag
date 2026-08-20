import type { ComponentProps } from "react";

export function FormCard({ children, ...props }: ComponentProps<"form">) {
  return (
    <form className="form-card" {...props}>
      {children}
    </form>
  );
}
