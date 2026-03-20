// ============================================================================
// CellDragManager — Drag content between BSP cells
//
// Provides drag handles on cells. When a cell's drag handle is grabbed,
// the user can drop onto another cell:
//   - Center zone: swap content between cells
//   - Edge zones (top/bottom/left/right): split target cell and place content
//     in the new half
//
// Drop zone indicators are shown during drag to guide the user.
// ============================================================================

import type { SplitDirection } from './LayoutTree';

export type DropZone = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface CellDragCallbacks {
  /** Move content from one cell to another (swap or replace) */
  onMoveContent: (fromCellId: string, toCellId: string) => void;
  /** Split target cell and place dragged content in the new half */
  onSplitAndMove: (fromCellId: string, toCellId: string, direction: SplitDirection, insertFirst: boolean) => void;
}

export class CellDragManager {
  private container: HTMLElement;
  private callbacks: CellDragCallbacks;

  // Drag state
  private dragging = false;
  private sourceCellId: string | null = null;
  private ghostEl: HTMLElement | null = null;
  private dropIndicator: HTMLElement | null = null;
  private currentDropTarget: HTMLElement | null = null;
  private currentDropZone: DropZone | null = null;

  constructor(container: HTMLElement, callbacks: CellDragCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.attachDragHandles();
  }

  /** Scan the container for cells and attach drag handles */
  attachDragHandles(): void {
    const cells = this.container.querySelectorAll('.bsp-cell');
    for (const cell of cells) {
      const cellEl = cell as HTMLElement;
      // Only add handle if not already present
      if (cellEl.querySelector('.bsp-cell-drag-handle')) continue;

      const handle = document.createElement('div');
      handle.classList.add('bsp-cell-drag-handle');
      handle.innerHTML = '⠿'; // braille dots as drag icon
      handle.title = 'Drag to move content';

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = cellEl.dataset.cellId;
        if (id) this.startDrag(id, e);
      });

