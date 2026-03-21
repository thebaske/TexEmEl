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
import { FlowGraph } from './FlowGraph';
import { OverflowWatcher } from './OverflowWatcher';
import { OverflowDetector } from './OverflowDetector';
import { ContentStream } from './ContentStream';
import type { CellSlice } from './StreamLayout';
import type { CellInstance } from './CellInstance';
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
  updateLeafBlocks,
} from './LayoutTree';
// ContentSplitter available for future line-level splitting (currently disabled)
// import { ContentSplitter } from './ContentSplitter';
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
  private flowGraph: FlowGraph = new FlowGraph();
  private overflowWatcher: OverflowWatcher | null = null;
  private overflowDetector = new OverflowDetector();

  // Content Stream Model — single source of truth for document content
  private stream: ContentStream = ContentStream.empty();
  private currentSlices: CellSlice[] = [];
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard: true while applying layout (prevents content-change → relayout loop) */
  private applyingLayout = false;

  // Kernel factory — injected by consumer
  private kernelFactory: ((node: BlockNode, el: HTMLElement, block: Block) => ITextKernel) | null = null;

  // Callbacks
  private onChangeCallbacks: OnLayoutChangeCallback[] = [];
  private onToolbarUpdateCallbacks: (() => void)[] = [];

  // Debounce
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private overflowCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guard: true while resolving overflow (prevents content-change → overflow loop) */
  private resolvingOverflow = false;

  constructor(config?: Partial<LayoutDirectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // Backward-compat: expose first page's layout
  get layout(): LayoutNode {
    return this.pages.length > 0 ? this.pages[0].layout : createDefaultLayout();
  }

  /** Get current stream slice assignments (for debugging/export) */
  getSlices(): CellSlice[] {
    return this.currentSlices;
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
    this.pages = [createPage([])]; // Pages hold BSP tree structure, NOT content
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;

    // Create content stream — THE single source of truth
    this.stream = ContentStream.fromBlocks(blocks);
    this.stream.onChange(() => {
      if (!this.applyingLayout) {
        this.scheduleRelayout();
      }
    });

    // Create subsystems
    this.cellPool = new CellPool({
      kernelFactory: this.kernelFactory!,
      onContentChange: (cellId: string) => {
        // Write ProseMirror content back to the stream
        this.syncCellToStream(cellId);
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

    // Initial render — reconcile creates empty cells in BSP structure
    this.reconciler.reconcilePages(container, this.pages);

    // Build flow graph (reading order)
    this.flowGraph = FlowGraph.fromPages(this.pages);

    // Apply initial stream layout after browser has laid out empty cells
    requestAnimationFrame(() => {
      this.recomputeAndApplyLayout();
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
        // Resize changes cell dimensions — recompute stream layout
        requestAnimationFrame(() => {
          this.recomputeAndApplyLayout();
        });
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
    this.overflowWatcher?.destroy();
    this.overflowWatcher = null;
    this.reconciler.destroy();
    this.cellPool.destroy();
    this.stream.clearCallbacks();

    // Recreate pool (factory references are preserved)
    this.cellPool = new CellPool({
      kernelFactory: this.kernelFactory!,
      onContentChange: (cellId: string) => {
        this.syncCellToStream(cellId);
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
    this.pages = [createPage([])]; // BSP structure only, no content
    this.activePageId = this.pages[0].id;
    this.metadata = doc.metadata;
    this.activeCellId = null;
    this.focusedBlockId = null;

    // Replace stream content
    this.stream = ContentStream.fromBlocks(blocks);
    this.stream.onChange(() => {
      if (!this.applyingLayout) {
        this.scheduleRelayout();
      }
    });

    this.reconciler.reconcilePages(this.container, this.pages);
    this.flowGraph = FlowGraph.fromPages(this.pages);

    // Apply layout after browser renders
    requestAnimationFrame(() => {
      this.recomputeAndApplyLayout();
    });
  }

  destroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.overflowCheckTimer) clearTimeout(this.overflowCheckTimer);
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.stream.clearCallbacks();
    this.overflowWatcher?.destroy();
    this.resizeManager?.destroy();
    this.edgeSplitManager?.destroy();
    this.reconciler?.destroy();
    this.cellPool?.destroy();
    this.flowGraph.clear();
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

    // Rebuild flow graph and recompute stream layout
    this.flowGraph = FlowGraph.fromPages(this.pages);
    requestAnimationFrame(() => {
      this.recomputeAndApplyLayout();
    });
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

    // Rebuild flow graph and recompute stream layout
    this.flowGraph = FlowGraph.fromPages(this.pages);
    requestAnimationFrame(() => {
      this.recomputeAndApplyLayout();
    });
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
    // Insert into stream at end of this cell's slice
    const range = cell.getStreamRange();
    this.stream.insert(range.end, newBlock);
    // Stream onChange → relayout will distribute
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
    if (!this.focusedBlockId) return;

    // Remove from stream by ID
    this.stream.removeById(this.focusedBlockId);
    this.focusedBlockId = null;
    // Stream onChange → relayout
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
      // Add an empty paragraph to the stream at this cell's position
      const range = cell.getStreamRange();
      const newBlockData: Block = { type: 'paragraph', content: [], id: generateBlockId() };

      // Insert into stream at this cell's start position
      this.stream.insert(range.start, newBlockData);
      // Stream onChange → scheduleRelayout → recomputeAndApplyLayout
      // But we need the block NOW for focus, so also add locally
      const newBlock = cell.addBlock(newBlockData);
      this.focusedBlockId = newBlock.id;

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

  // NOTE: debouncedSync, scheduleOverflowCheck, checkAndResolveOverflow
  // were removed — replaced by Content Stream Model (scheduleRelayout + recomputeAndApplyLayout)

  // =====================
  //  CONTENT STREAM — Layout Recomputation
  // =====================

  /**
   * Schedule a layout recomputation after content changes.
   * Debounced to batch rapid edits (typing).
   */
  private scheduleRelayout(): void {
    if (this.layoutTimer) clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => {
      this.recomputeAndApplyLayout();
    }, this.config.debounceMs + 50); // slightly after content settles
  }

  /**
   * Write a cell's ProseMirror content back to the stream.
   * Called on every content change (typing, paste, etc.).
   */
  /** Cooldown: suppress syncCellToStream briefly after layout to prevent cascade */
  private layoutCooldown = false;

  private syncCellToStream(cellId: string): void {
    if (this.applyingLayout || this.layoutCooldown || !this.cellPool) return;

    const cell = this.cellPool.get(cellId);
    if (!cell) return;

    const range = cell.getStreamRange();
    const liveBlocks = cell.getContent();

    // The cell may have a different number of blocks than its slice
    // (e.g., ProseMirror paste created multiple paragraphs in one editor).
    // Normalize and update the stream.

    // First, normalize multi-paragraph blocks
    const normalized: Block[] = [];
    for (const block of liveBlocks) {
      if ((block.type === 'paragraph' || block.type === 'heading') &&
          block.content?.some(item => item.type === 'break')) {
        // Split by breaks (same logic as ContentStream normalization)
        const segments: import('../model/DocumentTree').InlineContent[][] = [[]];
        for (const item of block.content) {
          if (item.type === 'break') {
            segments.push([]);
          } else {
            segments[segments.length - 1].push(item);
          }
        }
        for (let i = 0; i < segments.length; i++) {
          normalized.push({
            ...(i === 0 ? block : { type: 'paragraph' as const, alignment: (block as any).alignment }),
            content: segments[i],
            id: i === 0 ? block.id : generateBlockId(),
            pmDocJson: undefined,
          } as Block);
        }
      } else {
        normalized.push(block);
      }
    }

    // Update stream: replace the slice [start, end) with normalized blocks
    this.stream.batch(() => {
      const oldLen = range.end - range.start;
      // Remove old slice
      for (let i = 0; i < oldLen; i++) {
        this.stream.remove(range.start);
      }
      // Insert new blocks at the same position
      for (let i = 0; i < normalized.length; i++) {
        this.stream.insert(range.start + i, normalized[i]);
      }
    });
    // stream.onChange will fire → scheduleRelayout
  }

  /**
   * Recompute which blocks go in which cell, then apply.
   * This is the CORE of the Content Stream Model.
   *
   * Algorithm:
   * 1. Get all cells in reading order
   * 2. For each cell: render ALL remaining blocks, measure which fit
   * 3. Keep only the fitting blocks, pass the rest to the next cell
   * 4. If blocks remain after all cells → create overflow page
   *
   * Each cell gets exactly ONE setSlice call (efficient, no destroy/recreate churn).
   */
  private recomputeAndApplyLayout(): void {
    if (!this.cellPool || !this.container) return;

    this.applyingLayout = true;
    try {
      const allBlocks = this.stream.getAll();

      // Get cells in reading order
      const cellOrder: CellInstance[] = [];
      for (const page of this.pages) {
        const leaves = getAllLeaves(page.layout);
        for (const leaf of leaves) {
          const cell = this.cellPool.get(leaf.id);
          if (cell) cellOrder.push(cell);
        }
      }

      if (cellOrder.length === 0) return;

      // Walk the stream, assigning blocks to cells.
      // Each cell gets ALL remaining blocks first (for measurement),
      // then trimmed to what fits. setSlice's ID reconciliation handles cleanup.
      let streamIdx = 0;
      const slices: CellSlice[] = [];

      console.log(`[StreamLayout] ${allBlocks.length} blocks, ${cellOrder.length} cells`);

      for (let ci = 0; ci < cellOrder.length; ci++) {
        const cell = cellOrder[ci];
        const startIdx = streamIdx;

        if (streamIdx >= allBlocks.length) {
          // No more blocks — cell is empty
          cell.setSlice([], startIdx, startIdx);
          slices.push({ cellId: cell.id, startIndex: startIdx, endIndex: startIdx });
          continue;
        }

        // Set ALL remaining blocks into the cell for measurement
        const remaining = allBlocks.slice(streamIdx);
        cell.setSlice(remaining, streamIdx, allBlocks.length);

        let fits: number;

        // If this is the LAST cell, it takes everything (no overflow to next cell)
        if (ci === cellOrder.length - 1) {
          // Check if we need an overflow page
          const measurable = {
            cellId: cell.id,
            contentElement: cell.contentElement,
            blockNodes: cell.getBlockNodes(),
          };
          if (this.overflowDetector.hasOverflow(measurable)) {
            const info = this.overflowDetector.findBreakPoint(measurable);
            fits = Math.max(1, info.lastFittingBlockIndex + 1);
            cell.setSlice(remaining.slice(0, fits), streamIdx, streamIdx + fits);
          } else {
            fits = remaining.length;
          }
        } else {
          // Not last cell — measure and distribute
          const measurable = {
            cellId: cell.id,
            contentElement: cell.contentElement,
            blockNodes: cell.getBlockNodes(),
          };

          if (!this.overflowDetector.hasOverflow(measurable)) {
            // All remaining fit — but we have more cells after this.
            // Still take everything (remaining cells will be empty).
            fits = remaining.length;
          } else {
            // Overflow! Find the break point
            const info = this.overflowDetector.findBreakPoint(measurable);
            fits = Math.max(1, info.lastFittingBlockIndex + 1);
            // Trim to what fits
            cell.setSlice(remaining.slice(0, fits), streamIdx, streamIdx + fits);
          }
        }

        const endIdx = streamIdx + fits;
        console.log(`[StreamLayout] cell ${cell.id.slice(0,8)}: blocks [${streamIdx}, ${endIdx}) = ${fits} blocks, overflow=${fits < remaining.length}`);
        slices.push({ cellId: cell.id, startIndex: streamIdx, endIndex: endIdx });
        streamIdx = endIdx;
      }

      // If blocks remain, need more pages
      if (streamIdx < allBlocks.length) {
        this.createOverflowPage([]);
        this.flowGraph = FlowGraph.fromPages(this.pages);
        this.reconciler!.reconcilePages(this.container, this.pages);
        // Recompute with new page
        requestAnimationFrame(() => {
          this.recomputeAndApplyLayout();
        });
        return;
      }

      this.currentSlices = slices;
      this.syncToReact();
    } finally {
      this.applyingLayout = false;
      // Brief cooldown to prevent syncCellToStream cascade from setSlice's PM creation
      this.layoutCooldown = true;
      setTimeout(() => { this.layoutCooldown = false; }, 100);
    }
  }

  // =====================
  //  FLOW & OVERFLOW (legacy — being replaced by Content Stream)
  // =====================

  /**
   * Rebuild the flow graph from current BSP tree structure
   * and (re)start overflow watching on all cells.
   */
  private rebuildFlowAndWatch(): void {
    if (!this.cellPool) return;

    // Rebuild flow graph from current tree structure
    this.flowGraph = FlowGraph.fromPages(this.pages);

    // Tear down and recreate overflow watcher
    this.overflowWatcher?.destroy();
    this.overflowWatcher = new OverflowWatcher({
      onOverflow: (cellId) => this.handleOverflow(cellId),
      onUnderflow: (cellId) => this.handleUnderflow(cellId),
      threshold: 2,
    });

    // Watch all live cells
    for (const page of this.pages) {
      const leaves = getAllLeaves(page.layout);
      for (const leaf of leaves) {
        const cell = this.cellPool.get(leaf.id);
        if (cell) {
          this.overflowWatcher.watch(cell);
        }
      }
    }
  }

  /**
   * Handle overflow: move excess blocks from this cell to its flow target.
   * Supports both block-level and mid-paragraph (line-level) splits.
   * Cascades synchronously through the flow chain — no async reliance.
   */
  private handleOverflow(cellId: string): void {
    if (!this.cellPool || this.resolvingOverflow) return;

    // Guard: prevent re-entrant overflow during resolution
    this.resolvingOverflow = true;
    this.overflowWatcher?.beginResolving();

    try {
      this.resolveOverflowChain(cellId);
      this.syncToReact();
    } finally {
      this.overflowWatcher?.endResolving();
      this.resolvingOverflow = false;
    }
  }

  /**
   * Synchronous overflow cascade: process cell, then process target if it overflowed too.
   * Max 50 iterations to prevent infinite loops.
   */
  private resolveOverflowChain(startCellId: string): void {
    let currentCellId: string | null = startCellId;
    let iterations = 0;
    const MAX_ITERATIONS = 50;

    while (currentCellId && iterations < MAX_ITERATIONS) {
      iterations++;
      const cell = this.cellPool!.get(currentCellId);
      if (!cell) break;

      const measurable = {
        cellId: cell.id,
        contentElement: cell.contentElement,
        blockNodes: cell.getBlockNodes(),
      };

      // Force browser layout so measurements are accurate
      // Reading scrollHeight/clientHeight triggers layout
      const info = this.overflowDetector.findBreakPoint(measurable);

      if (!info.hasOverflow) break;

      // Block-level splitting only.
      // Line-level splitting is disabled due to character offset mismatch
      // between DOM Range API and serialized InlineContent (breaks count
      // differently). After normalizeBlocks() each paragraph is its own block,
      // so block-level splitting handles most cases.
      const lastFitting = info.lastFittingBlockIndex;

      // If no blocks fit at all (lastFitting = -1) and cell has only 1 block,
      // that single block is too big for this cell. Leave it clipped — don't
      // bounce it between cells endlessly.
      if (lastFitting < 0 && cell.blockCount() <= 1) break;

      // Trim index: first block that doesn't fit
      const trimIndex = Math.max(0, lastFitting + 1);
      if (trimIndex >= cell.blockCount()) break; // all fit

      const overflowBlocks = cell.trimFrom(trimIndex);
      if (overflowBlocks.length === 0) break;

      // Find the flow target
      const targetId = this.flowGraph.getTarget(currentCellId);
      if (!targetId) {
        // No flow target — create a new page with overflow blocks
        this.createOverflowPage(overflowBlocks);
        break; // createOverflowPage rebuilds flow graph, stop cascade
      }

      const targetCell = this.cellPool!.get(targetId);
      if (!targetCell) break;

      // Prepend overflow blocks to the target cell
      targetCell.prependBlocks(overflowBlocks);

      // Continue cascade: check if the target now overflows
      currentCellId = targetId;
    }
  }

  /**
   * Handle underflow: pull blocks back from flow target if this cell has room.
   * Non-speculative: measures hypothetical height BEFORE modifying DOM.
   */
  private handleUnderflow(cellId: string): void {
    if (!this.cellPool || this.resolvingOverflow) return;

    const targetId = this.flowGraph.getTarget(cellId);
    if (!targetId) return;

    const cell = this.cellPool.get(cellId);
    const targetCell = this.cellPool.get(targetId);
    if (!cell || !targetCell || targetCell.isEmpty()) return;

    // Guard against re-entrant underflow
    this.resolvingOverflow = true;
    this.overflowWatcher?.beginResolving();

    try {
      let pulled = false;

      // Pull blocks one at a time from the target while they fit
      while (!targetCell.isEmpty()) {
        const targetBlocks = targetCell.getBlockNodes();
        if (targetBlocks.length === 0) break;

        const firstBlockData = targetBlocks[0].getData();

        // Speculatively add to test fit
        cell.appendBlocks([firstBlockData]);

        const measurable = {
          cellId: cell.id,
          contentElement: cell.contentElement,
          blockNodes: cell.getBlockNodes(),
        };

        if (this.overflowDetector.hasOverflow(measurable)) {
          // Doesn't fit — remove the block we just added and stop
          cell.trimFrom(cell.blockCount() - 1);
          break;
        }

        // It fits! Remove from target (the block was already cloned into this cell)
        targetCell.removeBlock(firstBlockData.id!);
        pulled = true;
      }

      if (pulled) {
        this.syncToReact();
      }
    } finally {
      this.overflowWatcher?.endResolving();
      this.resolvingOverflow = false;
    }
  }

  // NOTE: runFullOverflowPass removed — replaced by recomputeAndApplyLayout()

  /**
   * Create a new page to hold overflow content.
   */
  private createOverflowPage(blocks: Block[]): void {
    const newPage = createPage(blocks);
    this.pages = [...this.pages, newPage];

    // Reconcile to render the new page
    this.reconciler?.reconcilePages(this.container!, this.pages);

    // Rebuild flow graph to include new page
    this.rebuildFlowAndWatch();
  }

  /**
   * Rebuild DocumentTree from the ContentStream and emit onChange.
   * The stream IS the single source of truth — no cell walking needed.
   */
  private syncToReact(): void {
    const allBlocks = this.stream.getAll();

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
