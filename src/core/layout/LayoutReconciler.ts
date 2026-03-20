// ============================================================================
// LayoutReconciler — Diff-based DOM updates for BSP tree
//
// Walks old tree and new tree in parallel, producing minimal DOM mutations:
//   - Same leaf ID → reuse CellInstance (reparent DOM element)
//   - New leaf ID → create via CellPool
//   - Missing leaf ID → release via CellPool
//   - Same split ID → update flex styles if ratio/direction changed
//   - New split ID → create flex container
//
// This REPLACES CellRenderer's nuclear renderPages() with innerHTML=''.
// ProseMirror instances survive all layout operations.
// ============================================================================

import type { LayoutNode, SplitNode, LeafNode } from './LayoutTree';
import { getAllLeaves } from './LayoutTree';
import type { Page } from './PageModel';
import type { CellPool } from './CellPool';
import type { CellInstance } from './CellInstance';

// --- Types ---

export interface ReconcilerCallbacks {
  onCellClick?: (cellId: string, event: MouseEvent) => void;
  onCellDblClick?: (cellId: string, event: MouseEvent) => void;
}

// --- LayoutReconciler ---

export class LayoutReconciler {
  private cellPool: CellPool;
  private callbacks: ReconcilerCallbacks;

  /** Maps split IDs to their DOM containers (for reuse) */
  private splitElements = new Map<string, HTMLElement>();
  /** Maps split IDs to their resize handle elements */
  private handleElements = new Map<string, HTMLElement>();
  /** Maps page IDs to their DOM elements */
  private pageElements = new Map<string, HTMLElement>();
  /** The pages container element */
  private pagesContainer: HTMLElement | null = null;

  constructor(cellPool: CellPool, callbacks: ReconcilerCallbacks = {}) {
    this.cellPool = cellPool;
    this.callbacks = callbacks;
  }

  // =====================
  //  FULL RECONCILIATION
  // =====================

  /**
   * Reconcile multiple pages into a container.
   * First call does initial render; subsequent calls diff against previous state.
   */
  reconcilePages(container: HTMLElement, pages: Page[]): void {
    // Create or reuse pages container
    if (!this.pagesContainer) {
      this.pagesContainer = document.createElement('div');
      this.pagesContainer.classList.add('bsp-pages-container');
      container.appendChild(this.pagesContainer);
    }

    // Track which page IDs are still present
    const currentPageIds = new Set(pages.map(p => p.id));

    // Remove pages that no longer exist
    for (const [pageId, pageEl] of this.pageElements) {
      if (!currentPageIds.has(pageId)) {
        pageEl.remove();
        this.pageElements.delete(pageId);
      }
    }

    // Reconcile each page
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      let pageEl = this.pageElements.get(page.id);

      if (!pageEl) {
        // New page — create DOM
        pageEl = document.createElement('div');
        pageEl.classList.add('bsp-page');
        pageEl.dataset.pageId = page.id;
        this.pageElements.set(page.id, pageEl);
      }

      // Reconcile the BSP tree inside this page
      const bspRoot = this.reconcileNode(pageEl.firstElementChild as HTMLElement | null, page.layout);
      bspRoot.classList.add('bsp-root');

      if (pageEl.firstElementChild !== bspRoot) {
        pageEl.innerHTML = '';
        pageEl.appendChild(bspRoot);
      }

      // Ensure page is in correct position
      const currentChild = this.pagesContainer.children[i] as HTMLElement | undefined;
      if (currentChild !== pageEl) {
        this.pagesContainer.insertBefore(pageEl, currentChild ?? null);
      }
    }

    // Clean up orphaned cells not in any page's tree
    const allLeafIds = new Set<string>();
    for (const page of pages) {
      for (const leaf of getAllLeaves(page.layout)) {
        allLeafIds.add(leaf.id);
      }
    }
    this.cellPool.releaseExcept(allLeafIds);

