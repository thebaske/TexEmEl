// ============================================================================
// LayoutDirector — Thin orchestrator for BSP layout (V3 Architecture)
//
// Replaces LayoutEngine. Delegates to:
//   - CellPool: persistent cell instances
//   - LayoutReconciler: diff-based DOM updates
//   - SplitResizeManager: drag resize handles
//   - EdgeSplitManager: edge-pull-to-split
//
// Key difference from LayoutEngine: NO nuclear renders. Cells survive all
// layout operations. ProseMirror instances are never destroyed during
// split/merge/resize.
// ============================================================================

import type { Block, DocumentTree, TextMark } from '../model/DocumentTree';
import type { ITextKernel } from '../engine/types';
import type { BlockNode } from '../engine/BlockNode';
import { generateBlockId, assignBlockIds } from '../engine/BlockId';
import { CellPool } from './CellPool';
import { LayoutReconciler } from './LayoutReconciler';
import { SplitResizeManager } from './SplitResizeManager';
import { EdgeSplitManager } from './EdgeSplitManager';
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

    // Convert flat block list to single-page BSP layout
    const blocks = assignBlockIds(doc.blocks);
    this.pages = [createPage(blocks)];
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;

    // Create subsystems
    this.cellPool = new CellPool({
      kernelFactory: this.kernelFactory!,
      onContentChange: (_cellId: string) => {
        this.debouncedSync();
        this.emitToolbarUpdate();
      },
      onSelectionChange: (_cellId: string) => {
        this.emitToolbarUpdate();
      },
    });

    this.reconciler = new LayoutReconciler(this.cellPool, {
      onCellClick: (cellId, e) => this.handleCellClick(cellId, e),
      onCellDblClick: (cellId, _e) => this.handleCellDblClick(cellId),
    });

    // Initial render
    this.reconciler.reconcilePages(container, this.pages);

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

    // Release all existing cells — fresh start for new document
    this.cellPool.destroy();

    // Recreate pool (factory references are preserved)
    this.cellPool = new CellPool({
      kernelFactory: this.kernelFactory!,
      onContentChange: (_cellId: string) => {
        this.debouncedSync();
        this.emitToolbarUpdate();
      },
      onSelectionChange: (_cellId: string) => {
        this.emitToolbarUpdate();
      },
    });

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
  }

  destroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
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

    // Update tree — original cell keeps its ID (no content sync needed!)
    const { tree: newLayout } = splitCell(page.layout, targetId, direction, ratio);
    this.updatePageLayout(page.id, newLayout);

    // Reconcile — cellPool.acquire(targetId) returns EXISTING cell, reparents it
    this.reconciler.reconcilePages(this.container!, this.pages);
    this.syncToReact();
  }

  /** Merge a cell with its sibling (reading order: first absorbs second) */
  merge(cellId?: string): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId || !this.cellPool || !this.reconciler) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    const parent = findParent(page.layout, targetId);
    if (!parent) return;

    // Determine reading order: first child absorbs second child's content
    const isFirst = parent.first.id === targetId ||
      (parent.first.type === 'split' && findNode(parent.first, targetId));

    const survivorId = isFirst ? this.getFirstLeafId(parent.first) : this.getFirstLeafId(parent.second);
    const victimId = isFirst ? this.getFirstLeafId(parent.second) : this.getFirstLeafId(parent.first);

    if (!survivorId || !victimId) return;

    // Live content transfer: survivor absorbs victim's blocks
    const survivor = this.cellPool.get(survivorId);
    const victim = this.cellPool.get(victimId);
    if (survivor && victim) {
      const victimContent = victim.drainAll();
      if (victimContent.length > 0) {
        survivor.appendBlocks(victimContent);
      }
    }

    // Update tree structure (collapse the split)
    this.updatePageLayout(page.id, mergeCells(page.layout, parent.id));
    this.activeCellId = survivorId;
    this.focusedBlockId = null;

    // Reconcile — orphaned cells get cleaned up
    this.reconciler.reconcilePages(this.container!, this.pages);
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
      // Local operation: add a paragraph block directly to the cell
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

  private getFirstLeafId(node: LayoutNode): string | null {
    if (node.type === 'leaf') return node.id;
    return this.getFirstLeafId(node.first);
  }

  private emitToolbarUpdate(): void {
    for (const cb of this.onToolbarUpdateCallbacks) cb();
  }

  private debouncedSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncToReact();
    }, this.config.debounceMs);
  }

  /**
   * Rebuild DocumentTree from all live cells and emit onChange.
   * Reads directly from CellPool — no stale tree data, no sync race.
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
          // Fallback to tree data for cells not yet in pool
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
