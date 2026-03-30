// ============================================================================
// LayoutDirector — BSP Layout Orchestrator (No-Flow Architecture)
//
// Each cell owns its content independently. No overflow, no flow, no stream.
// Content stays where the user puts it. Cells scroll when content exceeds
// their bounds. The user is the layout engine.
//
// Delegates to:
//   - CellPool: persistent cell instances
//   - LayoutReconciler: diff-based DOM updates
//   - SplitResizeManager: drag resize handles
//   - EdgeSplitManager: edge-pull-to-split
// ============================================================================

import type { Block, DocumentTree, TextMark } from '../model/DocumentTree';
import type { ITextKernel } from '../engine/types';
import type { BlockNode } from '../engine/BlockNode';
import { generateBlockId, assignBlockIds } from '../engine/BlockId';
import { CellPool } from './CellPool';
import { LayoutReconciler } from './LayoutReconciler';
import { SplitResizeManager } from './SplitResizeManager';
import { EdgeSplitManager } from './EdgeSplitManager';
import { OverflowDetector } from './OverflowDetector';
import { NavigationController } from './NavigationController';
import {
  type LayoutNode,
  type LeafNode,
  type SplitDirection,
  createDefaultLayout,
  splitCell,
  mergeCells,
  resizeSplit,
  findNode,
  findParent,
  getAllLeaves,
  insertBlockInCell,
  removeBlockFromCell,
  updateLeafBlocks,
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
  private focusedBlockId: string | null = null;

  // Subsystems
  private cellPool: CellPool | null = null;
  private reconciler: LayoutReconciler | null = null;
  private resizeManager: SplitResizeManager | null = null;
  private edgeSplitManager: EdgeSplitManager | null = null;

  private overflowDetector = new OverflowDetector();
  private navigationController: NavigationController | null = null;

  // Kernel factory — injected by consumer
  private kernelFactory: ((node: BlockNode, el: HTMLElement, block: Block) => ITextKernel) | null = null;

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

  setKernelFactory(factory: (node: BlockNode, el: HTMLElement, block: Block) => ITextKernel): void {
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

    // Create navigation controller (cross-block keyboard movement)
    this.navigationController = new NavigationController(
      null as any, // pool not created yet — will be set below
      {
        onActiveCellChange: (cellId) => this.setActiveCell(cellId),
        onFocusedBlockChange: (blockId) => { this.focusedBlockId = blockId; this.emitToolbarUpdate(); },
        onBlockCreated: (cellId, block) => {
          const page = getPageForCell(this.pages, cellId);
          if (page) {
            this.updatePageLayout(page.id, insertBlockInCell(page.layout, cellId, block));
          }
          this.debouncedSync();
        },
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

    // After initial render, check if content exceeds the first page
    // and distribute across pages if needed (for file open / large documents)
    requestAnimationFrame(() => {
      const leaves = getAllLeaves(this.pages[0].layout);
      const lastLeafId = leaves[leaves.length - 1]?.id;
      if (lastLeafId) {
        this.distributeOverflowToPages(lastLeafId);
      }
    });

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
      onEdgeSplit: (cellId, direction, ratio) => {
        this.split(direction, cellId, ratio);
      },
    });

    // Global keyboard handlers
    container.addEventListener('keydown', (e) => this.handleKeyDown(e));
    container.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
  }

  update(doc: DocumentTree): void {
    if (!this.container || !this.cellPool || !this.reconciler) return;

    // Destroy old subsystems first (removes orphan DOM elements)
    this.reconciler.destroy();
    this.cellPool.destroy();

    // Recreate navigation controller
    this.navigationController = new NavigationController(null as any, {
      onActiveCellChange: (cellId) => this.setActiveCell(cellId),
      onFocusedBlockChange: (blockId) => { this.focusedBlockId = blockId; this.emitToolbarUpdate(); },
      onBlockCreated: (cellId, block) => {
        const page = getPageForCell(this.pages, cellId);
        if (page) {
          this.updatePageLayout(page.id, insertBlockInCell(page.layout, cellId, block));
        }
        this.debouncedSync();
      },
    });

    // Recreate pool (factory references are preserved)
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
    this.focusedBlockId = null;

    this.reconciler.reconcilePages(this.container, this.pages);
    this.navigationController.rebuildSequence(this.pages);

    // Distribute across pages if content exceeds first page
    requestAnimationFrame(() => {
      const leaves = getAllLeaves(this.pages[0].layout);
      const lastLeafId = leaves[leaves.length - 1]?.id;
      if (lastLeafId) {
        this.distributeOverflowToPages(lastLeafId);
      }
    });
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
   * Split a cell. The original cell SURVIVES (keeps its ID, DOM, ProseMirror).
   * Only a new empty sibling cell is created.
   */
  split(direction: SplitDirection, cellId?: string, ratio = 0.5): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId || !this.reconciler) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    const { tree: newLayout } = splitCell(page.layout, targetId, direction, ratio);
    this.updatePageLayout(page.id, newLayout);

    this.reconciler.reconcilePages(this.container!, this.pages);
    this.navigationController?.rebuildSequence(this.pages);
    this.syncToReact();
  }

  /** Merge a cell with its sibling. Content concatenated in reading order. */
  merge(cellId?: string): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId || !this.cellPool || !this.reconciler) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    const parent = findParent(page.layout, targetId);
    if (!parent) return;

    // Collect ALL content from both subtrees in reading order (Z-pattern)
    const firstLeaves = getAllLeaves(parent.first);
    const secondLeaves = getAllLeaves(parent.second);
    const allContent: Block[] = [];

    // Reading order: first subtree leaves, then second subtree leaves
    for (const leaf of [...firstLeaves, ...secondLeaves]) {
      const cell = this.cellPool.get(leaf.id);
      if (cell) {
        allContent.push(...cell.drainAll());
      }
    }

    // The survivor is always the first leaf (reading order preserved)
    const survivorId = firstLeaves[0]?.id;
    if (!survivorId) return;

    // Update tree structure (collapse the split into a single leaf)
    this.updatePageLayout(page.id, mergeCells(page.layout, parent.id));

    // Reconcile first — this creates the merged leaf cell
    this.reconciler.reconcilePages(this.container!, this.pages);

    // Now find the merged cell and populate it with all collected content
    const mergedLeaves = getAllLeaves(this.pages.find(p => p.id === page.id)!.layout);
    const mergedCell = this.cellPool.get(mergedLeaves[0]?.id ?? '');
    if (mergedCell && allContent.length > 0) {
      mergedCell.appendBlocks(allContent);
    }

    this.activeCellId = mergedCell?.id ?? null;
    this.focusedBlockId = null;
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
    const node = this.getFocusedBlockNode();
    if (!node) return null;
    const data = node.getData();
    if (data.type === 'heading') return `heading:${data.level}`;
    return data.type;
  }

  setBlockType(type: string): void {
    const node = this.getFocusedBlockNode();
    if (!node || !this.activeCellId) return;

    const cell = this.cellPool?.get(this.activeCellId);
    if (!cell) return;

    const data = node.getData();
    if (data.type !== 'paragraph' && data.type !== 'heading') return;

    const content = data.content;
    const alignment = data.alignment;
    let newBlock: Block;

    if (type === 'paragraph') {
      newBlock = { type: 'paragraph', content, alignment, id: data.id, containerStyle: data.containerStyle };
    } else if (type.startsWith('heading:')) {
      const level = parseInt(type.split(':')[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      newBlock = { type: 'heading', level, content, alignment, id: data.id, containerStyle: data.containerStyle };
    } else {
      return;
    }

    // Update the tree (for serialization) and re-render just this cell
    const page = getPageForCell(this.pages, this.activeCellId);
    if (!page) return;

    const leaf = findNode(page.layout, this.activeCellId) as LeafNode | null;
    if (!leaf || leaf.type !== 'leaf') return;

    const blockIndex = leaf.blocks.findIndex(b => b.id === data.id);
    if (blockIndex === -1) return;

    const newBlocks = [...leaf.blocks];
    newBlocks[blockIndex] = newBlock;
    this.updatePageLayout(page.id, updateLeafBlocks(page.layout, this.activeCellId, newBlocks));

    // Remove old block and insert new one at same position in the live cell
    cell.removeBlock(data.id!);
    const newNode = cell.addBlock(newBlock, blockIndex);
    this.syncToReact();

    // Focus the new block
    requestAnimationFrame(() => {
      if (newNode.isEditable() && newNode.kernel) {
        this.focusedBlockId = newNode.id;
        newNode.kernel.focus();
        this.emitToolbarUpdate();
      }
    });
  }

  insertBlock(block: Block): void {
    if (!this.cellPool) return;

    if (!this.activeCellId) {
      if (this.pages.length === 0) return;
      const leaves = getAllLeaves(this.pages[0].layout);
      if (leaves.length === 0) return;
      this.activeCellId = leaves[0].id;
    }

    const cell = this.cellPool.get(this.activeCellId);
    if (!cell) return;

    const newBlock = { ...block, id: generateBlockId() };
    cell.addBlock(newBlock);

    // Update tree for serialization
    const page = getPageForCell(this.pages, this.activeCellId);
    if (page) {
      this.updatePageLayout(page.id, insertBlockInCell(page.layout, this.activeCellId, newBlock));
    }

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
    if (!this.activeCellId || !this.focusedBlockId || !this.cellPool) return;

    const cell = this.cellPool.get(this.activeCellId);
    if (!cell) return;

    cell.removeBlock(this.focusedBlockId);

    const page = getPageForCell(this.pages, this.activeCellId);
    if (page) {
      this.updatePageLayout(page.id, removeBlockFromCell(page.layout, this.activeCellId, this.focusedBlockId));
    }

    this.focusedBlockId = null;
    this.syncToReact();
  }

  undo(): void {
    this.getActiveKernel()?.undo();
  }

  redo(): void {
    this.getActiveKernel()?.redo();
  }

  getSelectedBlockIds(): string[] {
    return this.focusedBlockId ? [this.focusedBlockId] : [];
  }

  getFocusedBlockId(): string | null {
    return this.focusedBlockId;
  }

  // =====================
  //  EVENT HANDLERS
  // =====================

  private handleCellClick(cellId: string, e: MouseEvent): void {
    this.setActiveCell(cellId);

    const target = e.target as HTMLElement;
    const blockEl = target.closest('[data-block-id]') as HTMLElement;

    if (blockEl) {
      const blockId = blockEl.dataset.blockId!;
      const registry = this.cellPool?.getRegistry();
      const node = registry?.get(blockId);
      if (node?.isEditable() && node.kernel) {
        this.focusedBlockId = blockId;
        node.kernel.focus();
        this.emitToolbarUpdate();
        return;
      }
      this.focusedBlockId = blockId;
      this.emitToolbarUpdate();
      return;
    }

    // Clicked empty area of cell — ensure editable and focus
    this.autoFocusInCell(cellId);
    this.emitToolbarUpdate();
  }

  private handleCellDblClick(cellId: string): void {
    this.setActiveCell(cellId);
    this.autoFocusInCell(cellId);
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

    const items: { label: string; action: () => void }[] = [
      { label: 'Split Horizontal', action: () => this.split('horizontal', cellId) },
      { label: 'Split Vertical', action: () => this.split('vertical', cellId) },
    ];

    const page = getPageForCell(this.pages, cellId);
    if (page) {
      const parent = findParent(page.layout, cellId);
      if (parent) {
        items.push({ label: 'Merge with Sibling', action: () => this.merge(cellId) });
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

    for (const item of items) {
      const btn = document.createElement('button');
      btn.classList.add('bsp-context-menu-item');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        item.action();
        this.hideContextMenu();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    this.contextMenuEl = menu;

    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.hideContextMenu();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', closeHandler);
    });
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
      this.focusedBlockId = null;
    }

    this.activeCellId = cellId;
    this.activePageId = this.reconciler?.getPageIdForCell(cellId) ?? null;

    const cell = this.cellPool?.get(cellId);
    cell?.setActive(true);
  }

  /**
   * Ensure a cell has at least one editable block and focus it.
   * This is a LOCAL operation — no global render, no sync race conditions.
   */
  private autoFocusInCell(cellId: string): void {
    const cell = this.cellPool?.get(cellId);
    if (!cell) return;

    if (cell.isEmpty()) {
      const newBlock = cell.ensureEditable();
      this.focusedBlockId = newBlock.id;

      // Update tree for serialization
      const page = getPageForCell(this.pages, cellId);
      if (page) {
        const blockData: Block = { type: 'paragraph', content: [], id: newBlock.id };
        this.updatePageLayout(page.id, insertBlockInCell(page.layout, cellId, blockData));
      }

      requestAnimationFrame(() => {
        if (newBlock.kernel) {
          newBlock.kernel.focus();
        }
      });
      return;
    }

    // Focus the last editable block
    const focused = cell.focusLastEditable();
    if (focused) {
      this.focusedBlockId = focused.id;
    } else if (cell.blockCount() > 0) {
      this.focusedBlockId = cell.getBlockNodes()[0].id;
    }
  }

  private getActiveKernel(): ITextKernel | null {
    if (!this.focusedBlockId || !this.cellPool) return null;
    const registry = this.cellPool.getRegistry();
    const node = registry.get(this.focusedBlockId);
    return node?.kernel ?? null;
  }

  private getFocusedBlockNode(): BlockNode | null {
    if (!this.focusedBlockId || !this.cellPool) return null;
    return this.cellPool.getRegistry().get(this.focusedBlockId) ?? null;
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

  /**
   * Check if a cell is the last cell on the last page and overflows.
   * If so, distribute overflow content across new pages.
   * Debounced to let ProseMirror finish processing paste.
   */
  private checkLastCellOverflow(cellId: string): void {
    if (this.overflowCheckTimer) clearTimeout(this.overflowCheckTimer);
    this.overflowCheckTimer = setTimeout(() => {
      this.distributeOverflowToPages(cellId);
    }, 100);
  }

  /**
   * One-shot overflow distribution: if the last cell on the last page
   * overflows, trim excess blocks and create new pages to hold them.
   * After this, content is fully manual — no ongoing monitoring.
   */
  private distributeOverflowToPages(cellId: string): void {
    if (!this.cellPool || !this.reconciler || !this.container) return;

    // Only trigger for the last cell on the last page
    const lastPage = this.pages[this.pages.length - 1];
    if (!lastPage) return;

    const lastPageLeaves = getAllLeaves(lastPage.layout);
    const lastCellId = lastPageLeaves[lastPageLeaves.length - 1]?.id;
    console.log(`[PageOverflow] check: cellId=${cellId.slice(0,8)}, lastCellId=${lastCellId?.slice(0,8)}, match=${cellId === lastCellId}`);
    if (cellId !== lastCellId) return;

    const cell = this.cellPool.get(cellId);
    if (!cell) return;

    // Reset scroll before measuring — after paste, ProseMirror scrolls to cursor
    // which shifts getBoundingClientRect() positions and breaks findBreakPoint.
    cell.contentElement.scrollTop = 0;

    // Normalize: split multi-paragraph ProseMirror editors into individual blocks.
    // Paste creates ONE PM editor with N paragraphs — we need N separate blocks
    // so findBreakPoint can measure which ones fit on the page.
    const didNormalize = cell.normalizeBlocks();
    console.log(`[PageOverflow] cell ${cellId.slice(0,8)}: ${cell.blockCount()} blocks, normalized=${didNormalize}`);

    const measurable = {
      cellId: cell.id,
      contentElement: cell.contentElement,
      blockNodes: cell.getBlockNodes(),
    };

    const sh = cell.contentElement.scrollHeight;
    const ch = cell.contentElement.clientHeight;
    console.log(`[PageOverflow] scrollHeight=${sh}, clientHeight=${ch}, overflow=${sh > ch + 1}`);

    if (!this.overflowDetector.hasOverflow(measurable)) return;

    // Find what fits
    const info = this.overflowDetector.findBreakPoint(measurable);
    console.log(`[PageOverflow] findBreakPoint: hasOverflow=${info.hasOverflow}, lastFitting=${info.lastFittingBlockIndex}, totalBlocks=${cell.blockCount()}`);
    if (!info.hasOverflow) return;

    // Subtract 1 block from the fit count as margin buffer.
    // This prevents sub-pixel margin overflow that causes tiny scrollbars.
    const rawFit = info.lastFittingBlockIndex + 1;
    const fitCount = Math.max(1, rawFit > 1 ? rawFit - 1 : rawFit);
    if (fitCount >= cell.blockCount()) return; // everything fits

    // Trim overflow blocks from this cell
    const overflowBlocks = cell.trimFrom(fitCount);
    console.log(`[PageOverflow] trimmed: kept=${fitCount}, overflow=${overflowBlocks.length}`);
    if (overflowBlocks.length === 0) return;

    // Create new pages with overflow content
    // Each page gets a full-page cell. Fill pages until all content is placed.
    let remaining = overflowBlocks;

    while (remaining.length > 0) {
      console.log(`[PageOverflow] creating page with ${remaining.length} blocks`);
      // Create a new page
      const newPage = createPage(remaining);
      this.pages = addPageAfter(this.pages, this.pages[this.pages.length - 1].id, newPage);

      // Reconcile to render the new page
      this.reconciler.reconcilePages(this.container, this.pages);

      // Check if the new page's cell overflows too
      const newPageLeaves = getAllLeaves(newPage.layout);
      const newCell = this.cellPool.get(newPageLeaves[0]?.id ?? '');
      if (!newCell) break;

      // Reset scroll before measuring new page too
      newCell.contentElement.scrollTop = 0;

      const newMeasurable = {
        cellId: newCell.id,
        contentElement: newCell.contentElement,
        blockNodes: newCell.getBlockNodes(),
      };

      if (!this.overflowDetector.hasOverflow(newMeasurable)) {
        break; // everything fits on this page
      }

      // Still overflows — trim and continue to next page
      const newInfo = this.overflowDetector.findBreakPoint(newMeasurable);
      const newRawFit = newInfo.lastFittingBlockIndex + 1;
      const newFitCount = Math.max(1, newRawFit > 1 ? newRawFit - 1 : newRawFit);

      if (newFitCount >= newCell.blockCount()) break;

      remaining = newCell.trimFrom(newFitCount);
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

  /**
   * Rebuild DocumentTree from all live cells and emit onChange.
   */
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
