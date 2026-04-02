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

/**
 * Lightweight interface for cell measurement.
 * Works with CellInstance — uses ProseMirror DOM children for block measurement.
 */
export interface MeasurableCell {
  cellId: string;
  contentElement: HTMLElement;
}

// --- Types ---

export interface BlockPosition {
  index: number;
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
  /** Total number of top-level block elements measured */
  totalBlocks: number;
  /** If the break falls mid-paragraph, line-level break info */
  lineBreak?: LineBreakInfo;
}

export interface LineBreakInfo {
  /** Index of the block that spans the boundary */
  blockIndex: number;
  /** Character offset in the text content where the break should occur */
  charOffset: number;
  /** The Y position of the break line within the block element */
  breakY: number;
}

// --- Detector ---

/** Tags that represent text blocks eligible for line-level splitting */
const TEXT_BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

export class OverflowDetector {
  /**
   * Check if a cell has overflow (content taller than available space).
   */
  hasOverflow(handle: MeasurableCell): boolean {
    const el = handle.contentElement;
    return el.scrollHeight > el.clientHeight + 1; // 1px tolerance
  }

  /**
   * Get the top-level block elements from the ProseMirror editor inside a cell.
   * In V3 architecture, the contentElement contains a .ProseMirror div,
   * whose direct children are the top-level block nodes.
   */
  private getBlockElements(handle: MeasurableCell): HTMLElement[] {
    const pmEl = handle.contentElement.querySelector('.ProseMirror');
    if (!pmEl) return [];
    return Array.from(pmEl.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement
    );
  }

  /**
   * Measure all block positions within a cell, relative to the cell content area.
   */
  measureBlockPositions(handle: MeasurableCell): BlockPosition[] {
    const contentRect = handle.contentElement.getBoundingClientRect();
    const blockElements = this.getBlockElements(handle);
    const positions: BlockPosition[] = [];

    for (let i = 0; i < blockElements.length; i++) {
      const rect = blockElements[i].getBoundingClientRect();
      positions.push({
        index: i,
        element: blockElements[i],
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
    const blockElements = this.getBlockElements(handle);

    if (!this.hasOverflow(handle)) {
      return {
        cellId,
        hasOverflow: false,
        lastFittingBlockIndex: blockElements.length - 1,
        totalBlocks: blockElements.length,
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
      const overflowEl = blockElements[overflowIndex];
      const overflowPos = positions[overflowIndex];

      // Only attempt line-level splitting for text blocks (paragraph, heading)
      if (TEXT_BLOCK_TAGS.has(overflowEl.tagName) && overflowPos.top < cellHeight) {
        // This block starts within the cell but extends beyond — try line break
        const lineBreak = this.findLineBreak(
          overflowEl,
          cellHeight - overflowPos.top, // available height within the block
          overflowIndex,
        );

        if (lineBreak) {
          return {
            cellId,
            hasOverflow: true,
            lastFittingBlockIndex: lastFitting,
            totalBlocks: blockElements.length,
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
      totalBlocks: blockElements.length,
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
    blockIndex: number,
  ): LineBreakInfo | null {
    const blockRect = blockElement.getBoundingClientRect();

    // Walk through text nodes to find line boundaries
    const walker = document.createTreeWalker(blockElement, NodeFilter.SHOW_TEXT);
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
