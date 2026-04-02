// ============================================================================
// LayoutDirector — BSP Layout Orchestrator (One-PM-Per-Cell Architecture)
//
// Each cell owns ONE ProseMirror editor. PM handles all text operations
// (navigation, Enter, paste, formatting) natively within a cell.
// LayoutDirector handles layout operations (split, merge, resize, overflow).
//
// Delegates to:
//   - CellPool: persistent cell instances (each with one PM editor)
//   - LayoutReconciler: diff-based DOM updates
//   - SplitResizeManager: drag resize handles
//   - EdgeSplitManager: edge-pull-to-split
//   - NavigationController: cross-cell keyboard navigation
// ============================================================================

import type { Block, DocumentTree, TextMark } from '../model/DocumentTree';
import type { ITextKernel } from '../engine/types';
import { generateBlockId, assignBlockIds } from '../engine/BlockId';
import { CellPool } from './CellPool';
import { LayoutReconciler } from './LayoutReconciler';
import { SplitResizeManager } from './SplitResizeManager';
import { EdgeSplitManager } from './EdgeSplitManager';
import { NavigationController } from './NavigationController';
import {
  type LayoutNode,
  type SplitDirection,
  createDefaultLayout,
  splitCell,
  mergeCells,
  resizeSplit,
  findNode,
  findParent,
  getAllLeaves,
} from './LayoutTree';
import {
  type Page,
  createPage,
  addPageAfter,
  getPageForCell,
} from './PageModel';

// --- Types ---

export type OnLayoutChangeCallback = (tree: DocumentTree, layout: LayoutNode) => void;

export interface LayoutDirectorConfig {
  debounceMs: number;
}

const DEFAULT_CONFIG: LayoutDirectorConfig = {
  debounceMs: 150,
};

// --- Director ---

export class LayoutDirector {
  private container: HTMLElement | null = null;
  private config: LayoutDirectorConfig;

  // State
  private pages: Page[] = [];
  private metadata: DocumentTree['metadata'] = {};
  private activeCellId: string | null = null;
  private activePageId: string | null = null;

  // Subsystems
  private cellPool: CellPool | null = null;
  private reconciler: LayoutReconciler | null = null;
  private resizeManager: SplitResizeManager | null = null;
  private edgeSplitManager: EdgeSplitManager | null = null;
  private navigationController: NavigationController | null = null;

  // Kernel factory — injected by consumer
  private kernelFactory: ((el: HTMLElement, blocks: Block[]) => ITextKernel) | null = null;

  // Callbacks
  private onChangeCallbacks: OnLayoutChangeCallback[] = [];
  private onToolbarUpdateCallbacks: (() => void)[] = [];

  // Debounce
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<LayoutDirectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // Backward-compat: expose first page's layout
  get layout(): LayoutNode {
    return this.pages.length > 0 ? this.pages[0].layout : createDefaultLayout();
  }

  // =====================
  //  LIFECYCLE
  // =====================

  setKernelFactory(factory: (el: HTMLElement, blocks: Block[]) => ITextKernel): void {
    this.kernelFactory = factory;
  }

