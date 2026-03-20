// ============================================================================
// PageModel — Multi-page document model
//
// Each Page wraps an independent BSP LayoutTree. Pages stack vertically
// like real document pages. The PaginatedDocument holds all pages.
//
// This file has ZERO DOM dependencies. Pure data + pure functions.
// ============================================================================

import type { Block, DocumentMetadata } from '../model/DocumentTree';
import type { LayoutNode, LeafNode } from './LayoutTree';
import { createDefaultLayout, getAllLeaves, collectBlocks, findNode, findParent } from './LayoutTree';
import { generateBlockId } from '../engine/BlockId';

// --- Types ---

export interface Page {
  id: string;
  layout: LayoutNode;
}

export interface PaginatedDocument {
  pages: Page[];
  metadata: DocumentMetadata;
}

// --- Factory ---

/** Create a new page with the given layout (defaults to a single empty cell) */
export function createPage(blocks: Block[] = [], id?: string): Page {
  return {
    id: id ?? generateBlockId(),
    layout: createDefaultLayout(blocks),
  };
}

/** Create a page with an existing layout tree */
export function createPageWithLayout(layout: LayoutNode, id?: string): Page {
  return {
    id: id ?? generateBlockId(),
    layout,
  };
}

// --- Page Operations ---

/** Add a new page after the specified page ID. Returns updated pages array. */
export function addPageAfter(pages: Page[], afterPageId: string, newPage: Page): Page[] {
  const index = pages.findIndex(p => p.id === afterPageId);
  if (index === -1) return [...pages, newPage]; // fallback: append
  const result = [...pages];
  result.splice(index + 1, 0, newPage);
  return result;
}

/** Remove a page by ID. Returns updated pages array. */
export function removePage(pages: Page[], pageId: string): Page[] {
  return pages.filter(p => p.id !== pageId);
}

/** Find which page contains a given cell ID */
export function getPageForCell(pages: Page[], cellId: string): Page | null {
  for (const page of pages) {
    if (findNode(page.layout, cellId)) return page;
  }
  return null;
}

/** Get the page after the given page ID */
export function getNextPage(pages: Page[], pageId: string): Page | null {
  const index = pages.findIndex(p => p.id === pageId);
  if (index === -1 || index === pages.length - 1) return null;
  return pages[index + 1];
}

/** Check if a page is the last page */
export function isLastPage(pages: Page[], pageId: string): boolean {
  return pages.length > 0 && pages[pages.length - 1].id === pageId;
}

/** Collect all blocks from all pages in order (for export) */
export function collectAllBlocks(pages: Page[]): Block[] {
  const allBlocks: Block[] = [];
  for (const page of pages) {
    allBlocks.push(...collectBlocks(page.layout));
  }
  return allBlocks;
}

/** Get the first leaf cell in a page (for inserting overflow content) */
export function getFirstLeaf(page: Page): LeafNode {
  const leaves = getAllLeaves(page.layout);
  return leaves[0];
}

/** Get the last leaf cell in a page */
export function getLastLeaf(page: Page): LeafNode {
  const leaves = getAllLeaves(page.layout);
  return leaves[leaves.length - 1];
}

/**
 * Find the overflow path for a cell within a page.
 * Returns an ordered list of cell IDs that overflow should flow through:
 * siblings to the right/below, then cousins, walking up the BSP tree.
 *
 * For a horizontal split: overflow goes DOWN (to second child)
 * For a vertical split: overflow goes RIGHT (to second child)
 */
export function findOverflowPath(page: Page, cellId: string): string[] {
  const path: string[] = [];
  collectOverflowTargets(page.layout, cellId, path);
  return path;
}

/**
 * Walk the BSP tree to collect overflow target cells in order.
 * Starting from the given cell, find its sibling, then the sibling's
 * first leaf, then walk up to find the parent's sibling, etc.
 */
function collectOverflowTargets(
  root: LayoutNode,
  cellId: string,
  targets: string[],
): void {
  const parent = findParent(root, cellId);
  if (!parent) return; // At root, no more siblings

  // Find the sibling (the other child of the parent split)
  const isFirstChild = parent.first.id === cellId ||
    (parent.first.type === 'split' && containsNode(parent.first, cellId));

  if (isFirstChild) {
    // Overflow goes to second child's first leaf
    const secondLeaves = getAllLeaves(parent.second);
    for (const leaf of secondLeaves) {
      targets.push(leaf.id);
    }
  }

  // Walk up: find overflow targets for the parent split itself
  collectOverflowTargets(root, parent.id, targets);
}

/** Check if a node contains a descendant with the given ID */
function containsNode(node: LayoutNode, id: string): boolean {
  if (node.id === id) return true;
  if (node.type === 'split') {
    return containsNode(node.first, id) || containsNode(node.second, id);
  }
  return false;
}

/**
 * Check if a cell is at the bottom edge of a page's BSP tree.
 * A cell is "at the bottom" if it's the second child (or descendant of second child)
 * in every horizontal split above it, all the way to the root.
 */
export function isCellAtPageBottom(page: Page, cellId: string): boolean {
  let currentId = cellId;
  let parent = findParent(page.layout, currentId);

  while (parent) {
    if (parent.direction === 'horizontal') {
      // In a horizontal split, must be in the second (bottom) child
      const isInSecond = parent.second.id === currentId ||
        containsNode(parent.second, currentId);
      if (!isInSecond) return false;
    }
    currentId = parent.id;
    parent = findParent(page.layout, currentId);
  }

  return true;
}

/** Remove empty pages (pages where all leaves have no blocks) */
export function removeEmptyPages(pages: Page[]): Page[] {
  if (pages.length <= 1) return pages; // Always keep at least one page
  return pages.filter((page, index) => {
    if (index === 0) return true; // Always keep first page
    const leaves = getAllLeaves(page.layout);
    return leaves.some(leaf => leaf.blocks.length > 0);
  });
}
