// ============================================================================
// EventRouter — Delegated event handling for the editor
//
// Single set of listeners on the editor container. Routes events to
// the correct subsystem based on data-block-id resolution. Coexists
// with ProseMirror's internal event handling.
// ============================================================================

import type { BlockNode } from './BlockNode';
import type { BlockRegistry } from './BlockRegistry';
import { EngineEvent, type BlockClickPayload, type BlockHoverPayload, type KeyDownPayload, type PastePayload } from './types';

type EventHandler = (payload: any) => void;
type RawMouseHandler = (e: MouseEvent) => void;
type RawPointerHandler = (e: PointerEvent) => void;

export class EventRouter {
  private container: HTMLElement;
  private registry: BlockRegistry;
  private handlers = new Map<EngineEvent, EventHandler[]>();
  private lastHoveredId: string | null = null;
  private rawMouseMoveHandlers: RawMouseHandler[] = [];
  private rawPointerDownHandlers: RawPointerHandler[] = [];

  // Bound handlers for cleanup
  private boundHandlers: { event: string; handler: EventListener }[] = [];

  constructor(container: HTMLElement, registry: BlockRegistry) {
    this.container = container;
    this.registry = registry;
    this.attachListeners();
  }

  // --- Public API ---

  on(event: EngineEvent, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  off(event: EngineEvent, handler: EventHandler): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Register raw mousemove handler (for edge drag detection) */
  onRawMouseMove(handler: RawMouseHandler): void {
    this.rawMouseMoveHandlers.push(handler);
  }

  /** Register raw pointerdown handler (for edge drag initiation) */
  onRawPointerDown(handler: RawPointerHandler): void {
    this.rawPointerDownHandlers.push(handler);
  }

  destroy(): void {
    for (const { event, handler } of this.boundHandlers) {
      this.container.removeEventListener(event, handler);
    }
    this.boundHandlers = [];
    this.handlers.clear();
  }

  // --- Event Attachment ---

  private attachListeners(): void {
    this.listen('click', this.onClick);
    this.listen('dblclick', this.onDblClick);
    this.listen('mousemove', this.onMouseMove);
    this.listen('mouseleave', this.onMouseLeave);
    this.listen('keydown', this.onKeyDown);
    this.listen('paste', this.onPaste);
    this.listen('pointerdown', this.onPointerDown);
    this.listen('contextmenu', this.onContextMenu);
  }

  private listen(event: string, handler: (e: Event) => void): void {
    const bound = handler.bind(this) as EventListener;
    this.container.addEventListener(event, bound);
    this.boundHandlers.push({ event, handler: bound });
  }

  // --- Event Handlers ---

  private onClick(e: Event): void {
    const me = e as MouseEvent;
    const block = this.resolveBlock(me);

    const payload: BlockClickPayload = {
      blockId: block?.id ?? null,
      shiftKey: me.shiftKey,
      metaKey: me.metaKey,
      ctrlKey: me.ctrlKey,
    };

    this.emit(EngineEvent.BlockClick, payload);
  }

  private onDblClick(e: Event): void {
    const me = e as MouseEvent;
    const block = this.resolveBlock(me);
    if (!block) return;

    const payload: BlockClickPayload = {
      blockId: block.id,
      shiftKey: me.shiftKey,
      metaKey: me.metaKey,
      ctrlKey: me.ctrlKey,
    };

    this.emit(EngineEvent.BlockDoubleClick, payload);
  }

  private onMouseMove(e: Event): void {
    const me = e as MouseEvent;
    const block = this.resolveBlock(me);
    const newId = block?.id ?? null;

    if (newId !== this.lastHoveredId) {
      // Leave old
      if (this.lastHoveredId) {
        const oldNode = this.registry.get(this.lastHoveredId);
        if (oldNode) {
          oldNode.element.classList.remove('block-hovered');
        }
        this.emit(EngineEvent.BlockHoverLeave, { blockId: this.lastHoveredId } as BlockHoverPayload);
      }

      // Enter new
      if (newId) {
        const newNode = this.registry.get(newId);
        if (newNode) {
          newNode.element.classList.add('block-hovered');
        }
        this.emit(EngineEvent.BlockHoverEnter, { blockId: newId } as BlockHoverPayload);
      }

      this.lastHoveredId = newId;
    }

    // Pipe raw mousemove to registered handlers (edge drag detection)
    for (const handler of this.rawMouseMoveHandlers) {
      handler(me);
    }
  }

  private onPointerDown(e: Event): void {
    const pe = e as PointerEvent;
    for (const handler of this.rawPointerDownHandlers) {
      handler(pe);
    }
  }

  private onMouseLeave(_e: Event): void {
    if (this.lastHoveredId) {
      const node = this.registry.get(this.lastHoveredId);
      if (node) {
        node.element.classList.remove('block-hovered');
      }
      this.emit(EngineEvent.BlockHoverLeave, { blockId: this.lastHoveredId } as BlockHoverPayload);
      this.lastHoveredId = null;
    }
  }

  private onKeyDown(e: Event): void {
    const ke = e as KeyboardEvent;
    const block = this.resolveBlock(ke);

    const payload: KeyDownPayload = {
      blockId: block?.id ?? null,
      event: ke,
    };

    this.emit(EngineEvent.KeyDown, payload);
  }

  private onPaste(e: Event): void {
    const ce = e as ClipboardEvent;
    const block = this.resolveBlock(ce);

    const payload: PastePayload = {
      blockId: block?.id ?? null,
      event: ce,
    };

    this.emit(EngineEvent.Paste, payload);
  }

  private onContextMenu(e: Event): void {
    const me = e as MouseEvent;
    const block = this.resolveBlock(me);

    this.emit(EngineEvent.ContextMenu, {
      blockId: block?.id ?? null,
      event: me,
    });
  }

  // --- Helpers ---

  private resolveBlock(e: Event): BlockNode | null {
    const target = e.target as HTMLElement;
    if (!target) return null;
    return this.registry.findByElement(target);
  }

  private emit(event: EngineEvent, payload: any): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const handler of list) {
      handler(payload);
    }
  }
}
