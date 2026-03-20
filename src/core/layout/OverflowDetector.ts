// ============================================================================
// OverflowDetector — DOM measurement for content overflow detection
//
// Measures whether cell content exceeds its allocated space.
// Uses DOM measurement (scrollHeight, getBoundingClientRect, Range API)
// to detect overflow and find break points — both at block level and
// within paragraphs (line-level).
//
// Requires DOM access — runs after render.
// ============================================================================

import type { BlockNode } from '../engine/BlockNode';

/**
 * Lightweight interface for cell measurement.
 * Works with both CellRenderer.CellHandle (legacy) and CellInstance (V3).
 */
export interface MeasurableCell {
  cellId: string;
  contentElement: HTMLElement;
  blockNodes: BlockNode[];
}

// --- Types ---

export interface BlockPosition {
  blockId: string;
  element: HTMLElement;
  top: number;      // relative to cell content area
  bottom: number;
  height: number;
}

export interface OverflowInfo {
  cellId: string;
  hasOverflow: boolean;
  /** Index of the last block that fully fits (or -1 if none fit) */
  lastFittingBlockIndex: number;
  /** If the break falls mid-paragraph, line-level break info */
  lineBreak?: LineBreakInfo;
}

export interface LineBreakInfo {
  /** Index of the block that spans the boundary */
  blockIndex: number;
  blockId: string;
  /** Character offset in the text content where the break should occur */
  charOffset: number;
  /** The Y position of the break line within the block element */
  breakY: number;
}

// --- Detector ---

export class OverflowDetector {
  /**
   * Check if a cell has overflow (content taller than available space).
   */
  hasOverflow(handle: MeasurableCell): boolean {
    const el = handle.contentElement;
    return el.scrollHeight > el.clientHeight + 1; // 1px tolerance
  }

  /**
   * Measure all block positions within a cell, relative to the cell content area.
   */
  measureBlockPositions(handle: MeasurableCell): BlockPosition[] {
    const contentRect = handle.contentElement.getBoundingClientRect();
    const positions: BlockPosition[] = [];

    for (const bn of handle.blockNodes) {
      const rect = bn.element.getBoundingClientRect();
      positions.push({
        blockId: bn.id,
        element: bn.element,
        top: rect.top - contentRect.top,
        bottom: rect.bottom - contentRect.top,
        height: rect.height,
      });
    }

    return positions;
  }

  /**
   * Find the break point in a cell — the last block (or line within a block)
   * that fits within the cell's visible area.
   *
   * Returns full overflow info including potential mid-paragraph line break.
   */
  findBreakPoint(handle: MeasurableCell): OverflowInfo {
    const cellId = handle.cellId;
    const cellHeight = handle.contentElement.clientHeight;

    if (!this.hasOverflow(handle)) {
      return {
        cellId,
        hasOverflow: false,
        lastFittingBlockIndex: handle.blockNodes.length - 1,
      };
    }

    const positions = this.measureBlockPositions(handle);

    // Find the last block that fully fits
    let lastFitting = -1;
    for (let i = 0; i < positions.length; i++) {
      if (positions[i].bottom <= cellHeight) {
        lastFitting = i;
      } else {
        break;
      }
    }

    // Check if the next block (the one that overflows) is a text block
    // that we can split at a line boundary
    const overflowIndex = lastFitting + 1;
    if (overflowIndex < positions.length) {
      const overflowBlock = handle.blockNodes[overflowIndex];
      const overflowPos = positions[overflowIndex];

      // Only attempt line-level splitting for text blocks (paragraph, heading)
      if (overflowBlock.isEditable() && overflowPos.top < cellHeight) {
        // This block starts within the cell but extends beyond — try line break
        const lineBreak = this.findLineBreak(
          overflowBlock.element,
          cellHeight - overflowPos.top, // available height within the block
          overflowBlock.id,
          overflowIndex,
        );

        if (lineBreak) {
          return {
            cellId,
            hasOverflow: true,
            lastFittingBlockIndex: lastFitting,
            lineBreak,
          };
        }
      }
    }

    // No line-level break possible — break at block level
    return {
      cellId,
      hasOverflow: true,
      lastFittingBlockIndex: lastFitting,
    };
  }

  /**
   * Find a line-level break point within a text block.
   * Uses the Range API to measure line positions.
   *
   * Returns null if line-level splitting isn't possible
   * (e.g., non-text content, single-line block, or the block is a single
   * oversized element like an image).
   */
  private findLineBreak(
    blockElement: HTMLElement,
    availableHeight: number,
    blockId: string,
    blockIndex: number,
  ): LineBreakInfo | null {
    // Find the ProseMirror content element
    const pmEl = blockElement.querySelector('.ProseMirror') as HTMLElement;
    if (!pmEl) return null;

    const blockRect = blockElement.getBoundingClientRect();

    // Walk through text nodes to find line boundaries
    const walker = document.createTreeWalker(pmEl, NodeFilter.SHOW_TEXT);
    let charOffset = 0;
    let lastFittingOffset = 0;
    let lastFittingY = 0;

    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const text = textNode.textContent ?? '';

      for (let i = 0; i < text.length; i++) {
        const range = document.createRange();
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);

        const rects = range.getClientRects();
        if (rects.length > 0) {
          const charBottom = rects[0].bottom - blockRect.top;

          if (charBottom <= availableHeight) {
            lastFittingOffset = charOffset + i + 1;
            lastFittingY = charBottom;
          } else {
            // Found the first character that doesn't fit
            if (lastFittingOffset > 0) {
              return {
                blockIndex,
                blockId,
                charOffset: lastFittingOffset,
                breakY: lastFittingY,
              };
            }
            // No characters fit — can't do line-level split
            return null;
          }
        }
      }

      charOffset += text.length;
    }

    // All text fits (shouldn't happen if we're called correctly)
    return null;
  }
}
