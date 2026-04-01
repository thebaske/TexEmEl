// ============================================================================
// NavigationController — Cross-block keyboard navigation coordinator
//
// Intercepts keyboard events at the ProseMirror level (via NavigationHandler)
// and transfers focus between blocks and cells. Maintains a flat navigation
// sequence of all (cellId, blockId) pairs in reading order.
//
// This file coordinates navigation. TextKernel detects boundaries.
// NavigationController decides where to go.
// ============================================================================

import type { NavigationHandler } from '../engine/types';
import type { CellPool } from './CellPool';
import type { Page } from './PageModel';
import { getAllLeaves } from './LayoutTree';
import { generateBlockId } from '../engine/BlockId';
import type { Block } from '../model/DocumentTree';

// --- Types ---

interface NavEntry {
  cellId: string;
  blockId: string;
}

export type OnBlockCreatedCallback = (cellId: string, block: Block) => void;
export type OnActiveCellChangeCallback = (cellId: string) => void;

export interface NavigationControllerConfig {
  onBlockCreated?: OnBlockCreatedCallback;
  onActiveCellChange?: OnActiveCellChangeCallback;
  onFocusedBlockChange?: (blockId: string | null) => void;
}

// --- NavigationController ---

export class NavigationController {
  private cellPool: CellPool;
  private config: NavigationControllerConfig;

  /** Flat sequence of all navigable blocks in reading order */
  private navSequence: NavEntry[] = [];

  constructor(cellPool: CellPool, config: NavigationControllerConfig = {}) {
    this.cellPool = cellPool;
    this.config = config;
  }

  // =====================
  //  SEQUENCE MANAGEMENT
  // =====================

  /**
   * Rebuild the navigation sequence from the current page/cell/block structure.
   * Called after any layout change (split, merge, block add/remove).
   */
  rebuildSequence(pages: Page[]): void {
    this.navSequence = [];

    for (const page of pages) {
      const leaves = getAllLeaves(page.layout);
      for (const leaf of leaves) {
        const cell = this.cellPool.get(leaf.id);
        if (!cell) continue;

        for (const bn of cell.getBlockNodes()) {
          this.navSequence.push({ cellId: leaf.id, blockId: bn.id });
        }
      }
    }
  }

  // =====================
  //  NAVIGATION HANDLER FACTORY
  // =====================

  /**
   * Create a NavigationHandler for a specific block in a specific cell.
   * This handler is passed to TextKernel.setNavigationHandler().
   */
  createHandler(cellId: string, blockId: string): NavigationHandler {
    return {
      onBoundary: (direction) => this.handleBoundary(blockId, direction),
      onEnterAtEnd: () => this.handleEnterAtEnd(cellId, blockId),
      onSelectAll: () => this.handleSelectAll(cellId),
    };
  }

  // =====================
  //  BOUNDARY NAVIGATION
  // =====================

  private handleBoundary(blockId: string, direction: 'up' | 'down' | 'left' | 'right'): void {
    const idx = this.navSequence.findIndex(e => e.blockId === blockId);
    if (idx === -1) return;

    const targetIdx = (direction === 'down' || direction === 'right') ? idx + 1 : idx - 1;
    if (targetIdx < 0 || targetIdx >= this.navSequence.length) return;

    const target = this.navSequence[targetIdx];
    const cell = this.cellPool.get(target.cellId);
    const blockNode = cell?.getBlockNode(target.blockId);
    if (!blockNode?.kernel) return;

    // Read goal-column X from the source block's kernel (set during boundary detection)
    const sourceCell = this.cellPool.get(this.navSequence[idx].cellId);
    const sourceBlock = sourceCell?.getBlockNode(this.navSequence[idx].blockId);
    const goalX = sourceBlock?.kernel?.lastCursorX ?? null;

    // Update active cell if crossing cell boundary
    if (target.cellId !== this.navSequence[idx].cellId) {
      this.config.onActiveCellChange?.(target.cellId);
    }

    this.config.onFocusedBlockChange?.(target.blockId);

    if (direction === 'down' || direction === 'right') {
      // Down/Right: land on first line of target, preserving horizontal position
      blockNode.kernel.focusLineAtX('first', direction === 'down' ? goalX : null);
    } else {
      // Up/Left: land on last line of target, preserving horizontal position
      blockNode.kernel.focusLineAtX('last', direction === 'up' ? goalX : null);
    }
  }

  // =====================
  //  ENTER AT END → NEW BLOCK
  // =====================

  private handleEnterAtEnd(cellId: string, _blockId: string): void {
    const cell = this.cellPool.get(cellId);
    if (!cell) return;

    const newBlock: Block = {
      type: 'paragraph',
      content: [],
      id: generateBlockId(),
    };

    // Add new block to the cell
    const newNode = cell.addBlock(newBlock);

    // Notify director to update tree for serialization
    this.config.onBlockCreated?.(cellId, newBlock);

    // Rebuild sequence to include new block
    // (caller should call rebuildSequence after this, but we add it locally for immediate nav)
    this.navSequence.push({ cellId, blockId: newNode.id });

    this.config.onFocusedBlockChange?.(newNode.id);

    // Focus the new block
    requestAnimationFrame(() => {
      if (newNode.kernel) {
        newNode.kernel.focusStart();
      }
    });
  }

  // =====================
  //  SELECT ALL IN CELL
  // =====================

  private handleSelectAll(cellId: string): void {
    const cell = this.cellPool.get(cellId);
    if (!cell) return;

    const blocks = cell.getBlockNodes();
    if (blocks.length === 0) return;

    if (blocks.length === 1) {
      // Single block — just select all within it
      blocks[0].kernel?.selectAll();
      return;
    }

    // Multiple blocks — select all in each, then create native selection spanning all
    for (const bn of blocks) {
      bn.kernel?.selectAll();
    }

    // Create a native browser selection spanning all block DOMs
    try {
      const selection = window.getSelection();
      if (!selection) return;

      const firstEl = blocks[0].element;
      const lastEl = blocks[blocks.length - 1].element;

      const range = document.createRange();
      range.setStartBefore(firstEl);
      range.setEndAfter(lastEl);

      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Fallback: just select all in the first block
      blocks[0].kernel?.selectAll();
    }
  }
}