    // Clean up orphaned split elements
    const allSplitIds = new Set<string>();
    for (const page of pages) {
      this.collectSplitIds(page.layout, allSplitIds);
    }
    for (const splitId of this.splitElements.keys()) {
      if (!allSplitIds.has(splitId)) {
        this.splitElements.delete(splitId);
        this.handleElements.delete(splitId);
      }
    }
  }

  // =====================
  //  RESIZE (CSS ONLY)
  // =====================

  /** Update just the flex ratio of a split — no DOM rebuild */
  updateRatio(splitId: string, ratio: number): void {
    const splitEl = this.splitElements.get(splitId);
    if (!splitEl) return;

    const first = splitEl.children[0] as HTMLElement;
    const handle = splitEl.children[1] as HTMLElement;
    const second = splitEl.children[2] as HTMLElement;
    if (!first || !handle || !second) return;

    const direction = splitEl.dataset.splitDirection;
    const pct1 = (ratio * 100).toFixed(2);
    const pct2 = ((1 - ratio) * 100).toFixed(2);

    if (direction === 'vertical') {
      first.style.width = `calc(${pct1}% - 2px)`;
      second.style.width = `calc(${pct2}% - 2px)`;
    } else {
      first.style.height = `calc(${pct1}% - 2px)`;
      second.style.height = `calc(${pct2}% - 2px)`;
    }
  }

  // =====================
  //  QUERIES
  // =====================

  /** Get the page ID that contains a given cell */
  getPageIdForCell(cellId: string): string | undefined {
    const cell = this.cellPool.get(cellId);
    if (!cell) return undefined;

    // Walk up from the cell element to find the page
    let el: HTMLElement | null = cell.element.parentElement;
    while (el) {
      if (el.dataset.pageId) return el.dataset.pageId;
      el = el.parentElement;
    }
    return undefined;
  }

  // =====================
  //  CLEANUP
  // =====================

  destroy(): void {
    this.splitElements.clear();
    this.handleElements.clear();
    this.pageElements.clear();
    if (this.pagesContainer) {
      this.pagesContainer.remove();
      this.pagesContainer = null;
    }
  }

  // =====================
  //  INTERNAL — NODE RECONCILIATION
  // =====================

  /**
   * Reconcile a single BSP node. Returns the DOM element for this node.
   * If oldEl matches the new node, it's updated in place. Otherwise, new DOM is created.
   */
  private reconcileNode(oldEl: HTMLElement | null, node: LayoutNode): HTMLElement {
    if (node.type === 'leaf') {
      return this.reconcileLeaf(node);
    }
    return this.reconcileSplit(oldEl, node);
  }

  private reconcileLeaf(leaf: LeafNode): HTMLElement {
    // Acquire from pool — returns existing cell if same ID (DOM element reused)
    const cell = this.cellPool.acquire(leaf.id, leaf.blocks);
    this.attachCellListeners(cell);
    return cell.element;
  }

  private reconcileSplit(_oldEl: HTMLElement | null, split: SplitNode): HTMLElement {
    // Try to reuse existing split container
    let container = this.splitElements.get(split.id);

    if (!container) {
      // Create new split container
      container = document.createElement('div');
      container.classList.add('bsp-split');
      container.dataset.splitId = split.id;
      this.splitElements.set(split.id, container);
    }

    // Update direction and flex styles
    const isVertical = split.direction === 'vertical';
    container.dataset.splitDirection = split.direction;
    container.style.display = 'flex';
    container.style.flexDirection = isVertical ? 'row' : 'column';
    container.style.width = '100%';
    container.style.height = '100%';

    // Reconcile children
    const firstEl = this.reconcileNode(null, split.first);
    const secondEl = this.reconcileNode(null, split.second);

    // Apply split child styles
    firstEl.classList.add('bsp-split-child');
    secondEl.classList.add('bsp-split-child');
    this.applySplitChildStyles(firstEl, split, true);
    this.applySplitChildStyles(secondEl, split, false);

    // Get or create resize handle
    let handle = this.handleElements.get(split.id);
    if (!handle) {
      handle = document.createElement('div');
      handle.classList.add('bsp-resize-handle');
      handle.dataset.splitId = split.id;
      this.handleElements.set(split.id, handle);
    }
    // Update handle direction class
    handle.classList.remove('bsp-resize-handle--vertical', 'bsp-resize-handle--horizontal');
    handle.classList.add(isVertical ? 'bsp-resize-handle--vertical' : 'bsp-resize-handle--horizontal');

    // Ensure children are in correct order: [first, handle, second]
    this.ensureChildren(container, [firstEl, handle, secondEl]);

    return container;
  }

  // =====================
  //  HELPERS
  // =====================

  private applySplitChildStyles(el: HTMLElement, split: SplitNode, isFirst: boolean): void {
    const ratio = isFirst ? split.ratio : 1 - split.ratio;
    const pct = (ratio * 100).toFixed(2);

    if (split.direction === 'vertical') {
      el.style.width = `calc(${pct}% - 2px)`;
      el.style.height = '100%';
    } else {
      el.style.height = `calc(${pct}% - 2px)`;
      el.style.width = '100%';
    }
    el.style.overflow = 'hidden';
  }

  /**
   * Ensure a container has exactly the given children in order.
   * Moves existing children rather than removing/recreating them.
   */
  private ensureChildren(container: HTMLElement, children: HTMLElement[]): void {
    // Remove any children not in the new list
    const childSet = new Set(children);
    const toRemove: Node[] = [];
    for (let i = 0; i < container.childNodes.length; i++) {
      const child = container.childNodes[i];
      if (!childSet.has(child as HTMLElement)) {
        toRemove.push(child);
      }
    }
    for (const child of toRemove) {
      container.removeChild(child);
    }

    // Ensure correct order (minimal moves)
    for (let i = 0; i < children.length; i++) {
      const expected = children[i];
      const current = container.children[i] as HTMLElement | undefined;

      if (current !== expected) {
        container.insertBefore(expected, current ?? null);
      }
    }
  }

  /** Attach click/dblclick listeners to a cell (idempotent via data attribute flag) */
  private attachCellListeners(cell: CellInstance): void {
    // Only attach once
    if (cell.element.dataset.listenersAttached) return;
    cell.element.dataset.listenersAttached = 'true';

    cell.element.addEventListener('click', (e) => {
      this.callbacks.onCellClick?.(cell.id, e);
    });
    cell.element.addEventListener('dblclick', (e) => {
      this.callbacks.onCellDblClick?.(cell.id, e);
    });
  }

  /** Collect all split node IDs from a tree */
  private collectSplitIds(node: LayoutNode, ids: Set<string>): void {
    if (node.type === 'split') {
      ids.add(node.id);
      this.collectSplitIds(node.first, ids);
      this.collectSplitIds(node.second, ids);
    }
  }
}
