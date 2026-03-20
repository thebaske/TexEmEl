// ============================================================================
// LayoutEngine — BSP Layout Orchestrator (Multi-Page)
//
// Manages a paginated document where each page has its own BSP tree.
// Handles overflow detection and content redistribution across pages.
//
// Responsibilities:
//  - Manages Page[] (each page has a LayoutNode BSP tree)
//  - Renders via CellRenderer (multi-page)
//  - Handles split resize via SplitResizeManager
//  - Handles edge-pull-to-split via EdgeSplitManager
//  - Mounts TextKernel into leaf cells
//  - Tracks active cell/page for toolbar commands
//  - Runs overflow detection after layout changes
//  - Provides split/merge/move operations
// ============================================================================

import type { Block, DocumentTree, TextMark } from '../model/DocumentTree';
import type { ITextKernel } from '../engine/types';
import type { BlockNode } from '../engine/BlockNode';
import { generateBlockId, assignBlockIds } from '../engine/BlockId';
import { CellRenderer } from './CellRenderer';
import { SplitResizeManager } from './SplitResizeManager';
import { EdgeSplitManager } from './EdgeSplitManager';
import { OverflowResolver } from './OverflowResolver';
import {
  type LayoutNode,
  type LeafNode,
  type SplitDirection,
  createDefaultLayout,
  splitCell,
  mergeCells,
  resizeSplit,
  moveContent,
  updateLeafBlocks,
  insertBlockInCell,
  removeBlockFromCell,
  findNode,
  findParent,
  getAllLeaves,
} from './LayoutTree';
import {
  type Page,
  createPage,
  addPageAfter,
  getPageForCell,
  collectAllBlocks,
} from './PageModel';

// --- Types ---

export type OnLayoutChangeCallback = (tree: DocumentTree, layout: LayoutNode) => void;

export interface LayoutEngineConfig {
  debounceMs: number;
}

const DEFAULT_CONFIG: LayoutEngineConfig = {
  debounceMs: 150,
};

// --- Engine ---

export class LayoutEngine {
  private container: HTMLElement | null = null;
  private config: LayoutEngineConfig;

  // State — multi-page
  private pages: Page[] = [];
  private metadata: DocumentTree['metadata'] = {};
  private activeCellId: string | null = null;
  private activePageId: string | null = null;
  private focusedBlockId: string | null = null;

  // Subsystems
  private cellRenderer: CellRenderer;
  private resizeManager: SplitResizeManager | null = null;
  private edgeSplitManager: EdgeSplitManager | null = null;
  private overflowResolver = new OverflowResolver();

  // TextKernel factory — injected by consumer
  private kernelFactory: ((node: BlockNode, el: HTMLElement, block: Block) => ITextKernel) | null = null;

  // Callbacks
  private onChangeCallbacks: OnLayoutChangeCallback[] = [];
  private onToolbarUpdateCallbacks: (() => void)[] = [];