  mount(container: HTMLElement, doc: DocumentTree): void {
    this.container = container;
    container.tabIndex = -1;
    container.style.outline = 'none';

    // Clear any stale DOM from prior mount (React StrictMode double-fires effects)
    container.innerHTML = '';

    // Convert flat block list to single-page BSP layout
    const blocks = assignBlockIds(doc.blocks);
    this.pages = [createPage(blocks)];
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;

    // Create navigation controller (cross-cell keyboard movement)
    this.navigationController = new NavigationController(
      null as any, // pool not created yet — will be set below
      {
        onActiveCellChange: (cellId) => this.setActiveCell(cellId),
      },
    );

    // Create subsystems
    this.cellPool = new CellPool({
      kernelFactory: this.kernelFactory!,
      onContentChange: (cellId: string) => {
        this.debouncedSync();
        this.emitToolbarUpdate();
        this.checkLastCellOverflow(cellId);
      },
      onSelectionChange: (_cellId: string) => {
        this.emitToolbarUpdate();
      },
      navigationController: this.navigationController,
    });

    // Now that pool exists, update the controller's reference
    (this.navigationController as any).cellPool = this.cellPool;

    this.reconciler = new LayoutReconciler(this.cellPool, {
      onCellClick: (cellId, e) => this.handleCellClick(cellId, e),
      onCellDblClick: (cellId, _e) => this.handleCellDblClick(cellId),
    });

    // Initial render
    this.reconciler.reconcilePages(container, this.pages);

    // Build navigation sequence
    this.navigationController.rebuildSequence(this.pages);

    // After initial render, check if content exceeds the first page.
    // Use a delayed check to ensure DOM layout is fully computed.
    // For large documents, ProseMirror needs time to render all nodes.
    setTimeout(() => {
      const leaves = getAllLeaves(this.pages[0].layout);
      const lastLeafId = leaves[leaves.length - 1]?.id;
      if (lastLeafId) {
        this.distributeOverflowToPages(lastLeafId);
      }
    }, 200);

    // Set up resize manager
    this.resizeManager = new SplitResizeManager(container, {
      onResize: (splitId, ratio) => {
        this.reconciler!.updateRatio(splitId, ratio);
      },
      onResizeEnd: (splitId, ratio) => {
        for (const page of this.pages) {
          if (findNode(page.layout, splitId)) {
            this.updatePageLayout(page.id, resizeSplit(page.layout, splitId, ratio));
            break;
          }
        }
        this.syncToReact();
      },
    });

    // Set up edge split manager
    this.edgeSplitManager = new EdgeSplitManager(container, {
      onEdgeSplit: (cellId, direction, ratio, reversed) => {
        this.split(direction, cellId, ratio, reversed);
      },
    });

    // Global keyboard handlers
    container.addEventListener('keydown', (e) => this.handleKeyDown(e));
    container.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
  }

  update(doc: DocumentTree): void {
    if (!this.container || !this.cellPool || !this.reconciler) return;

    // Destroy old subsystems first
    this.reconciler.destroy();
    this.cellPool.destroy();

    // Recreate navigation controller
    this.navigationController = new NavigationController(null as any, {
      onActiveCellChange: (cellId) => this.setActiveCell(cellId),
    });

    // Recreate pool
    this.cellPool = new CellPool({
      kernelFactory: this.kernelFactory!,
      onContentChange: (cellId: string) => {
        this.debouncedSync();
        this.emitToolbarUpdate();
        this.checkLastCellOverflow(cellId);
      },
      onSelectionChange: (_cellId: string) => {
        this.emitToolbarUpdate();
      },
      navigationController: this.navigationController,
    });

    (this.navigationController as any).cellPool = this.cellPool;

    // Rebuild reconciler with new pool
    this.reconciler = new LayoutReconciler(this.cellPool, {
      onCellClick: (cellId, e) => this.handleCellClick(cellId, e),
      onCellDblClick: (cellId, _e) => this.handleCellDblClick(cellId),
    });

    const blocks = assignBlockIds(doc.blocks);
    this.pages = [createPage(blocks)];
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;
    this.activeCellId = null;

    this.reconciler.reconcilePages(this.container, this.pages);
    this.navigationController.rebuildSequence(this.pages);

    // Distribute across pages if content exceeds first page
    setTimeout(() => {
      const leaves = getAllLeaves(this.pages[0].layout);
      const lastLeafId = leaves[leaves.length - 1]?.id;
      if (lastLeafId) {
        this.distributeOverflowToPages(lastLeafId);
      }
    }, 200);
  }

  destroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.overflowCheckTimer) clearTimeout(this.overflowCheckTimer);
    this.resizeManager?.destroy();
    this.edgeSplitManager?.destroy();
    this.reconciler?.destroy();
    this.cellPool?.destroy();
    this.onChangeCallbacks = [];
    this.onToolbarUpdateCallbacks = [];
    this.container = null;
  }

  // =====================
  //  CALLBACKS
  // =====================

  onChange(callback: OnLayoutChangeCallback): void {
    this.onChangeCallbacks.push(callback);
  }

  onToolbarUpdate(callback: () => void): void {
    this.onToolbarUpdateCallbacks.push(callback);
  }

  // =====================
  //  LAYOUT OPERATIONS
  // =====================

  /**
   * Split a cell.
   * @param splitContent - If true AND direction is horizontal, split the text at the divider.
   *   Only used by context-menu "Split Horizontal". Edge-drags always pass false.
   */
  split(direction: SplitDirection, cellId?: string, ratio = 0.5, reversed = false, splitContent = false): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId || !this.reconciler || !this.cellPool) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    // Check if source cell has content (for content-aware horizontal split at cursor)
    const sourceCell = this.cellPool.get(targetId);
    const shouldSplitContent = splitContent && direction === 'horizontal'
      && sourceCell && !sourceCell.isEmpty();

    // Split content at cursor BEFORE the tree split (while PM editor is still full-size)
    let cursorOverflow: Block[] = [];
    if (shouldSplitContent) {
      cursorOverflow = sourceCell.splitAtCursor();
    }

    const { tree: newLayout, newCellId } = splitCell(page.layout, targetId, direction, ratio, reversed);
    this.updatePageLayout(page.id, newLayout);

    this.reconciler.reconcilePages(this.container!, this.pages);

    // Move the content after cursor into the new cell
    if (cursorOverflow.length > 0) {
      const newCell = this.cellPool.get(newCellId);
      if (newCell) {
        newCell.setContent(cursorOverflow);
      }
    }

    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  merge(cellId?: string): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId || !this.cellPool || !this.reconciler) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    const parent = findParent(page.layout, targetId);
    if (!parent) return;

    // Collect ALL content from both subtrees in reading order
    const firstLeaves = getAllLeaves(parent.first);
    const secondLeaves = getAllLeaves(parent.second);
    const allContent: Block[] = [];

    for (const leaf of [...firstLeaves, ...secondLeaves]) {
      const cell = this.cellPool.get(leaf.id);
      if (cell) {
        allContent.push(...cell.drainAll());
      }
    }

    // Collapse split into single leaf
    this.updatePageLayout(page.id, mergeCells(page.layout, parent.id));

    // Reconcile
    this.reconciler.reconcilePages(this.container!, this.pages);

    // Populate merged cell with collected content
    const mergedLeaves = getAllLeaves(this.pages.find(p => p.id === page.id)!.layout);
    const mergedCell = this.cellPool.get(mergedLeaves[0]?.id ?? '');
    if (mergedCell && allContent.length > 0) {
      mergedCell.appendBlocks(allContent);
    }

    this.activeCellId = mergedCell?.id ?? null;
    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  getLayout(): LayoutNode {
    return this.layout;
  }

  getPages(): Page[] {
    return this.pages;
  }

  getActiveCellId(): string | null {
    return this.activeCellId;
  }

  getActivePageId(): string | null {
    return this.activePageId;
  }

  // =====================
  //  TOOLBAR COMMANDS
  // =====================

  applyMark(markType: string, attrs?: Record<string, unknown>): void {
    this.getActiveKernel()?.toggleMark(markType, attrs);
  }

  getActiveMarks(): TextMark[] {
    return this.getActiveKernel()?.getActiveMarks() ?? [];
  }

  setTextAlign(align: string): void {
    this.getActiveKernel()?.setTextAlign(align);
  }

  getTextAlign(): string {
    return this.getActiveKernel()?.getTextAlign() ?? 'left';
  }

  setFontFamily(family: string): void {
    this.getActiveKernel()?.setFontFamily(family);
  }

  setFontSize(size: string): void {
    this.getActiveKernel()?.setFontSize(size);
  }

  insertLink(href: string, title?: string): void {
    this.getActiveKernel()?.insertLink(href, title);
  }

  removeLink(): void {
    this.getActiveKernel()?.removeLink();
  }

  getActiveBlockType(): string | null {
    const kernel = this.getActiveKernel();
    if (!kernel) return null;
    const info = kernel.getCurrentBlockType();
    if (!info) return null;
    if (info.type === 'heading') return `heading:${info.level}`;
    return info.type;
  }

  setBlockType(type: string): void {
    this.getActiveKernel()?.setBlockType(type);
  }

  insertBlock(block: Block): void {
    // Insert into the active cell's PM editor
    // For now, images/tables are inserted as blocks at the end
    if (!this.activeCellId || !this.cellPool) return;

    const cell = this.cellPool.get(this.activeCellId);
    if (!cell) return;

    const currentBlocks = cell.getContent();
    const newBlock = { ...block, id: generateBlockId() };
    cell.setContent([...currentBlocks, newBlock]);
    this.syncToReact();
  }

  insertTable(rows: number, cols: number): void {
    const emptyCell = () => ({ content: [] });
    this.insertBlock({
      type: 'table',
      headers: Array.from({ length: cols }, emptyCell),
      rows: Array.from({ length: rows - 1 }, () =>
        Array.from({ length: cols }, emptyCell)
      ),
    });
  }

  insertImage(src: string, alt?: string): void {
    this.insertBlock({ type: 'image', src, alt });
  }

  deleteSelectedBlocks(): void {
    // In one-PM-per-cell, delete is handled by PM natively (backspace/delete keys)
    // This method can be used for explicit block deletion from toolbar
  }

  undo(): void {
    this.getActiveKernel()?.undo();
  }

  redo(): void {
    this.getActiveKernel()?.redo();
  }

  getSelectedBlockIds(): string[] {
    return [];
  }

  getFocusedBlockId(): string | null {
    return null;
  }

  // =====================
  //  EVENT HANDLERS
  // =====================

  private handleCellClick(cellId: string, _e: MouseEvent): void {
    this.setActiveCell(cellId);

    // Focus the cell's editor — PM handles click-to-cursor natively
    const cell = this.cellPool?.get(cellId);
    if (cell) {
      cell.focus();
      this.emitToolbarUpdate();
    }
  }

  private handleCellDblClick(cellId: string): void {
    this.setActiveCell(cellId);
    const cell = this.cellPool?.get(cellId);
    cell?.focus();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      this.redo();
      return;
    }
  }

  private handleContextMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const cellEl = target.closest('.bsp-cell') as HTMLElement;
    if (!cellEl) return;

    const cellId = cellEl.dataset.cellId;
    if (!cellId) return;

    e.preventDefault();
    this.showContextMenu(e.clientX, e.clientY, cellId);
  }

  // =====================
  //  CONTEXT MENU
  // =====================

  private contextMenuEl: HTMLElement | null = null;

  private showContextMenu(x: number, y: number, cellId: string): void {
    this.hideContextMenu();

    const menu = document.createElement('div');
    menu.classList.add('bsp-context-menu');
    menu.style.position = 'fixed';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.zIndex = '10000';

    type MenuItem = {
      label: string;
      action: () => void;
      separator?: boolean;
      hoverTarget?: string;       // cellId to highlight on hover
      hoverPosition?: 'top' | 'bottom'; // where the insert indicator shows
    };

    const items: MenuItem[] = [
      { label: 'Split Horizontal', action: () => this.split('horizontal', cellId, 0.5, false, true) },
      { label: 'Split Vertical', action: () => this.split('vertical', cellId) },
    ];

    const page = getPageForCell(this.pages, cellId);
    const cell = this.cellPool?.get(cellId);

    if (page) {
      const parent = findParent(page.layout, cellId);
      const neighbors = this.findSpatialNeighbors(page, cellId);

      // --- Overflow options (only when cell has overflow) ---
      if (cell?.hasOverflow()) {
        items.push({ label: '', action: () => {}, separator: true });

        if (neighbors.right) {
          items.push({
            label: 'Overflow → Right',
            action: () => this.overflowTo(cellId, neighbors.right!, 'right'),
            hoverTarget: neighbors.right,
            hoverPosition: 'top',
          });
        }
        if (neighbors.down) {
          items.push({
            label: 'Overflow → Down',
            action: () => this.overflowTo(cellId, neighbors.down!, 'down'),
            hoverTarget: neighbors.down,
            hoverPosition: 'top',
          });
        }
        if (neighbors.left) {
          items.push({
            label: 'Overflow → Left',
            action: () => this.overflowTo(cellId, neighbors.left!, 'left'),
            hoverTarget: neighbors.left,
            hoverPosition: 'bottom',
          });
        }
        if (neighbors.up) {
          items.push({
            label: 'Overflow → Up',
            action: () => this.overflowTo(cellId, neighbors.up!, 'up'),
            hoverTarget: neighbors.up,
            hoverPosition: 'bottom',
          });
        }

        items.push({
          label: 'Overflow → New Pages Below',
          action: () => this.overflowToNewPages(cellId),
        });
      }

      // --- Merge options ---
      if (neighbors.up || neighbors.down || neighbors.left || neighbors.right) {
        items.push({ label: '', action: () => {}, separator: true });
      }
      if (neighbors.up) {
        items.push({ label: 'Merge Up', action: () => this.spatialMerge(cellId, neighbors.up!) });
      }
      if (neighbors.down) {
        items.push({ label: 'Merge Down', action: () => this.spatialMerge(cellId, neighbors.down!) });
      }
      if (neighbors.left) {
        items.push({ label: 'Merge Left', action: () => this.spatialMerge(cellId, neighbors.left!) });
      }
      if (neighbors.right) {
        items.push({ label: 'Merge Right', action: () => this.spatialMerge(cellId, neighbors.right!) });
      }

      // --- Delete Cell ---
      if (parent) {
        items.push({ label: 'Delete Cell', action: () => this.deleteCell(cellId) });
      }
    }

    items.push({ label: 'Add Page After', action: () => {
      if (page) {
        const newPage = createPage();
        this.pages = addPageAfter(this.pages, page.id, newPage);
        this.reconciler?.reconcilePages(this.container!, this.pages);
        this.syncToReact();
      }
    }});

    // --- Render menu items ---
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.classList.add('bsp-context-menu-separator');
        menu.appendChild(sep);
        continue;
      }

      const btn = document.createElement('button');
      btn.classList.add('bsp-context-menu-item');
      btn.textContent = item.label;

      btn.addEventListener('click', () => {
        this.clearOverflowHighlight();
        item.action();
        this.hideContextMenu();
      });

      // Hover feedback: highlight target cell
      if (item.hoverTarget) {
        const targetId = item.hoverTarget;
        const position = item.hoverPosition ?? 'top';

        btn.addEventListener('mouseenter', () => {
          const targetCell = this.cellPool?.get(targetId);
          if (targetCell) {
            targetCell.element.classList.add('bsp-cell--overflow-target');
            targetCell.element.dataset.overflowPosition = position;
          }
        });

        btn.addEventListener('mouseleave', () => {
          this.clearOverflowHighlight();
        });
      }

      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    this.contextMenuEl = menu;

    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.clearOverflowHighlight();
        this.hideContextMenu();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', closeHandler);
    });
  }

  private clearOverflowHighlight(): void {
    document.querySelectorAll('.bsp-cell--overflow-target').forEach(el => {
      el.classList.remove('bsp-cell--overflow-target');
      delete (el as HTMLElement).dataset.overflowPosition;
    });
  }

  // =====================
  //  SPATIAL NEIGHBORS
  // =====================

  private findSpatialNeighbors(page: Page, cellId: string): {
    up: string | null; down: string | null; left: string | null; right: string | null;
  } {
    const result = { up: null as string | null, down: null as string | null, left: null as string | null, right: null as string | null };

    const cell = this.cellPool?.get(cellId);
    if (!cell) return result;

    const cellRect = cell.element.getBoundingClientRect();
    const EDGE_TOLERANCE = 8;
    const OVERLAP_MIN = 10;

    const leaves = getAllLeaves(page.layout);
    for (const leaf of leaves) {
      if (leaf.id === cellId) continue;
      const neighbor = this.cellPool?.get(leaf.id);
      if (!neighbor) continue;

      if (!this.shareParentSplit(page.layout, cellId, leaf.id)) continue;

      const nr = neighbor.element.getBoundingClientRect();
      const hOverlap = Math.min(cellRect.right, nr.right) - Math.max(cellRect.left, nr.left);
      const vOverlap = Math.min(cellRect.bottom, nr.bottom) - Math.max(cellRect.top, nr.top);

      if (hOverlap > OVERLAP_MIN && Math.abs(nr.bottom - cellRect.top) < EDGE_TOLERANCE) result.up = leaf.id;
      if (hOverlap > OVERLAP_MIN && Math.abs(nr.top - cellRect.bottom) < EDGE_TOLERANCE) result.down = leaf.id;
      if (vOverlap > OVERLAP_MIN && Math.abs(nr.right - cellRect.left) < EDGE_TOLERANCE) result.left = leaf.id;
      if (vOverlap > OVERLAP_MIN && Math.abs(nr.left - cellRect.right) < EDGE_TOLERANCE) result.right = leaf.id;
    }

    return result;
  }

  private shareParentSplit(root: LayoutNode, cellA: string, cellB: string): boolean {
    const lca = this.findLCA(root, cellA, cellB);
    return lca !== null && lca.type === 'split';
  }

  private findLCA(node: LayoutNode, a: string, b: string): LayoutNode | null {
    if (node.type === 'leaf') return node.id === a || node.id === b ? node : null;
    const inFirst = findNode(node.first, a) !== null;
    const inSecond = findNode(node.second, b) !== null;
    if (inFirst && inSecond) return node;
    const inFirstB = findNode(node.first, b) !== null;
    const inSecondA = findNode(node.second, a) !== null;
    if (inSecondA && inFirstB) return node;
    if (inFirst || inFirstB) return this.findLCA(node.first, a, b);
    if (inSecond || inSecondA) return this.findLCA(node.second, a, b);
    return null;
  }

  // =====================
  //  SPATIAL MERGE
  // =====================

  private spatialMerge(cellIdA: string, cellIdB: string): void {
    if (!this.cellPool || !this.reconciler) return;

    const page = getPageForCell(this.pages, cellIdA);
    if (!page) return;

    const lca = this.findLCA(page.layout, cellIdA, cellIdB);
    if (!lca || lca.type !== 'split') return;

    const firstLeaves = getAllLeaves(lca.first);
    const secondLeaves = getAllLeaves(lca.second);
    const allContent: Block[] = [];

    for (const leaf of [...firstLeaves, ...secondLeaves]) {
      const cell = this.cellPool.get(leaf.id);
      if (cell) allContent.push(...cell.drainAll());
    }

    this.updatePageLayout(page.id, mergeCells(page.layout, lca.id));
    this.reconciler.reconcilePages(this.container!, this.pages);

    const mergedLeaves = getAllLeaves(this.pages.find(p => p.id === page.id)!.layout);
    const mergedCell = this.cellPool.get(mergedLeaves.find(l =>
      this.cellPool!.get(l.id) !== undefined
    )?.id ?? '');

    if (mergedCell && allContent.length > 0) {
      mergedCell.appendBlocks(allContent);
    }

    this.activeCellId = mergedCell?.id ?? null;
    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  // =====================
  //  DELETE CELL
  // =====================

  deleteCell(cellId: string): void {
    if (!this.cellPool || !this.reconciler) return;

    const page = getPageForCell(this.pages, cellId);
    if (!page) return;

    const parent = findParent(page.layout, cellId);
    if (!parent) return;

    const isFirst = findNode(parent.first, cellId) !== null;
    const survivorSubtree = isFirst ? parent.second : parent.first;
    const deletedSubtree = isFirst ? parent.first : parent.second;

    const deletedLeaves = getAllLeaves(deletedSubtree);
    const deletedContent: Block[] = [];
    for (const leaf of deletedLeaves) {
      const cell = this.cellPool.get(leaf.id);
      if (cell) deletedContent.push(...cell.drainAll());
    }

    this.updatePageLayout(page.id, mergeCells(page.layout, parent.id));
    this.reconciler.reconcilePages(this.container!, this.pages);

    if (deletedContent.length > 0) {
      const survivorLeaves = getAllLeaves(
        findNode(this.pages.find(p => p.id === page.id)!.layout, survivorSubtree.id)
          ?? this.pages.find(p => p.id === page.id)!.layout
      );
      const firstSurvivor = survivorLeaves[0];
      if (firstSurvivor) {
        const survivorCell = this.cellPool.get(firstSurvivor.id);
        survivorCell?.appendBlocks(deletedContent);
      }
    }

    const remainingLeaves = getAllLeaves(this.pages.find(p => p.id === page.id)!.layout);
    this.activeCellId = remainingLeaves[0]?.id ?? null;
    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  // =====================
  //  USER-INITIATED OVERFLOW
  // =====================

  /**
   * Move overflow content from source cell to a neighbor cell.
   * Direction determines insert position:
   *   right/down → prepend (overflow goes BEFORE target's content)
   *   left/up    → append  (overflow goes AFTER target's content)
   */
  overflowTo(sourceCellId: string, targetCellId: string, direction: 'up' | 'down' | 'left' | 'right'): void {
    if (!this.cellPool) return;

    const sourceCell = this.cellPool.get(sourceCellId);
    const targetCell = this.cellPool.get(targetCellId);
    if (!sourceCell || !targetCell) return;

    // Split the source PM doc at the visible height — returns overflow blocks
    const maxHeight = sourceCell.contentElement.clientHeight;
    const overflowBlocks = sourceCell.splitOverflow(maxHeight);
    if (overflowBlocks.length === 0) return;

    // Insert into target based on direction
    if (direction === 'right' || direction === 'down') {
      targetCell.prependBlocks(overflowBlocks);
    } else {
      targetCell.appendBlocks(overflowBlocks);
    }

    this.syncToReact();
  }

  /**
   * Move overflow content from source cell to new pages inserted
   * after the current page. Chain-splits until everything fits.
   */
  overflowToNewPages(sourceCellId: string): void {
    if (!this.cellPool || !this.reconciler || !this.container) return;

    const sourceCell = this.cellPool.get(sourceCellId);
    if (!sourceCell) return;

    const page = getPageForCell(this.pages, sourceCellId);
    if (!page) return;

    // Reset scroll for accurate measurement
    sourceCell.contentElement.scrollTop = 0;

    const maxHeight = sourceCell.contentElement.clientHeight;
    let remaining = sourceCell.splitOverflow(maxHeight);
    if (remaining.length === 0) return;

    // Find the index of the current page to insert after it
    let insertAfterPageId = page.id;

    while (remaining.length > 0) {
      const newPage = createPage(remaining);
      this.pages = addPageAfter(this.pages, insertAfterPageId, newPage);
      insertAfterPageId = newPage.id; // next overflow page goes after this one

      this.reconciler.reconcilePages(this.container, this.pages);

      // Check if new page overflows
      const newPageLeaves = getAllLeaves(newPage.layout);
      const newCell = this.cellPool.get(newPageLeaves[0]?.id ?? '');
      if (!newCell) break;

      newCell.contentElement.scrollTop = 0;

      if (!newCell.hasOverflow()) break;

      const newMaxHeight = newCell.contentElement.clientHeight;
      remaining = newCell.splitOverflow(newMaxHeight);
      if (remaining.length === 0) break;
    }

    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  private hideContextMenu(): void {
    if (this.contextMenuEl) {
      this.contextMenuEl.remove();
      this.contextMenuEl = null;
    }
  }

  // =====================
  //  INTERNAL
  // =====================

  private setActiveCell(cellId: string): void {
    if (this.activeCellId && this.activeCellId !== cellId) {
      const prevCell = this.cellPool?.get(this.activeCellId);
      prevCell?.setActive(false);
    }

    this.activeCellId = cellId;
    this.activePageId = this.reconciler?.getPageIdForCell(cellId) ?? null;

    const cell = this.cellPool?.get(cellId);
    cell?.setActive(true);
  }

  private getActiveKernel(): ITextKernel | null {
    if (!this.activeCellId || !this.cellPool) return null;
    const cell = this.cellPool.get(this.activeCellId);
    return cell?.getKernel() ?? null;
  }

  private updatePageLayout(pageId: string, newLayout: LayoutNode): void {
    this.pages = this.pages.map(p =>
      p.id === pageId ? { ...p, layout: newLayout } : p
    );
  }

  private emitToolbarUpdate(): void {
    for (const cb of this.onToolbarUpdateCallbacks) cb();
  }

  // =====================
  //  PASTE-TIME PAGE CREATION
  // =====================

  private overflowCheckTimer: ReturnType<typeof setTimeout> | null = null;

  private checkLastCellOverflow(cellId: string): void {
    if (this.overflowCheckTimer) clearTimeout(this.overflowCheckTimer);
    this.overflowCheckTimer = setTimeout(() => {
      this.distributeOverflowToPages(cellId);
    }, 100);
  }

  /**
   * Overflow distribution using PM doc splitting.
   * No normalizeBlocks, no block-level measurement, no safety margins.
   * PM's coordsAtPos gives pixel-accurate split positions.
   */
  private distributeOverflowToPages(cellId: string): void {
    if (!this.cellPool || !this.reconciler || !this.container) return;

    // Only trigger for the last cell on the last page
    const lastPage = this.pages[this.pages.length - 1];
    if (!lastPage) return;

    const lastPageLeaves = getAllLeaves(lastPage.layout);
    const lastCellId = lastPageLeaves[lastPageLeaves.length - 1]?.id;
    if (cellId !== lastCellId) return;

    const cell = this.cellPool.get(cellId);
    if (!cell) return;

    // Reset scroll before measuring
    cell.contentElement.scrollTop = 0;

    if (!cell.hasOverflow()) return;

    // Split the PM document at the cell's visible height
    const maxHeight = cell.contentElement.clientHeight;
    const overflowBlocks = cell.splitOverflow(maxHeight);
    if (overflowBlocks.length === 0) return;

    // Create new pages with overflow content
    let remaining = overflowBlocks;

    while (remaining.length > 0) {
      const newPage = createPage(remaining);
      this.pages = addPageAfter(this.pages, this.pages[this.pages.length - 1].id, newPage);

      // Reconcile to render the new page
      this.reconciler.reconcilePages(this.container, this.pages);

      // Check if the new page's cell overflows too
      const newPageLeaves = getAllLeaves(newPage.layout);
      const newCell = this.cellPool.get(newPageLeaves[0]?.id ?? '');
      if (!newCell) break;

      newCell.contentElement.scrollTop = 0;

      if (!newCell.hasOverflow()) break;

      // Still overflows — split again
      const newMaxHeight = newCell.contentElement.clientHeight;
      remaining = newCell.splitOverflow(newMaxHeight);
      if (remaining.length === 0) break;
    }

    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  private debouncedSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncToReact();
    }, this.config.debounceMs);
  }

  private syncToReact(): void {
    if (!this.cellPool) return;

    const allBlocks: Block[] = [];
    for (const page of this.pages) {
      const leaves = getAllLeaves(page.layout);
      for (const leaf of leaves) {
        const cell = this.cellPool.get(leaf.id);
        if (cell) {
          allBlocks.push(...cell.getContent());
        } else {
          allBlocks.push(...leaf.blocks);
        }
      }
    }

    const tree: DocumentTree = {
      blocks: allBlocks,
      metadata: {
        ...this.metadata,
        modifiedAt: new Date().toISOString(),
      },
    };

    for (const cb of this.onChangeCallbacks) {
      cb(tree, this.layout);
    }
  }
}
