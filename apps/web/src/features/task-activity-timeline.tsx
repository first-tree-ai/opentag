import { Component, createRef, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  oldestDeliveryId?: string;
};

type ScrollAnchor = { element: HTMLElement; top: number; viewport: Element };

/** Keeps the visible exchange in place when earlier private-chat activity is prepended. */
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
    const exchanges = [...timeline.querySelectorAll<HTMLElement>('[data-ui="task-exchange"]')];
    const element = exchanges.find((exchange) => {
      const bounds = exchange.getBoundingClientRect();
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