  // Debounce
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private overflowTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<LayoutEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.cellRenderer = new CellRenderer({
      onCellClick: (cellId, e) => this.handleCellClick(cellId, e),
      onCellDblClick: (cellId, _e) => this.handleCellDblClick(cellId),
    });
  }

  // ---- Backward-compat: expose first page's layout as "the layout" ----
  get layout(): LayoutNode {
    return this.pages.length > 0 ? this.pages[0].layout : createDefaultLayout();
  }

  // =====================
  //  LIFECYCLE
  // =====================

  setKernelFactory(factory: (node: BlockNode, el: HTMLElement, block: Block) => ITextKernel): void {
    this.kernelFactory = factory;

    this.cellRenderer.setMountKernel((node, contentEl, block) => {
      const kernel = this.kernelFactory!(node, contentEl, block);
      node.mountKernel(kernel);

      kernel.onUpdate(() => {
        node.onKernelChange();
        this.debouncedSync();
        this.scheduleOverflowCheck();
        this.emitToolbarUpdate();
      });

      kernel.onSelectionUpdate?.(() => {
        this.emitToolbarUpdate();
      });
    });
  }

  /** Mount the engine into a DOM container with initial document */
  mount(container: HTMLElement, doc: DocumentTree): void {
    this.container = container;
    container.tabIndex = -1;
    container.style.outline = 'none';

    // Convert flat block list to single-page BSP layout
    const blocks = assignBlockIds(doc.blocks);
    this.pages = [createPage(blocks)];
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;

    // Render
    this.fullRender();

    // Set up resize manager
    this.resizeManager = new SplitResizeManager(container, {
      onResize: (splitId, ratio) => {
        this.cellRenderer.updateSplitRatio(splitId, ratio, this.layout);
      },
      onResizeEnd: (splitId, ratio) => {
        // Find which page contains this split
        for (const page of this.pages) {
          if (findNode(page.layout, splitId)) {
            this.updatePageLayout(page.id, resizeSplit(page.layout, splitId, ratio));
            break;
          }
        }
        this.syncToReact();
        this.scheduleOverflowCheck();
      },
    });

    // Set up edge split manager — edge pulls always split the cell
    this.edgeSplitManager = new EdgeSplitManager(container, {
      onEdgeSplit: (cellId, direction, ratio) => {
        this.split(direction, cellId, ratio);
      },
    });

    // Global keyboard handlers
    container.addEventListener('keydown', (e) => this.handleKeyDown(e));
    container.addEventListener('contextmenu', (e) => this.handleContextMenu(e));

    // Immediate overflow check on mount
    requestAnimationFrame(() => this.checkOverflow());
  }

  /** Update from external source (file open) */
  update(doc: DocumentTree): void {
    if (!this.container) return;
    const blocks = assignBlockIds(doc.blocks);
    this.pages = [createPage(blocks)];
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;
    this.activeCellId = null;
    this.focusedBlockId = null;
    this.fullRender();
    // Immediate overflow check for file open (no debounce)
    requestAnimationFrame(() => this.checkOverflow());
  }

  /** Load a saved layout */
  loadLayout(layout: LayoutNode, metadata: DocumentTree['metadata']): void {
    if (!this.container) return;
    this.pages = [{ id: generateBlockId(), layout }];
    this.activePageId = this.pages[0].id;
    this.metadata = metadata;
    this.activeCellId = null;
    this.focusedBlockId = null;
    this.fullRender();
  }

  destroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.overflowTimer) clearTimeout(this.overflowTimer);
    this.resizeManager?.destroy();
    this.edgeSplitManager?.destroy();
    this.cellRenderer.destroy();
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

  /** Split the active cell (or specified cell) in the given direction */
  split(direction: SplitDirection, cellId?: string, ratio = 0.5): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    this.updatePageLayout(page.id, splitCell(page.layout, targetId, direction, ratio));
    this.fullRender();
    this.syncToReact();
    this.scheduleOverflowCheck();
  }

  /** Merge a cell with its sibling */
  merge(cellId?: string): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId) return;

    const page = getPageForCell(this.pages, targetId);
    if (!page) return;

    const parent = findParent(page.layout, targetId);
    if (!parent) return;

    this.updatePageLayout(page.id, mergeCells(page.layout, parent.id));
    this.activeCellId = null;
    this.focusedBlockId = null;
    this.fullRender();
    this.syncToReact();
  }

  /** Move all content from one cell to another */
  moveCellContent(fromCellId: string, toCellId: string, autoMerge = false): void {
    const page = getPageForCell(this.pages, fromCellId);
    if (!page) return;
    this.updatePageLayout(page.id, moveContent(page.layout, fromCellId, toCellId, autoMerge));
    this.fullRender();
    this.syncToReact();
  }

  /** Get the current layout tree (first page, for backward compat) */
  getLayout(): LayoutNode {
    return this.layout;
  }

  /** Get all pages */
  getPages(): Page[] {
    return this.pages;
  }

  /** Get the active cell ID */
  getActiveCellId(): string | null {
    return this.activeCellId;
  }

  /** Get the active page ID */
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

    const page = getPageForCell(this.pages, this.activeCellId);
    if (!page) return;

    const cell = findNode(page.layout, this.activeCellId) as LeafNode | null;
    if (!cell || cell.type !== 'leaf') return;

    const blockIndex = cell.blocks.findIndex(b => b.id === data.id);
    if (blockIndex === -1) return;

    const newBlocks = [...cell.blocks];
    newBlocks[blockIndex] = newBlock;
    this.updatePageLayout(page.id, updateLeafBlocks(page.layout, this.activeCellId, newBlocks));
    this.fullRender();
    this.syncToReact();

    requestAnimationFrame(() => {
      this.focusBlockInCell(this.activeCellId!, newBlock.id!);
    });
  }

  insertBlock(block: Block): void {
    if (!this.activeCellId) {
      // Use first leaf of first page
      if (this.pages.length === 0) return;
      const leaves = getAllLeaves(this.pages[0].layout);
      if (leaves.length === 0) return;
      this.activeCellId = leaves[0].id;
    }

    const page = getPageForCell(this.pages, this.activeCellId);
    if (!page) return;

    const newBlock = { ...block, id: generateBlockId() };
    this.updatePageLayout(page.id, insertBlockInCell(page.layout, this.activeCellId, newBlock));
    this.fullRender();
    this.syncToReact();
    this.scheduleOverflowCheck();
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
    if (!this.activeCellId || !this.focusedBlockId) return;
    const page = getPageForCell(this.pages, this.activeCellId);
    if (!page) return;
    this.updatePageLayout(page.id, removeBlockFromCell(page.layout, this.activeCellId, this.focusedBlockId));
    this.focusedBlockId = null;
    this.fullRender();
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
      const registry = this.cellRenderer.getRegistry();
      const node = registry.get(blockId);
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

    // Merge option
    const page = getPageForCell(this.pages, cellId);
    if (page) {
      const parent = findParent(page.layout, cellId);
      if (parent) {
        items.push({ label: 'Merge with Sibling', action: () => this.merge(cellId) });
      }
    }

    // Add new page option
    items.push({ label: 'Add Page After', action: () => {
      if (page) {
        const newPage = createPage();
        this.pages = addPageAfter(this.pages, page.id, newPage);
        this.fullRender();
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
      const prevHandle = this.cellRenderer.getCellHandle(this.activeCellId);
      prevHandle?.element.classList.remove('bsp-cell--active');
      this.focusedBlockId = null;
    }

    this.activeCellId = cellId;
    this.activePageId = this.cellRenderer.getPageIdForCell(cellId) ?? null;

    const handle = this.cellRenderer.getCellHandle(cellId);
    handle?.element.classList.add('bsp-cell--active');
  }

  private autoFocusInCell(cellId: string): void {
    const page = getPageForCell(this.pages, cellId);
    if (!page) return;

    const cell = findNode(page.layout, cellId) as LeafNode | null;
    if (!cell || cell.type !== 'leaf') return;

    if (cell.blocks.length === 0) {
      const newBlock: Block = { type: 'paragraph', content: [], id: generateBlockId() };
      this.updatePageLayout(page.id, insertBlockInCell(page.layout, cellId, newBlock));
      this.fullRender();
      this.syncToReact();

      requestAnimationFrame(() => {
        this.focusBlockInCell(cellId, newBlock.id!);
      });
      return;
    }

    const handle = this.cellRenderer.getCellHandle(cellId);
    if (!handle) return;

    for (let i = handle.blockNodes.length - 1; i >= 0; i--) {
      const bn = handle.blockNodes[i];
      if (bn.isEditable() && bn.kernel) {
        this.focusedBlockId = bn.id;
        bn.kernel.focus();
        return;
      }
    }

    if (handle.blockNodes.length > 0) {
      this.focusedBlockId = handle.blockNodes[0].id;
    }
  }

  private getActiveKernel(): ITextKernel | null {
    if (!this.focusedBlockId) return null;
    const registry = this.cellRenderer.getRegistry();
    const node = registry.get(this.focusedBlockId);
    return node?.kernel ?? null;
  }

  private getFocusedBlockNode(): BlockNode | null {
    if (!this.focusedBlockId) return null;
    return this.cellRenderer.getRegistry().get(this.focusedBlockId) ?? null;
  }

  private focusBlockInCell(cellId: string, blockId: string): void {
    this.setActiveCell(cellId);
    this.focusedBlockId = blockId;

    const registry = this.cellRenderer.getRegistry();
    const node = registry.get(blockId);
    if (node?.isEditable() && node.kernel) {
      node.kernel.focus();
    }
    this.emitToolbarUpdate();
  }

  /** Update a specific page's layout tree */
  private updatePageLayout(pageId: string, newLayout: LayoutNode): void {
    this.pages = this.pages.map(p =>
      p.id === pageId ? { ...p, layout: newLayout } : p
    );
  }

  private fullRender(): void {
    if (!this.container) return;
    this.cellRenderer.renderPages(this.container, this.pages);
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

  /** Schedule an overflow check after the DOM has painted */
  private scheduleOverflowCheck(): void {
    if (this.overflowTimer) clearTimeout(this.overflowTimer);
    this.overflowTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        this.checkOverflow();
      });
    }, this.config.debounceMs);
  }

  /** Run overflow detection and resolution */
  private checkOverflow(): void {
    const oldPageCount = this.pages.length;

    const result = this.overflowResolver.resolve(
      this.pages,
      (cellId) => this.cellRenderer.getCellHandle(cellId),
    );

    if (result.changed) {
      this.pages = result.pages;

      // If page count changed (new pages created or empty removed), do full re-render
      if (result.pages.length !== oldPageCount) {
        this.fullRender();
        // After full re-render, check again (new pages may also overflow)
        requestAnimationFrame(() => this.checkOverflow());
      } else {
        // Same page count — selectively re-render affected pages
        for (const pageId of result.affectedPageIds) {
          const page = this.pages.find(p => p.id === pageId);
          if (page) {
            this.cellRenderer.rerenderPage(pageId, page);
          }
        }
      }
      this.syncToReact();
    }
  }

  /** Rebuild DocumentTree from all pages and emit onChange */
  private syncToReact(): void {
    // Collect live content from all pages
    for (const page of this.pages) {
      const leaves = getAllLeaves(page.layout);
      let updatedLayout = page.layout;
      for (const leaf of leaves) {
        const handle = this.cellRenderer.getCellHandle(leaf.id);
        if (handle) {
          const liveBlocks = handle.blockNodes.map(bn => bn.getData());
          updatedLayout = updateLeafBlocks(updatedLayout, leaf.id, liveBlocks);
        }
      }
      if (updatedLayout !== page.layout) {
        this.updatePageLayout(page.id, updatedLayout);
      }
    }

    const allBlocks = collectAllBlocks(this.pages);

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