      cellEl.appendChild(handle);
    }
  }

  destroy(): void {
    this.endDrag();
    // Remove all drag handles
    const handles = this.container.querySelectorAll('.bsp-cell-drag-handle');
    for (const h of handles) h.remove();
  }

  // --- Drag Lifecycle ---

  private startDrag(cellId: string, e: PointerEvent): void {
    this.dragging = true;
    this.sourceCellId = cellId;

    // Create ghost element
    this.ghostEl = document.createElement('div');
    this.ghostEl.classList.add('bsp-drag-ghost');
    this.ghostEl.textContent = 'Moving cell content...';
    this.ghostEl.style.left = `${e.clientX + 10}px`;
    this.ghostEl.style.top = `${e.clientY + 10}px`;
    document.body.appendChild(this.ghostEl);

    // Create drop indicator (hidden initially)
    this.dropIndicator = document.createElement('div');
    this.dropIndicator.classList.add('bsp-drop-indicator');
    this.dropIndicator.style.display = 'none';
    document.body.appendChild(this.dropIndicator);

    // Add dragging class to source cell
    const sourceEl = this.container.querySelector(`[data-cell-id="${cellId}"]`) as HTMLElement;
    sourceEl?.classList.add('bsp-cell--dragging');

    // Set cursor
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;

    // Move ghost
    if (this.ghostEl) {
      this.ghostEl.style.left = `${e.clientX + 10}px`;
      this.ghostEl.style.top = `${e.clientY + 10}px`;
    }

    // Find which cell we're over
    const targetCell = this.findCellAt(e.clientX, e.clientY);

    if (targetCell && targetCell.dataset.cellId !== this.sourceCellId) {
      this.currentDropTarget = targetCell;
      const zone = this.calculateDropZone(targetCell, e.clientX, e.clientY);
      this.currentDropZone = zone;
      this.showDropIndicator(targetCell, zone);
    } else {
      this.currentDropTarget = null;
      this.currentDropZone = null;
      this.hideDropIndicator();
    }
  };

  private onPointerUp = (_e: PointerEvent): void => {
    if (!this.dragging) return;

    if (this.currentDropTarget && this.currentDropZone && this.sourceCellId) {
      const targetId = this.currentDropTarget.dataset.cellId!;
      this.executeDrop(this.sourceCellId, targetId, this.currentDropZone);
    }

    this.endDrag();
  };

  private endDrag(): void {
    this.dragging = false;

    // Remove ghost
    this.ghostEl?.remove();
    this.ghostEl = null;

    // Remove drop indicator
    this.dropIndicator?.remove();
    this.dropIndicator = null;

    // Remove dragging class
    if (this.sourceCellId) {
      const sourceEl = this.container.querySelector(`[data-cell-id="${this.sourceCellId}"]`) as HTMLElement;
      sourceEl?.classList.remove('bsp-cell--dragging');
    }

    this.sourceCellId = null;
    this.currentDropTarget = null;
    this.currentDropZone = null;

    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
  }

  // --- Drop Zone Calculation ---

  private findCellAt(x: number, y: number): HTMLElement | null {
    const cells = this.container.querySelectorAll('.bsp-cell');
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return cell as HTMLElement;
      }
    }
    return null;
  }

  private calculateDropZone(cell: HTMLElement, x: number, y: number): DropZone {
    const rect = cell.getBoundingClientRect();
    const edgeThreshold = 0.25; // 25% from each edge triggers split

    const relX = (x - rect.left) / rect.width;
    const relY = (y - rect.top) / rect.height;

    // Check edges first (split zones)
    if (relY < edgeThreshold) return 'top';
    if (relY > 1 - edgeThreshold) return 'bottom';
    if (relX < edgeThreshold) return 'left';
    if (relX > 1 - edgeThreshold) return 'right';

    // Center zone (swap/move)
    return 'center';
  }

  private showDropIndicator(cell: HTMLElement, zone: DropZone): void {
    if (!this.dropIndicator) return;

    const rect = cell.getBoundingClientRect();
    this.dropIndicator.style.display = 'block';
    this.dropIndicator.className = `bsp-drop-indicator bsp-drop-indicator--${zone}`;

    switch (zone) {
      case 'center':
        this.dropIndicator.style.left = `${rect.left}px`;
        this.dropIndicator.style.top = `${rect.top}px`;
        this.dropIndicator.style.width = `${rect.width}px`;
        this.dropIndicator.style.height = `${rect.height}px`;
        break;
      case 'top':
        this.dropIndicator.style.left = `${rect.left}px`;
        this.dropIndicator.style.top = `${rect.top}px`;
        this.dropIndicator.style.width = `${rect.width}px`;
        this.dropIndicator.style.height = `${rect.height * 0.5}px`;
        break;
      case 'bottom':
        this.dropIndicator.style.left = `${rect.left}px`;
        this.dropIndicator.style.top = `${rect.top + rect.height * 0.5}px`;
        this.dropIndicator.style.width = `${rect.width}px`;
        this.dropIndicator.style.height = `${rect.height * 0.5}px`;
        break;
      case 'left':
        this.dropIndicator.style.left = `${rect.left}px`;
        this.dropIndicator.style.top = `${rect.top}px`;
        this.dropIndicator.style.width = `${rect.width * 0.5}px`;
        this.dropIndicator.style.height = `${rect.height}px`;
        break;
      case 'right':
        this.dropIndicator.style.left = `${rect.left + rect.width * 0.5}px`;
        this.dropIndicator.style.top = `${rect.top}px`;
        this.dropIndicator.style.width = `${rect.width * 0.5}px`;
        this.dropIndicator.style.height = `${rect.height}px`;
        break;
    }
  }

  private hideDropIndicator(): void {
    if (this.dropIndicator) {
      this.dropIndicator.style.display = 'none';
    }
  }

  // --- Execute Drop ---

  private executeDrop(fromCellId: string, toCellId: string, zone: DropZone): void {
    switch (zone) {
      case 'center':
        this.callbacks.onMoveContent(fromCellId, toCellId);
        break;
      case 'top':
        this.callbacks.onSplitAndMove(fromCellId, toCellId, 'horizontal', true);
        break;
      case 'bottom':
        this.callbacks.onSplitAndMove(fromCellId, toCellId, 'horizontal', false);
        break;
      case 'left':
        this.callbacks.onSplitAndMove(fromCellId, toCellId, 'vertical', true);
        break;
      case 'right':
        this.callbacks.onSplitAndMove(fromCellId, toCellId, 'vertical', false);
        break;
    }
  }
}
