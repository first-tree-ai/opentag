import { Component, createRef, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  oldestDeliveryId?: string;
};

type ScrollAnchor = { element: HTMLElement; top: number; viewport: Element };

/** Keeps the visible message in place when earlier Task activity is prepended. */
export class TaskActivityTimeline extends Component<Props, object, ScrollAnchor | null> {
  private readonly timeline = createRef<HTMLDivElement>();

  override getSnapshotBeforeUpdate(previous: Props): ScrollAnchor | null {
    if (!previous.oldestDeliveryId || previous.oldestDeliveryId === this.props.oldestDeliveryId) return null;
    const timeline = this.timeline.current;
    const viewport = timeline?.closest('[data-ui="content"]') ?? document.scrollingElement;
    if (!timeline || !viewport) return null;
    const viewportTop = viewport === document.scrollingElement ? 0 : viewport.getBoundingClientRect().top;
    const viewportBottom =
      viewport === document.scrollingElement ? window.innerHeight : viewport.getBoundingClientRect().bottom;
    // Anchor message content: the previous first exchange gains top padding after a prepend.
    const messages = [
      ...timeline.querySelectorAll<HTMLElement>('[data-ui="task-message-request"], [data-ui="task-message-agent"]'),
    ];
    const element = messages.find((message) => {
      const bounds = message.getBoundingClientRect();
      return bounds.bottom > viewportTop && bounds.top < viewportBottom;
    });
    return element ? { element, top: element.getBoundingClientRect().top, viewport } : null;
  }

  override componentDidUpdate(_previous: Props, _state: object, anchor: ScrollAnchor | null) {
    if (!anchor?.element.isConnected || !this.props.oldestDeliveryId) return;
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
