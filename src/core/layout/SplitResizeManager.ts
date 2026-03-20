// ============================================================================
// SplitResizeManager — Drag split borders to resize BSP cells
//
// Listens on .bsp-resize-handle elements. On drag, calculates the new ratio
// from mouse position relative to the parent split container.
// ============================================================================

export interface SplitResizeCallbacks {
  /** Called continuously during drag with the new ratio */
  onResize: (splitId: string, newRatio: number) => void;
  /** Called once when drag finishes with the final ratio */
  onResizeEnd: (splitId: string, finalRatio: number) => void;
}

export class SplitResizeManager {
  private container: HTMLElement;
  private callbacks: SplitResizeCallbacks;

  // Active drag state
  private dragging = false;
  private activeSplitId: string | null = null;
  private activeSplitEl: HTMLElement | null = null;
  private isVertical = false;

  // Bound handlers for cleanup
  private onPointerDown = this.handlePointerDown.bind(this);
  private onPointerMove = this.handlePointerMove.bind(this);
  private onPointerUp = this.handlePointerUp.bind(this);

  constructor(container: HTMLElement, callbacks: SplitResizeCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    // Delegate pointer events on the container
    this.container.addEventListener('pointerdown', this.onPointerDown);
  }

  destroy(): void {
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
  }

  private handlePointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('bsp-resize-handle')) return;

    e.preventDefault();
    e.stopPropagation();

    const splitId = target.dataset.splitId;
    if (!splitId) return;

    // Find the parent split container
    const splitEl = target.closest('.bsp-split') as HTMLElement;
    if (!splitEl) return;

    this.dragging = true;
    this.activeSplitId = splitId;
    this.activeSplitEl = splitEl;
    this.isVertical = splitEl.dataset.splitDirection === 'vertical';

    // Add visual feedback
    target.classList.add('bsp-resize-handle--active');
    document.body.style.cursor = this.isVertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    // Listen on document for move/up
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.dragging || !this.activeSplitEl || !this.activeSplitId) return;

    const ratio = this.calculateRatio(e);
    this.callbacks.onResize(this.activeSplitId, ratio);
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.dragging || !this.activeSplitEl || !this.activeSplitId) return;

    const ratio = this.calculateRatio(e);
    this.callbacks.onResizeEnd(this.activeSplitId, ratio);

    // Cleanup
    const handle = this.activeSplitEl.querySelector('.bsp-resize-handle--active');
    handle?.classList.remove('bsp-resize-handle--active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    this.dragging = false;
    this.activeSplitId = null;
    this.activeSplitEl = null;

    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
  }

  private calculateRatio(e: PointerEvent): number {
    if (!this.activeSplitEl) return 0.5;

    const rect = this.activeSplitEl.getBoundingClientRect();

    let ratio: number;
    if (this.isVertical) {
      ratio = (e.clientX - rect.left) / rect.width;
    } else {
      ratio = (e.clientY - rect.top) / rect.height;
    }

    // Clamp to prevent cells from becoming too small
    return Math.max(0.1, Math.min(0.9, ratio));
  }
}
