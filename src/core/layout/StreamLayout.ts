// ============================================================================
// StreamLayout — Compute which blocks are visible in which cell
//
// Given a ContentStream and a list of cells in reading order, computes
// the slice [startIndex, endIndex) each cell should display.
//
// This is a PURE COMPUTATION. No DOM mutation. The result is a mapping
// that the LayoutDirector applies to cells.
//
// Uses OverflowDetector for DOM measurement (needs cells to be mounted).
// ============================================================================

import type { Block } from '../model/DocumentTree';
import type { CellInstance } from './CellInstance';

// --- Types ---

export interface CellSlice {
  cellId: string;
  /** Inclusive start index in the stream */
  startIndex: number;
  /** Exclusive end index in the stream */
  endIndex: number;
}

// --- StreamLayout ---

/**
 * Compute the layout: which stream blocks go in which cell.
 *
 * Algorithm:
 * 1. Walk cells in reading order (from FlowGraph)
 * 2. For each cell, render blocks from the stream until the cell is full
 * 3. Record the slice [start, end) for that cell
 * 4. Continue with remaining blocks in the next cell
 *
 * @param blocks - All blocks from the ContentStream
 * @param cells - Cells in reading order (from FlowGraph), with their DOM mounted
 * @param measureFn - Function to check if a cell overflows with given block count
 * @returns Array of CellSlice mappings
 */
export function computeStreamLayout(
  blocks: Block[],
  cellOrder: CellInstance[],
  measureFn: (cell: CellInstance, blockCount: number) => boolean,
): CellSlice[] {
  const slices: CellSlice[] = [];
  let streamIndex = 0;

  for (const cell of cellOrder) {
    const startIndex = streamIndex;

    if (streamIndex >= blocks.length) {
      // No more blocks — cell is empty
      slices.push({ cellId: cell.id, startIndex, endIndex: startIndex });
      continue;
    }

    // Binary search: find max blocks that fit in this cell
    // Start by trying all remaining blocks, then narrow down
    const remainingCount = blocks.length - streamIndex;
    let fits = 0;

    // Try adding blocks one at a time until overflow
    // (linear is simpler and works well for typical block counts per cell)
    for (let count = 1; count <= remainingCount; count++) {
      const overflows = measureFn(cell, count);
      if (overflows) {
        break;
      }
      fits = count;
    }

    // If nothing fits and we have blocks, force at least 1 block
    // (prevents infinite loop where a big block bounces between cells)
    if (fits === 0 && streamIndex < blocks.length) {
      fits = 1;
    }

    const endIndex = streamIndex + fits;
    slices.push({ cellId: cell.id, startIndex, endIndex });
    streamIndex = endIndex;
  }

  // If there are still blocks remaining after all cells are full,
  // record them as "unplaced" — the director needs to create more pages
  if (streamIndex < blocks.length) {
    // Signal via a special slice with no cellId
    slices.push({
      cellId: '__overflow__',
      startIndex: streamIndex,
      endIndex: blocks.length,
    });
  }

  return slices;
}

/**
 * Check if two slice arrays represent the same layout.
 * Used to avoid unnecessary DOM updates.
 */
export function slicesEqual(a: CellSlice[], b: CellSlice[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].cellId !== b[i].cellId ||
        a[i].startIndex !== b[i].startIndex ||
        a[i].endIndex !== b[i].endIndex) {
      return false;
    }
  }
  return true;
}
