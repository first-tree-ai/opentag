import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { type RefObject, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as m from "../../../paraglide/messages.js";
import { SoulFormattingMenu, soulFormattingMenuKey } from "./soul-formatting-menu.js";
import { serializeSoul, soulEditorExtensions } from "./soul-markdown.js";
import { useSoulEditorHeight } from "./use-soul-editor-height.js";
import "./soul-document.css";

export function SoulEditor({
  disabled,
  footerRef,
  id,
  inputRef,
  onValueChange,
  value,
}: {
  disabled: boolean;
  footerRef: RefObject<HTMLDivElement | null>;
  id: string;
  inputRef?: RefObject<HTMLElement | null>;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const baseline = useRef({ source: value, document: "", emitted: value });
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [menuRequested, setMenuRequested] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<Editor | null>(null);
  const extensions = useMemo(soulEditorExtensions, []);
  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    editable: !disabled,
    injectCSS: false,
    editorProps: {
      attributes: ({ doc }) => ({
        class: "soul-editor soul-document",
        id,
        role: "textbox",
        tabindex: disabled ? "-1" : "0",
        "aria-multiline": "true",
        "aria-label": m.agent_settings_instructions_title(),
        "aria-describedby": `${id}-help`,
        "aria-disabled": String(disabled),
        "data-placeholder": m.agent_settings_soul_editor_placeholder(),
        "data-empty": String(
          doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.content.size === 0,
        ),
      }),
      handleKeyDown: (view, event) => {
        if (event.altKey && event.key === "F10") {
          event.preventDefault();
          setMenuRequested(true);
          setMenuDismissed(false);
          view.dispatch(view.state.tr.setMeta(soulFormattingMenuKey, "show"));
          requestAnimationFrame(() => {
            view.dispatch(view.state.tr.setMeta(soulFormattingMenuKey, "updatePosition"));
            menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
          });
          return true;
        }
        if (event.key === "Escape") {
          setMenuRequested(false);
          setMenuDismissed(true);
          view.dispatch(view.state.tr.setMeta(soulFormattingMenuKey, "hide"));
          view.focus();
        }
        return false;
      },
      handlePaste: (view, event) => {
        const source = event.clipboardData?.getData("text/plain");
        if (!source || !instanceRef.current) return false;
        const { $from } = view.state.selection;
        const marks = view.state.storedMarks ?? $from.marks();
        if ($from.parent.type.spec.code || marks.some((mark) => mark.type.spec.code)) {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(source));
          return true;
        }
        if (event.clipboardData?.getData("text/html")) return false;
        instanceRef.current.commands.insertContent(source, { contentType: "markdown" });
        return true;
      },
    },
    onSelectionUpdate: () => setMenuDismissed(false),
    onUpdate: ({ editor: current }) => {
      const document = JSON.stringify(current.getJSON());
      const next = current.isEmpty
        ? ""
        : document === baseline.current.document
          ? baseline.current.source
          : serializeSoul(current);
      baseline.current.emitted = next;
      onValueChange(next);
    },
  });

  useLayoutEffect(() => {
    if (!editor) return;
    const element = editor.view.dom;
    setRoot(element);
    if (inputRef) inputRef.current = element;
    baseline.current.document = JSON.stringify(editor.getJSON());
    instanceRef.current = editor;
    return () => {
      instanceRef.current = null;
      if (inputRef) inputRef.current = null;
    };
  }, [editor, inputRef]);

  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled, false);
    if (value === baseline.current.emitted) return;
    editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    // A template replacement or explicit Discard starts a new document, including its undo history.
    editor.view.updateState(
      EditorState.create({ schema: editor.schema, doc: editor.state.doc, plugins: editor.state.plugins }),
    );
    baseline.current = { source: value, emitted: value, document: JSON.stringify(editor.getJSON()) };
  }, [disabled, editor, value]);
  useSoulEditorHeight(value, root, footerRef);

  return (
    <div className="relative" data-ui="soul-document">
      <EditorContent editor={editor} />
      <input name="instructions" type="hidden" value={value} />
      {editor ? (
        <SoulFormattingMenu
          disabled={disabled}
          editor={editor}
          menuRef={menuRef}
          requested={menuRequested}
          dismissed={menuDismissed}
          onDismiss={() => {
            setMenuRequested(false);
            setMenuDismissed(true);
            editor.commands.setMeta(soulFormattingMenuKey, "hide");
            editor.commands.focus();
          }}
        />
      ) : null}
      <p className="sr-only" id={`${id}-help`}>
        {m.agent_settings_soul_editor_help()} {m.agent_settings_soul_format_shortcut()}
      </p>
    </div>
  );
}
