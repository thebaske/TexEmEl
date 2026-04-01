// ============================================================================
// NavigationController — Cross-cell keyboard navigation coordinator
//
// Maintains a flat sequence of cell IDs in reading order. When a cell's
// ProseMirror editor hits a boundary (cursor can't move further), this
// controller transfers focus to the adjacent cell.
//
// Within a cell, ProseMirror handles all navigation natively — paragraphs,
// headings, Enter, arrow keys, goal column. This controller only handles
// the cross-cell boundary case.
// ============================================================================

import type { NavigationHandler } from '../engine/types';
import type { CellPool } from './CellPool';
import type { Page } from './PageModel';
import { getAllLeaves } from './LayoutTree';

// --- Types ---

export type OnActiveCellChangeCallback = (cellId: string) => void;

export interface NavigationControllerConfig {
  onActiveCellChange?: OnActiveCellChangeCallback;
}

// --- NavigationController ---

export class NavigationController {
  private cellPool: CellPool;
  private config: NavigationControllerConfig;

  /** Flat sequence of cell IDs in reading order */
  private navSequence: string[] = [];

  constructor(cellPool: CellPool, config: NavigationControllerConfig = {}) {
    this.cellPool = cellPool;
    this.config = config;
  }

  // =====================
  //  SEQUENCE MANAGEMENT
  // =====================

  /**
   * Rebuild the navigation sequence from the current page/cell structure.
   * Called after any layout change (split, merge, page add/remove).
   */
  rebuildSequence(pages: Page[]): void {
    this.navSequence = [];

    for (const page of pages) {
      const leaves = getAllLeaves(page.layout);
      for (const leaf of leaves) {
        if (this.cellPool.get(leaf.id)) {
          this.navSequence.push(leaf.id);
        }
      }
    }
  }

  // =====================
  //  NAVIGATION HANDLER FACTORY
  // =====================

  /**
   * Create a NavigationHandler for a specific cell.
   * This handler is passed to the cell's TextKernel.setNavigationHandler().
   */
  createHandler(cellId: string): NavigationHandler {
    return {
      onBoundary: (direction) => this.handleBoundary(cellId, direction),
    };
  }

  // =====================
  //  BOUNDARY NAVIGATION
  // =====================

  private handleBoundary(cellId: string, direction: 'up' | 'down' | 'left' | 'right'): void {
    const idx = this.navSequence.indexOf(cellId);
    if (idx === -1) return;

    const targetIdx = (direction === 'down' || direction === 'right') ? idx + 1 : idx - 1;
    if (targetIdx < 0 || targetIdx >= this.navSequence.length) return;

    const targetCellId = this.navSequence[targetIdx];
    const targetCell = this.cellPool.get(targetCellId);
    const targetKernel = targetCell?.getKernel();
    if (!targetKernel) return;

    // Read goal-column X from the source cell's kernel
    const sourceCell = this.cellPool.get(cellId);
    const goalX = sourceCell?.getKernel()?.lastCursorX ?? null;

    // Notify active cell change
    this.config.onActiveCellChange?.(targetCellId);

    // Focus the target cell's editor at the appropriate line
    if (direction === 'down' || direction === 'right') {
      targetKernel.focusLineAtX('first', direction === 'down' ? goalX : null);
    } else {
      targetKernel.focusLineAtX('last', direction === 'up' ? goalX : null);
    }
  }
}
