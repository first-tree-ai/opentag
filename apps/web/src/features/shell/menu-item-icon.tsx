import { Icon, type IconName } from "../../ui/design-system.js";

/** Match the Agent avatar column while keeping each glyph at the standard 16px size. */
export function MenuItemIcon({ name }: { name: IconName }) {
  return (
    <span className="mr-2 grid size-6 shrink-0 place-items-center text-kumo-subtle" aria-hidden="true">
      <Icon name={name} />
    </span>
  );
}
