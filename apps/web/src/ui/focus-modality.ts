/** Native focus-visible also matches pointer-focused text fields; keep their pointer contour light. */
export function installFocusModality(document: Document): () => void {
  const root = document.documentElement;
  const attribute = "data-opentag-input-modality";
  const previous = root.getAttribute(attribute);
  root.setAttribute(attribute, "keyboard");
  const pointer = () => root.setAttribute(attribute, "pointer");
  const keyboard = (event: KeyboardEvent) => {
    // Typing in a pointer-focused editor does not change its focus treatment.
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      root.setAttribute(attribute, "keyboard");
    }
  };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", keyboard, true);
  return () => {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", keyboard, true);
    if (previous === null) root.removeAttribute(attribute);
    else root.setAttribute(attribute, previous);
  };
}
