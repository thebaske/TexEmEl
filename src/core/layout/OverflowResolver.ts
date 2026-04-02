// ============================================================================
// OverflowResolver — Chain reaction overflow engine
//
// After any layout change (split, resize, content edit), this resolver
// checks all cells for overflow and redistributes content:
//
// 1. Overflow pushes to sibling cells (right/below in BSP tree)
// 2. If no more siblings, overflow flows to the next page
// 3. If no next page, a new page is created
// 4. The process repeats until no overflow remains (max iterations guarded)
//
// Also handles the reverse: when cells have extra space, split paragraphs
// can be rejoined and empty pages removed.
// ============================================================================

import type { Block } from '../model/DocumentTree';
import type { CellInstance } from './CellInstance';
import type { Page } from './PageModel';
import type { LeafNode } from './LayoutTree';
import { OverflowDetector } from './OverflowDetector';
import { ContentSplitter } from './ContentSplitter';
import {
  createPage,
  addPageAfter,
  getNextPage,
  getFirstLeaf,
  findOverflowPath,
  removeEmptyPages,
} from './PageModel';
import {
  updateLeafBlocks,
  getAllLeaves,
  findNode,
} from './LayoutTree';

// --- Types ---

export interface ResolveResult {
  /** Updated pages array */
  pages: Page[];
  /** Page IDs that were modified and need re-rendering */
  affectedPageIds: Set<string>;
  /** Whether any overflow was resolved (pages/content changed) */
  changed: boolean;
}

// --- Resolver ---

const MAX_ITERATIONS = 20;

export class OverflowResolver {
  private detector = new OverflowDetector();
  private splitter = new ContentSplitter();

  /**
   * Resolve all overflows across all pages.
   * Call this after any layout or content change.
   *
   * @param pages Current pages array
   * @param getCell Function to retrieve CellInstance by cellId
   * @returns Updated pages and affected page IDs
   */
  resolve(
    pages: Page[],
    getCell: (cellId: string) => CellInstance | undefined,
  ): ResolveResult {
    let currentPages = pages;
    const affectedPageIds = new Set<string>();
    let changed = false;
    let iteration = 0;

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      let foundOverflow = false;

      // Check each page, each leaf cell
      for (const page of [...currentPages]) {
        const leaves = getAllLeaves(page.layout);

        for (const leaf of leaves) {
          const cell = getCell(leaf.id);
          if (!cell) continue;

          const handle = { cellId: leaf.id, contentElement: cell.contentElement };
          if (!this.detector.hasOverflow(handle)) continue;

          // Found overflow — resolve it
          foundOverflow = true;
          changed = true;
          affectedPageIds.add(page.id);

          const overflowInfo = this.detector.findBreakPoint(handle);
          const blocks = cell.getContent();
          const { fitting, overflow } = this.splitter.splitOnOverflow(blocks, overflowInfo);

          if (overflow.length === 0) continue; // Guard: nothing to move

          // Update current cell with only fitting blocks
          cell.setContent(fitting);
          currentPages = this.updateCellBlocks(currentPages, page.id, leaf.id, fitting);

          // Find overflow target: sibling cells first, then next page
          const overflowPath = findOverflowPath(page, leaf.id);
          let placed = false;

          for (const targetCellId of overflowPath) {
            const targetLeaf = findNode(page.layout, targetCellId) as LeafNode | null;
            if (!targetLeaf || targetLeaf.type !== 'leaf') continue;

            // Prepend overflow blocks to the target cell
            const targetCell = getCell(targetCellId);
            if (targetCell) {
              targetCell.prependBlocks(overflow);
            }
            const targetBlocks = [...overflow, ...targetLeaf.blocks];
            currentPages = this.updateCellBlocks(currentPages, page.id, targetCellId, targetBlocks);
            placed = true;
            break;
          }

          if (!placed) {
            // No sibling cells — flow to next page
            currentPages = this.flowToNextPage(currentPages, page.id, overflow);
          }

          // Break inner loop — re-check from the beginning
          // (the page/cell structure may have changed)
          break;
        }

        if (foundOverflow) break; // Re-check from the top
      }

      if (!foundOverflow) break; // No more overflows — done
    }

    // Clean up empty pages
    const cleaned = removeEmptyPages(currentPages);
    if (cleaned.length !== currentPages.length) {
      changed = true;
      currentPages = cleaned;
    }

    return { pages: currentPages, affectedPageIds, changed };
  }

  /**
   * Check for underflow: cells with extra space that could reclaim content
   * from split paragraphs on the next page. (Reverse of overflow.)
   *
   * TODO: Implement rejoin logic for split paragraphs when cells grow.
   * For now, this is a placeholder.
   */
  resolveUnderflow(
    _pages: Page[],
    _getCell: (cellId: string) => CellInstance | undefined,
  ): ResolveResult {
    // Phase 2: implement rejoin of split paragraphs
    return { pages: _pages, affectedPageIds: new Set(), changed: false };
  }

  // --- Internal Helpers ---

  /** Update blocks in a specific cell within a page */
  private updateCellBlocks(pages: Page[], pageId: string, cellId: string, blocks: Block[]): Page[] {
    return pages.map(p => {
      if (p.id !== pageId) return p;
      return { ...p, layout: updateLeafBlocks(p.layout, cellId, blocks) };
    });
  }

  /** Flow overflow blocks to the next page (creating one if needed) */
  private flowToNextPage(pages: Page[], currentPageId: string, overflowBlocks: Block[]): Page[] {
    const nextPage = getNextPage(pages, currentPageId);

    if (nextPage) {
      // Prepend overflow to the first leaf of the next page
      const firstLeaf = getFirstLeaf(nextPage);
      const targetBlocks = [...overflowBlocks, ...firstLeaf.blocks];
      return pages.map(p => {
        if (p.id !== nextPage.id) return p;
        return { ...p, layout: updateLeafBlocks(p.layout, firstLeaf.id, targetBlocks) };
      });
    }

    // No next page — create a new one with the overflow content
    const newPage = createPage(overflowBlocks);
    return addPageAfter(pages, currentPageId, newPage);
  }
}
