// ============================================================================
// DragManager — Block drag-and-drop reordering
//
// Uses pointer events (not HTML5 drag) for smoother UX. Creates a ghost
// element during drag and shows a drop indicator between blocks.
// ============================================================================

import type { BlockRegistry } from './BlockRegistry';

export interface DragCallbacks {
  onReorder: (blockId: string, newIndex: number) => void;
}

interface DragState {
  blockId: string;
  ghost: HTMLElement;
  startY: number;
  startX: number;
  indicator: HTMLElement;
  originalRect: DOMRect;
}

export class DragManager {
  private container: HTMLElement;
  private registry: BlockRegistry;
  private callbacks: DragCallbacks;
  private state: DragState | null = null;
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;

  constructor(container: HTMLElement, registry: BlockRegistry, callbacks: DragCallbacks) {
    this.container = container;
    this.registry = registry;
    this.callbacks = callbacks;
    this.boundMove = this.onPointerMove.bind(this);
    this.boundUp = this.onPointerUp.bind(this);
  }

  /** Call from BlockRenderer when creating block elements to attach handle */
  attachHandle(blockEl: HTMLElement, blockId: string): void {
    const handle = document.createElement('div');
    handle.className = 'block-drag-handle';
    handle.innerHTML = '&#x2630;'; // hamburger icon ☰
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startDrag(blockId, e);
    });
    blockEl.appendChild(handle);
  }

  destroy(): void {
    this.cancelDrag();
  }

  // --- Drag Lifecycle ---

  private startDrag(blockId: string, e: PointerEvent): void {
    const node = this.registry.get(blockId);
    if (!node) return;

    const rect = node.element.getBoundingClientRect();

    // Create ghost (semi-transparent clone)
    const ghost = node.element.cloneNode(true) as HTMLElement;
    ghost.classList.add('block-drag-ghost');
    ghost.style.position = 'fixed';
    ghost.style.top = `${rect.top}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.opacity = '0.6';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '10000';
    ghost.style.transition = 'none';
    document.body.appendChild(ghost);

    // Create drop indicator
    const indicator = document.createElement('div');
    indicator.className = 'block-drop-indicator';
    indicator.style.display = 'none';
    this.container.appendChild(indicator);

    // Dim the original
    node.element.style.opacity = '0.3';

    this.state = {
      blockId,
      ghost,
      startY: e.clientY,
      startX: e.clientX,
      indicator,
      originalRect: rect,
    };

    document.addEventListener('pointermove', this.boundMove);
    document.addEventListener('pointerup', this.boundUp);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.state) return;

    const { ghost, startY, startX, originalRect, indicator } = this.state;

    // Move ghost
    const dy = e.clientY - startY;
    const dx = e.clientX - startX;
    ghost.style.top = `${originalRect.top + dy}px`;
    ghost.style.left = `${originalRect.left + dx}px`;

    // Find drop position
    const dropIndex = this.findDropIndex(e.clientY);
    this.showIndicator(indicator, dropIndex);
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.state) return;

    const { blockId, ghost, indicator } = this.state;

    // Restore original
    const node = this.registry.get(blockId);
    if (node) node.element.style.opacity = '';

    // Find final drop position
    const dropIndex = this.findDropIndex(e.clientY);
    const currentIndex = this.registry.getRootIndex(blockId);

    // Cleanup
    ghost.remove();
    indicator.remove();
    document.removeEventListener('pointermove', this.boundMove);
    document.removeEventListener('pointerup', this.boundUp);
    this.state = null;

    // Fire reorder if position changed
    if (dropIndex !== -1 && dropIndex !== currentIndex && dropIndex !== currentIndex + 1) {
      const finalIndex = dropIndex > currentIndex ? dropIndex - 1 : dropIndex;
      this.callbacks.onReorder(blockId, finalIndex);
    }
  }

  private cancelDrag(): void {
    if (!this.state) return;
    const { blockId, ghost, indicator } = this.state;
    const node = this.registry.get(blockId);
    if (node) node.element.style.opacity = '';
    ghost.remove();
    indicator.remove();
    document.removeEventListener('pointermove', this.boundMove);
    document.removeEventListener('pointerup', this.boundUp);
    this.state = null;
  }

  // --- Position Calculation ---

  /** Find which gap the pointer is closest to. Returns the index to insert before. */
  private findDropIndex(clientY: number): number {
    const rootBlocks = this.registry.getRootBlocks();
    if (rootBlocks.length === 0) return 0;

    for (let i = 0; i < rootBlocks.length; i++) {
      const rect = rootBlocks[i].element.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return i;
    }

    return rootBlocks.length;
  }

  /** Position the drop indicator at the gap before the given index */
  private showIndicator(indicator: HTMLElement, index: number): void {
    const rootBlocks = this.registry.getRootBlocks();
    if (rootBlocks.length === 0) {
      indicator.style.display = 'none';
      return;
    }

    indicator.style.display = 'block';

    if (index >= rootBlocks.length) {
      // After last block
      const lastEl = rootBlocks[rootBlocks.length - 1].element;
      const rect = lastEl.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      indicator.style.top = `${rect.bottom - containerRect.top + 1}px`;
    } else {
      // Before block at index
      const el = rootBlocks[index].element;
      const rect = el.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      indicator.style.top = `${rect.top - containerRect.top - 1}px`;
    }

    indicator.style.position = 'absolute';
    indicator.style.left = '0';
    indicator.style.right = '0';
  }
}
