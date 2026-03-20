// ============================================================================
// FlowGraph — Content overflow routing between cells
//
// Directed graph where each cell can flow into at most one target cell.
// Auto-generated from BSP tree structure in reading order:
//   - Horizontal split (top/bottom): top → bottom
//   - Vertical split (left/right): left → right
//   - Cross-page: last cell on page N → first cell on page N+1
//
// Reading order for nested splits follows Z-pattern:
//   top-left → top-right → bottom-left → bottom-right
//
// This file has ZERO DOM dependencies. Pure data + pure functions.
// ============================================================================

import type { LayoutNode } from './LayoutTree';
import { getAllLeaves } from './LayoutTree';
import type { Page } from './PageModel';

// --- FlowGraph ---

export class FlowGraph {
  /** Directed edges: source cellId → target cellId */
  private forward = new Map<string, string>();
  /** Reverse edges: target cellId → source cellId */
  private reverse = new Map<string, string>();

  // =====================
  //  CONSTRUCTION
  // =====================

  /**
   * Build flow graph from BSP tree pages.
   * Reading order: Z-pattern (left→right, top→bottom) within each page,
   * then cross-page (last cell of page N → first cell of page N+1).
   */
  static fromPages(pages: Page[]): FlowGraph {
    const graph = new FlowGraph();

    // Collect cells in reading order for each page
    const pageChains: string[][] = [];
    for (const page of pages) {
      const chain = getReadingOrder(page.layout);
      pageChains.push(chain);
    }

    // Link cells within each page
    for (const chain of pageChains) {
      for (let i = 0; i < chain.length - 1; i++) {
        graph.link(chain[i], chain[i + 1]);
      }
    }

    // Link across pages: last cell of page N → first cell of page N+1
    for (let p = 0; p < pageChains.length - 1; p++) {
      const lastOfCurrent = pageChains[p][pageChains[p].length - 1];
      const firstOfNext = pageChains[p + 1][0];
      if (lastOfCurrent && firstOfNext) {
        graph.link(lastOfCurrent, firstOfNext);
      }
    }

    return graph;
  }

  // =====================
  //  GRAPH OPERATIONS
  // =====================

  /** Set a flow edge: content overflowing from `from` goes to `to` */
  link(from: string, to: string): void {
    this.forward.set(from, to);
    this.reverse.set(to, from);
  }

  /** Remove a flow edge */
  unlink(from: string): void {
    const to = this.forward.get(from);
    if (to) {
      this.reverse.delete(to);
    }
    this.forward.delete(from);
  }

  /** Get the next cell in the flow (where overflow goes) */
  getTarget(cellId: string): string | null {
    return this.forward.get(cellId) ?? null;
  }

  /** Get the previous cell in the flow (who flows into this cell) */
  getSource(cellId: string): string | null {
    return this.reverse.get(cellId) ?? null;
  }

  /** Get the full flow chain starting from a cell */
  getChainFrom(cellId: string): string[] {
    const chain: string[] = [cellId];
    let current = cellId;
    const visited = new Set<string>([cellId]);

    while (true) {
      const next = this.forward.get(current);
      if (!next || visited.has(next)) break; // prevent cycles
      chain.push(next);
      visited.add(next);
      current = next;
    }

    return chain;
  }

  /** Get the full flow chain that includes a cell (walking backwards to the start) */
  getFullChain(cellId: string): string[] {
    // Walk backwards to find the start of the chain
    let start = cellId;
    const visited = new Set<string>([cellId]);

    while (true) {
      const prev = this.reverse.get(start);
      if (!prev || visited.has(prev)) break;
      visited.add(prev);
      start = prev;
    }

    return this.getChainFrom(start);
  }

  /** Check if a cell has a flow target */
  hasTarget(cellId: string): boolean {
    return this.forward.has(cellId);
  }

  /** Check if a cell has a flow source */
  hasSource(cellId: string): boolean {
    return this.reverse.has(cellId);
  }

  /** Get all edges for debugging */
  getAllEdges(): Array<{ from: string; to: string }> {
    const edges: Array<{ from: string; to: string }> = [];
    for (const [from, to] of this.forward) {
      edges.push({ from, to });
    }
    return edges;
  }

  /** Clear all edges */
  clear(): void {
    this.forward.clear();
    this.reverse.clear();
  }
}

// ============================================================================
// Reading Order — Z-pattern traversal of BSP tree
// ============================================================================

/**
 * Get leaf cells in reading order (Z-pattern: left→right, top→bottom).
 *
 * For a BSP tree, this is a simple in-order traversal:
 * - Leaf: return [this cell]
 * - Split: return [...first children, ...second children]
 *
 * This naturally produces Z-pattern because:
 * - Vertical split (left|right): left cells come first, then right
 * - Horizontal split (top/bottom): top cells come first, then bottom
 * - Nested: top-left → top-right → bottom-left → bottom-right
 */
function getReadingOrder(node: LayoutNode): string[] {
  // getAllLeaves already does in-order traversal (first, then second)
  // which produces the correct Z-pattern reading order
  return getAllLeaves(node).map(leaf => leaf.id);
}
