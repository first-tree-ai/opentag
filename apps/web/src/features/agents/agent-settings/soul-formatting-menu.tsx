import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { type RefObject, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { Icon, type IconName, Toolbar } from "../../../ui/design-system.js";

export const soulFormattingMenuKey = "soulFormatting";

export function SoulFormattingMenu({
  disabled,
  editor,
  menuRef,
  requested,
  dismissed,
  onDismiss,
}: {
  disabled: boolean;
  editor: Editor;
  menuRef: RefObject<HTMLDivElement | null>;
  requested: boolean;
  dismissed: boolean;
  onDismiss: () => void;
}) {
  const [attached, setAttached] = useState(false);
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      heading: current.isActive("heading", { level: 2 }),
      bullet: current.isActive("bulletList"),
    }),
  });
  const actions: { label: string; icon: IconName; active: boolean; run: () => void }[] = [
    {
      label: m.agent_settings_soul_format_heading(),
      icon: "text-heading",
      active: active.heading,
      run: () => {
        editor.chain().focus().toggleHeading({ level: 2 }).run();
      },
    },
    {
      label: m.agent_settings_soul_format_bold(),
      icon: "text-bold",
      active: active.bold,
      run: () => {
        editor.chain().focus().toggleBold().run();
      },
    },
    {
      label: m.agent_settings_soul_format_bullets(),
      icon: "list-bullets",
      active: active.bullet,
      run: () => {
        editor.chain().focus().toggleBulletList().run();
      },
    },
  ];
  return (
    <BubbleMenu
      pluginKey={soulFormattingMenuKey}
      editor={editor}
      ref={menuRef}
      className="max-w-[calc(100vw-1.5rem)]"
      updateDelay={0}
      options={{
        scrollTarget: editor.view.dom,
        placement: "top",
        offset: 8,
        shift: { padding: 12 },
        flip: { padding: 12 },
        onShow: () => {
          // Kumo registers only connected controls; Tiptap attaches this portal on its first show.
          setAttached(true);
          if (requested)
            requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
        },
      }}
      shouldShow={({ editor: current, view, state }) =>
        !disabled &&
        !dismissed &&
        current.isEditable &&
        (view.hasFocus() || !!menuRef.current?.contains(document.activeElement)) &&
        (requested || (!state.selection.empty && !!state.doc.textBetween(state.selection.from, state.selection.to)))
      }
    >
      <Toolbar
        key={String(attached)}
        aria-label={m.agent_settings_soul_format_toolbar()}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
          }
        }}
      >
        {actions.map((action) => (
          <Toolbar.Button
            key={action.icon}
            aria-label={action.label}
            aria-pressed={action.active}
            disabled={disabled}
            className="aria-pressed:bg-(--brand-soft) aria-pressed:text-kumo-brand"
            shape="square"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!disabled && editor.isEditable) action.run();
            }}
          >
            <Icon name={action.icon} />
          </Toolbar.Button>
        ))}
      </Toolbar>
    </BubbleMenu>
  );
}
