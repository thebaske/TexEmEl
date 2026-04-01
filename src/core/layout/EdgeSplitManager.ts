// ============================================================================
// EdgeSplitManager — Pull from cell edges to auto-split
//
// When the user drags from the edge of a cell, the cell automatically splits
// in the appropriate direction. The cursor changes near edges to hint at this.
//
// - Drag from top/bottom edge → horizontal split
// - Drag from left/right edge → vertical split
//
// No icons, no drag handles. Just cursor changes and edge zones.
// ============================================================================

import type { SplitDirection } from './LayoutTree';

export interface EdgeSplitCallbacks {
  /** Called when user drags from a cell edge to create a split.
   *  reversed=true when dragging from top/left (new space appears on that side). */
  onEdgeSplit: (cellId: string, direction: SplitDirection, ratio: number, reversed: boolean) => void;
}

type Edge = 'top' | 'bottom' | 'left' | 'right';

const EDGE_THRESHOLD = 12; // pixels from edge to trigger
const MIN_DRAG_DISTANCE = 16; // minimum drag distance to confirm split

export class EdgeSplitManager {
  private container: HTMLElement;
  private callbacks: EdgeSplitCallbacks;

  // Drag state
  private dragging = false;
  private sourceCell: HTMLElement | null = null;
  private sourceCellId: string | null = null;
  private dragEdge: Edge | null = null;
  private startX = 0;
  private startY = 0;
  private previewEl: HTMLElement | null = null;

  // Bound handlers
  private onPointerDown = this.handlePointerDown.bind(this);
  private onPointerMove = this.handlePointerMove.bind(this);
  private onPointerUp = this.handlePointerUp.bind(this);

  constructor(container: HTMLElement, callbacks: EdgeSplitCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.addEventListener('pointerdown', this.onPointerDown);
  }

  destroy(): void {
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    this.previewEl?.remove();
  }

  private handlePointerDown(e: PointerEvent): void {
    // Don't interfere with resize handles or context menus
    const target = e.target as HTMLElement;
    if (target.classList.contains('bsp-resize-handle')) return;
    if (target.closest('.bsp-context-menu')) return;

    // Find which cell and which edge
    const cellEl = target.closest('.bsp-cell') as HTMLElement;
    if (!cellEl) return;

    const cellId = cellEl.dataset.cellId;
    if (!cellId) return;

    const edge = this.detectEdge(cellEl, e.clientX, e.clientY);
    if (!edge) return; // Not near an edge — let normal click/text editing happen

    e.preventDefault();
    e.stopPropagation();

    this.dragging = true;
    this.sourceCell = cellEl;
    this.sourceCellId = cellId;
    this.dragEdge = edge;
    this.startX = e.clientX;
    this.startY = e.clientY;

    document.body.style.userSelect = 'none';

    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.dragging || !this.sourceCell || !this.dragEdge) return;

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    const distance = this.isHorizontalEdge(this.dragEdge) ? Math.abs(dy) : Math.abs(dx);

    if (distance > MIN_DRAG_DISTANCE) {
      this.showSplitPreview(e);
    } else {
      this.hideSplitPreview();
    }
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.dragging || !this.sourceCell || !this.dragEdge || !this.sourceCellId) {
      this.endDrag();
      return;
    }

    const dx = e.clientX - this.startX;
    const dy = e.clientY - this.startY;
    const rect = this.sourceCell.getBoundingClientRect();

    const isHorizontal = this.isHorizontalEdge(this.dragEdge);
    const distance = isHorizontal ? Math.abs(dy) : Math.abs(dx);

    if (distance > MIN_DRAG_DISTANCE) {
      let ratio: number;
      const direction: SplitDirection = isHorizontal ? 'horizontal' : 'vertical';

      if (isHorizontal) {
        // relY = where the pointer is relative to the cell (0=top, 1=bottom)
        const relY = (e.clientY - rect.top) / rect.height;
        if (this.dragEdge === 'top') {
          // Dragging from top: empty space on top = first child gets relY fraction
          ratio = Math.max(0.1, Math.min(0.9, relY));
        } else {
          // Dragging from bottom: empty space on bottom = first child gets relY fraction
          ratio = Math.max(0.1, Math.min(0.9, relY));
        }
      } else {
        const relX = (e.clientX - rect.left) / rect.width;
        if (this.dragEdge === 'left') {
          // Dragging from left: empty space on left = first child gets relX fraction
          ratio = Math.max(0.1, Math.min(0.9, relX));
        } else {
          // Dragging from right: empty space on right = first child gets relX fraction
          ratio = Math.max(0.1, Math.min(0.9, relX));
        }
      }

      const reversed = this.dragEdge === 'top' || this.dragEdge === 'left';
      this.callbacks.onEdgeSplit(this.sourceCellId, direction, ratio, reversed);
    }

    this.endDrag();
  }

  private endDrag(): void {
    this.dragging = false;
    this.sourceCell = null;
    this.sourceCellId = null;
    this.dragEdge = null;
    this.hideSplitPreview();
    document.body.style.userSelect = '';
    document.body.style.cursor = '';

    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
  }

  /** Detect if pointer is near a cell edge — returns the CLOSEST edge */
  private detectEdge(cell: HTMLElement, x: number, y: number): Edge | null {
    const rect = cell.getBoundingClientRect();
    const fromTop = y - rect.top;
    const fromBottom = rect.bottom - y;
    const fromLeft = x - rect.left;
    const fromRight = rect.right - x;

    // Find the minimum distance to any edge
    const minDist = Math.min(fromTop, fromBottom, fromLeft, fromRight);

    // Only trigger if within the threshold
    if (minDist >= EDGE_THRESHOLD) return null;

    // Return the closest edge
    if (minDist === fromTop) return 'top';
    if (minDist === fromBottom) return 'bottom';
    if (minDist === fromLeft) return 'left';
    return 'right';
  }

  private isHorizontalEdge(edge: Edge): boolean {
    return edge === 'top' || edge === 'bottom';
  }

  private showSplitPreview(e: PointerEvent): void {
    if (!this.sourceCell || !this.dragEdge) return;

    if (!this.previewEl) {
      this.previewEl = document.createElement('div');
      this.previewEl.classList.add('bsp-split-preview');
      this.sourceCell.appendChild(this.previewEl);
    }

    const rect = this.sourceCell.getBoundingClientRect();
    const isHorizontal = this.isHorizontalEdge(this.dragEdge);

    if (isHorizontal) {
      this.previewEl.className = 'bsp-split-preview bsp-split-preview--horizontal';
      const relY = Math.max(0.1, Math.min(0.9, (e.clientY - rect.top) / rect.height));
      this.previewEl.style.top = `${relY * 100}%`;
      document.body.style.cursor = 'row-resize';
    } else {
      this.previewEl.className = 'bsp-split-preview bsp-split-preview--vertical';
      const relX = Math.max(0.1, Math.min(0.9, (e.clientX - rect.left) / rect.width));
      this.previewEl.style.left = `${relX * 100}%`;
      document.body.style.cursor = 'col-resize';
    }
  }

  private hideSplitPreview(): void {
    this.previewEl?.remove();
    this.previewEl = null;
  }
}
