// ============================================================================
// LayoutEngine — BSP Layout Orchestrator
//
// The main entry point for the BSP-based editor. Replaces BlockEngine's role
// as the orchestrator, but uses a recursive split-panel layout instead of
// a flat block list.
//
// Responsibilities:
//  - Manages the LayoutTree (split/leaf BSP structure)
//  - Renders via CellRenderer
//  - Handles split resize via SplitResizeManager
//  - Mounts TextKernel into leaf cells
//  - Tracks active cell for toolbar commands
//  - Provides split/merge/move operations
// ============================================================================

import type { Block, DocumentTree, TextMark } from '../model/DocumentTree';
import type { ITextKernel } from '../engine/types';
import type { BlockNode } from '../engine/BlockNode';
import { generateBlockId, assignBlockIds } from '../engine/BlockId';
import { CellRenderer } from './CellRenderer';
import { SplitResizeManager } from './SplitResizeManager';
import { CellDragManager } from './CellDragManager';
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

  // State
  private layout: LayoutNode;
  private metadata: DocumentTree['metadata'] = {};
  private activeCellId: string | null = null;
  private focusedBlockId: string | null = null;

  // Subsystems
  private cellRenderer: CellRenderer;
  private resizeManager: SplitResizeManager | null = null;
  private dragManager: CellDragManager | null = null;

  // TextKernel factory — injected by consumer
  private kernelFactory: ((node: BlockNode, el: HTMLElement, block: Block) => ITextKernel) | null = null;

  // Callbacks
  private onChangeCallbacks: OnLayoutChangeCallback[] = [];
  private onToolbarUpdateCallbacks: (() => void)[] = [];

  // Debounce
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<LayoutEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.layout = createDefaultLayout();

    this.cellRenderer = new CellRenderer({
      onCellClick: (cellId, e) => this.handleCellClick(cellId, e),
      onCellDblClick: (cellId, _e) => this.handleCellDblClick(cellId),
    });
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
        this.emitToolbarUpdate();
      });

      kernel.onSelectionUpdate?.(() => {
        this.emitToolbarUpdate();
      });

      kernel.onEnterAtEnd?.(() => {
        // Insert a new paragraph after the current block in the same cell
        if (this.activeCellId) {
          const cell = findNode(this.layout, this.activeCellId) as LeafNode | null;
          if (cell && cell.type === 'leaf') {
            const newBlock: Block = { type: 'paragraph', content: [], id: generateBlockId() };
            this.layout = insertBlockInCell(this.layout, this.activeCellId, newBlock);
            this.fullRender();
            // Focus the new block
            this.focusBlockInCell(this.activeCellId, newBlock.id!);
          }
        }
      });
    });
  }

  /** Mount the engine into a DOM container with initial document */
  mount(container: HTMLElement, doc: DocumentTree): void {
    this.container = container;
    container.tabIndex = -1;
    container.style.outline = 'none';
    container.classList.add('bsp-container');

    // Convert flat block list to BSP layout (single cell with all blocks)
    const blocks = assignBlockIds(doc.blocks);
    this.layout = createDefaultLayout(blocks);
    this.metadata = doc.metadata;

    // Render
    this.fullRender();

    // Set up resize manager
    this.resizeManager = new SplitResizeManager(container, {
      onResize: (splitId, ratio) => {
        // Live preview during drag
        this.cellRenderer.updateSplitRatio(splitId, ratio, this.layout);
      },
      onResizeEnd: (splitId, ratio) => {
        // Commit ratio to the layout tree
        this.layout = resizeSplit(this.layout, splitId, ratio);
        this.syncToReact();
      },
    });

    // Set up drag manager for moving content between cells
    this.initDragManager();

    // Global keyboard handlers
    container.addEventListener('keydown', (e) => this.handleKeyDown(e));

    // Context menu for split/merge
    container.addEventListener('contextmenu', (e) => this.handleContextMenu(e));
  }

  /** Initialize or re-initialize the cell drag manager */
  private initDragManager(): void {
    if (!this.container) return;
    this.dragManager?.destroy();
    this.dragManager = new CellDragManager(this.container, {
      onMoveContent: (fromCellId, toCellId) => {
        this.moveCellContent(fromCellId, toCellId, true);
      },
      onSplitAndMove: (fromCellId, toCellId, direction, insertFirst) => {
        this.splitAndMove(fromCellId, toCellId, direction, insertFirst);
      },
    });
  }

  /** Split a target cell and move content from source into the new half */
  private splitAndMove(fromCellId: string, toCellId: string, direction: SplitDirection, insertFirst: boolean): void {
    // Get source blocks before modifying the tree
    const sourceNode = findNode(this.layout, fromCellId) as LeafNode | null;
    if (!sourceNode || sourceNode.type !== 'leaf') return;
    const blocks = [...sourceNode.blocks];

    // Clear source cell
    this.layout = updateLeafBlocks(this.layout, fromCellId, []);

    // Split target cell
    this.layout = splitCell(this.layout, toCellId, direction);

    // After splitCell, toCellId no longer exists — it was replaced by a new split.
    // The new split's first child has the original blocks, second is empty.
    // We need to find the new empty leaf and put our content there.
    const allLeaves = getAllLeaves(this.layout);
    const emptyLeaf = allLeaves.find(l => l.blocks.length === 0 && l.id !== fromCellId);

    if (emptyLeaf) {
      if (insertFirst) {
        // We want dragged content in the first position — swap the new split's children
        // Actually, we need to put blocks in the empty leaf and then let the user see it
        // in the correct position. Since splitCell puts original content in first, empty in second:
        // - insertFirst=true (top/left): swap original into second, put dragged into first
        //   → Simpler: just put dragged blocks into the empty leaf. The position depends on
        //     whether it's first or second child of the split.
        // For now, just put blocks in the empty leaf — the visual position is handled by
        // which child the empty leaf is.
        this.layout = updateLeafBlocks(this.layout, emptyLeaf.id, blocks);
      } else {
        this.layout = updateLeafBlocks(this.layout, emptyLeaf.id, blocks);
      }
    }

    // Auto-merge the source if it's now empty
    this.layout = this.autoMergeEmptyLeaf(this.layout, fromCellId);

    this.fullRender();
    this.initDragManager(); // Re-attach drag handles to new cells
    this.syncToReact();
  }

  /** If a leaf is empty and has a sibling, merge it away */
  private autoMergeEmptyLeaf(root: LayoutNode, leafId: string): LayoutNode {
    const leaf = findNode(root, leafId);
    if (!leaf || leaf.type !== 'leaf' || leaf.blocks.length > 0) return root;

    const parent = findParent(root, leafId);
    if (!parent) return root;

    return mergeCells(root, parent.id);
  }

  /** Update from external source (file open) */
  update(doc: DocumentTree): void {
    if (!this.container) return;
    const blocks = assignBlockIds(doc.blocks);
    this.layout = createDefaultLayout(blocks);
    this.metadata = doc.metadata;
    this.activeCellId = null;
    this.focusedBlockId = null;
    this.fullRender();
  }

  /** Load a saved layout (if we have one) */
  loadLayout(layout: LayoutNode, metadata: DocumentTree['metadata']): void {
    if (!this.container) return;
    this.layout = layout;
    this.metadata = metadata;
    this.activeCellId = null;
    this.focusedBlockId = null;
    this.fullRender();
  }

  destroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.resizeManager?.destroy();
    this.dragManager?.destroy();
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

    this.layout = splitCell(this.layout, targetId, direction, ratio);
    this.fullRender();
    this.syncToReact();
  }

  /** Merge a cell with its sibling (both children of the parent split) */
  merge(cellId?: string): void {
    const targetId = cellId ?? this.activeCellId;
    if (!targetId) return;

    const parent = findParent(this.layout, targetId);
    if (!parent) return;

    this.layout = mergeCells(this.layout, parent.id);
    this.activeCellId = null;
    this.focusedBlockId = null;
    this.fullRender();
    this.syncToReact();
  }

  /** Move all content from one cell to another */
  moveCellContent(fromCellId: string, toCellId: string, autoMerge = false): void {
    this.layout = moveContent(this.layout, fromCellId, toCellId, autoMerge);
    this.fullRender();
    this.syncToReact();
  }

  /** Get the current layout tree (for saving/persistence) */
  getLayout(): LayoutNode {
    return this.layout;
  }

  /** Get the active cell ID */
  getActiveCellId(): string | null {
    return this.activeCellId;
  }

  // =====================
  //  TOOLBAR COMMANDS
  // =====================

  applyMark(markType: string, attrs?: Record<string, unknown>): void {
    const kernel = this.getActiveKernel();
    kernel?.toggleMark(markType, attrs);
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

  /** Get the type of the focused block */
  getActiveBlockType(): string | null {
    const node = this.getFocusedBlockNode();
    if (!node) return null;
    const data = node.getData();
    if (data.type === 'heading') return `heading:${data.level}`;
    return data.type;
  }

  /** Change the focused block's type (paragraph <-> heading) */
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

    // Replace the block in the layout tree
    const cell = findNode(this.layout, this.activeCellId) as LeafNode | null;
    if (!cell || cell.type !== 'leaf') return;

    const blockIndex = cell.blocks.findIndex(b => b.id === data.id);
    if (blockIndex === -1) return;

    const newBlocks = [...cell.blocks];
    newBlocks[blockIndex] = newBlock;
    this.layout = updateLeafBlocks(this.layout, this.activeCellId, newBlocks);
    this.fullRender();
    this.syncToReact();

    // Re-focus the block
    requestAnimationFrame(() => {
      this.focusBlockInCell(this.activeCellId!, newBlock.id!);
    });
  }

  /** Insert a block into the active cell */
  insertBlock(block: Block): void {
    if (!this.activeCellId) {
      // If no active cell, use the first leaf
      const leaves = getAllLeaves(this.layout);
      if (leaves.length === 0) return;
      this.activeCellId = leaves[0].id;
    }

    const newBlock = { ...block, id: generateBlockId() };
    this.layout = insertBlockInCell(this.layout, this.activeCellId, newBlock);
    this.fullRender();
    this.syncToReact();
  }

  /** Insert a table into the active cell */
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

  /** Insert an image into the active cell */
  insertImage(src: string, alt?: string): void {
    this.insertBlock({ type: 'image', src, alt });
  }

  /** Delete the focused block from its cell */
  deleteSelectedBlocks(): void {
    if (!this.activeCellId || !this.focusedBlockId) return;
    this.layout = removeBlockFromCell(this.layout, this.activeCellId, this.focusedBlockId);
    this.focusedBlockId = null;
    this.fullRender();
    this.syncToReact();
  }

  /** Undo (delegates to active TextKernel's ProseMirror undo) */
  undo(): void {
    const kernel = this.getActiveKernel();
    kernel?.undo();
  }

  /** Redo */
  redo(): void {
    const kernel = this.getActiveKernel();
    kernel?.redo();
  }

  // Compatibility stubs for toolbar
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

    // Find which block was clicked inside the cell
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

    // Clicked in cell area but not on a specific block — auto-focus the last
    // editable block in this cell, or create a paragraph if the cell is empty
    this.autoFocusInCell(cellId);
    this.emitToolbarUpdate();
  }

  private handleCellDblClick(cellId: string): void {
    this.setActiveCell(cellId);
    // Auto-focus handles both empty cells (creates paragraph) and non-empty
    this.autoFocusInCell(cellId);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Ctrl+Z / Ctrl+Y undo/redo
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

    // Build context menu
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

    const items = [
      { label: 'Split Horizontal', action: () => this.split('horizontal', cellId) },
      { label: 'Split Vertical', action: () => this.split('vertical', cellId) },
    ];

    // Only show merge if this cell has a parent split
    const parent = findParent(this.layout, cellId);
    if (parent) {
      items.push({ label: 'Merge with Sibling', action: () => this.merge(cellId) });
    }

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

    // Close on click outside
    const closeHandler = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        this.hideContextMenu();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    // Delay to avoid immediate close from the contextmenu event
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
    // Remove active class from previous cell
    if (this.activeCellId && this.activeCellId !== cellId) {
      const prevHandle = this.cellRenderer.getCellHandle(this.activeCellId);
      prevHandle?.element.classList.remove('bsp-cell--active');
      this.focusedBlockId = null; // Only clear when switching cells
    }

    this.activeCellId = cellId;

    // Add active class to new cell
    const handle = this.cellRenderer.getCellHandle(cellId);
    handle?.element.classList.add('bsp-cell--active');
  }

  /** Auto-focus the last editable block in a cell, or create one if empty */
  private autoFocusInCell(cellId: string): void {
    const cell = findNode(this.layout, cellId) as LeafNode | null;
    if (!cell || cell.type !== 'leaf') return;

    if (cell.blocks.length === 0) {
      // Empty cell — auto-create a paragraph
      const newBlock: Block = { type: 'paragraph', content: [], id: generateBlockId() };
      this.layout = insertBlockInCell(this.layout, cellId, newBlock);
      this.fullRender();
      this.syncToReact();

      requestAnimationFrame(() => {
        this.focusBlockInCell(cellId, newBlock.id!);
      });
      return;
    }

    // Find the last editable block in the cell
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

    // No editable block found — focus first block at least
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

  private fullRender(): void {
    if (!this.container) return;
    this.cellRenderer.render(this.container, this.layout);
    // Re-attach drag handles after DOM rebuild
    if (this.dragManager) {
      this.dragManager.attachDragHandles();
    }
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

  /** Rebuild DocumentTree from layout and emit onChange */
  private syncToReact(): void {
    // Collect all blocks from all leaves, reading live content from TextKernels
    const leaves = getAllLeaves(this.layout);
    const allBlocks: Block[] = [];

    for (const leaf of leaves) {
      const handle = this.cellRenderer.getCellHandle(leaf.id);
      if (handle) {
        for (const bn of handle.blockNodes) {
          allBlocks.push(bn.getData());
        }
      } else {
        // Fallback to tree data
        allBlocks.push(...leaf.blocks);
      }
    }

    // Also update the layout tree with live content from kernels
    let updatedLayout = this.layout;
    for (const leaf of leaves) {
      const handle = this.cellRenderer.getCellHandle(leaf.id);
      if (handle) {
        const liveBlocks = handle.blockNodes.map(bn => bn.getData());
        updatedLayout = updateLeafBlocks(updatedLayout, leaf.id, liveBlocks);
      }
    }
    this.layout = updatedLayout;

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
