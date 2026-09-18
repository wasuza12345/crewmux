import { newId, type HarnessEvent, type HarnessEventType, type NewHarnessEvent } from "../protocol/index.js";

type Listener<E extends HarnessEvent = HarnessEvent> = (event: E) => void;
export type EventSink = (event: HarnessEvent) => void;

/**
 * Single source of truth for "what happened". Sinks (SQLite, log file) see every
 * event before listeners (TUI) so a crash never loses an event the UI already showed.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly sinks: EventSink[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  publish(partial: NewHarnessEvent): HarnessEvent {
    const event = { ...partial, id: newId("e"), ts: this.now() } as HarnessEvent;
    for (const sink of this.sinks) sink(event);
    for (const l of this.listeners) l(event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  on<T extends HarnessEventType>(type: T, listener: Listener<Extract<HarnessEvent, { type: T }>>): () => void {
    return this.subscribe((e) => {
      if (e.type === type) listener(e as Extract<HarnessEvent, { type: T }>);
    });
  }
}
