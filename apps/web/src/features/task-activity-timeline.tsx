import { Component, createRef, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  entryIds: readonly string[];
};

type ScrollAnchor = { element: HTMLElement; top: number; viewport: Element };

/** Keeps the visible message in place as history and late reports arrive. */
export class TaskActivityTimeline extends Component<Props, object, ScrollAnchor | null> {
  private readonly timeline = createRef<HTMLDivElement>();

  override getSnapshotBeforeUpdate(): ScrollAnchor | null {
    const timeline = this.timeline.current;
    const viewport = timeline?.closest('[data-ui="content"]') ?? document.scrollingElement;
    if (!timeline || !viewport) return null;
    const viewportTop = viewport === document.scrollingElement ? 0 : viewport.getBoundingClientRect().top;
    const viewportBottom =
      viewport === document.scrollingElement ? window.innerHeight : viewport.getBoundingClientRect().bottom;
    // Anchor surviving content, including insertions in the middle of the loaded conversation.
    const survivingIds = new Set(this.props.entryIds);
    const messages = [...timeline.querySelectorAll<HTMLElement>("[data-task-entry-id]")];
    const element = messages.find((message) => {
      const bounds = message.getBoundingClientRect();
      return (
        survivingIds.has(message.dataset.taskEntryId ?? "") &&
        bounds.bottom > viewportTop &&
        bounds.top < viewportBottom
      );
    });
    return element ? { element, top: element.getBoundingClientRect().top, viewport } : null;
  }

  override componentDidUpdate(_previous: Props, _state: object, anchor: ScrollAnchor | null) {
    if (!anchor?.element.isConnected) return;
    // Measure immediately around the DOM update, so scrolling during the request and browser
    // scroll anchoring are already reflected in the adjustment. Removed controls count too.
    anchor.viewport.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
  }

  override render() {
    return (
      <div ref={this.timeline} className="grid gap-5">
        {this.props.children}
      </div>
    );
  }
}
