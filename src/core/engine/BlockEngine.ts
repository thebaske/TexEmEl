// ============================================================================
// BlockEngine — The orchestrator
//
// Wires together all subsystems and exposes the public API that React
// (Editor.tsx) and the toolbar call. This is the single entry point
// for the entire custom editor engine.
// ============================================================================

import type { Block, ContainerStyle, DocumentTree, TextMark } from '../model/DocumentTree';
import { assignBlockIds } from './BlockId';
import { BlockRegistry } from './BlockRegistry';
import { BlockRenderer } from './BlockRenderer';
import { EventRouter } from './EventRouter';
import { SelectionManager } from './SelectionManager';
import { CommandHistory } from './CommandHistory';
import { DragManager } from './DragManager';
import { ResizeManager } from './ResizeManager';
import { EdgeDragManager } from './EdgeDragManager';
import {
  EngineEvent,
  type BlockClickPayload,
  type KeyDownPayload,
  type PastePayload,
  type OnChangeCallback,
  type OnSelectionCallback,
  type EngineConfig,
  DEFAULT_ENGINE_CONFIG,
  type ITextKernel,
} from './types';
import { BlockNode } from './BlockNode';
import { generateBlockId } from './BlockId';

export class BlockEngine {
  private container: HTMLElement | null = null;
  private config: EngineConfig;
  private tree: DocumentTree;

  // Subsystems
  private registry = new BlockRegistry();
  private renderer = new BlockRenderer(this.registry);
  private eventRouter: EventRouter | null = null;
  private selection: SelectionManager;
  private history: CommandHistory;
  private dragManager: DragManager | null = null;
  private resizeManager: ResizeManager;
  private edgeDragManager: EdgeDragManager | null = null;

  // Callbacks
  private onChangeCallbacks: OnChangeCallback[] = [];
  private onSelectionCallbacks: OnSelectionCallback[] = [];
  private onToolbarUpdateCallbacks: (() => void)[] = [];

  // Debounce
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  // TextKernel factory — injected by the consumer so engine doesn't import ProseMirror
  private kernelFactory: ((node: BlockNode, el: HTMLElement, block: Block) => ITextKernel) | null = null;

  constructor(config?: Partial<EngineConfig>) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.selection = new SelectionManager(this.registry);
    this.history = new CommandHistory(this.config.maxHistory);
    this.resizeManager = new ResizeManager(this.registry, {
      onResize: (blockId, width, height) => this.handleResize(blockId, width, height),
    });
    this.tree = { blocks: [], metadata: {} };
  }

  // =====================
  //  LIFECYCLE
  // =====================

  /** Set the factory function for creating TextKernel instances */
  setKernelFactory(factory: (node: BlockNode, el: HTMLElement, block: Block) => ITextKernel): void {
    this.kernelFactory = factory;

    // Wire the renderer to use it
    this.renderer.setMountKernel((node, contentEl, block) => {
      const kernel = this.kernelFactory!(node, contentEl, block);
      node.mountKernel(kernel);

      // When the kernel reports a text change, debounce sync to React
      kernel.onUpdate(() => {
        node.onKernelChange();
        this.debouncedSync();
        this.emitToolbarUpdate();
      });

      // When the cursor moves (selection change without doc change), update toolbar
      kernel.onSelectionUpdate?.(() => {
        this.emitToolbarUpdate();
      });

      // When Enter is pressed at end of an empty last paragraph, create a new block
      kernel.onEnterAtEnd?.(() => {
        this.insertBlockAfter(node.id, { type: 'paragraph', content: [] });
      });
    });
  }

  /** Mount the engine into a DOM container with initial content */
  mount(container: HTMLElement, tree: DocumentTree): void {
    this.container = container;
    this.registry.setContainer(container);

    // Make container focusable for keyboard events when no block is focused
    container.tabIndex = -1;
    container.style.outline = 'none';
    container.style.position = 'relative';

    // Assign IDs to all blocks
    this.tree = {
      ...tree,
      blocks: assignBlockIds(tree.blocks),
    };

    // Create subsystems that need the container
    this.eventRouter = new EventRouter(container, this.registry);
    this.dragManager = new DragManager(container, this.registry, {
      onReorder: (blockId, newIndex) => this.handleReorder(blockId, newIndex),
    });
    this.edgeDragManager = new EdgeDragManager(container, this.registry, {
      onStyleChange: (blockId, style) => this.handleStyleChange(blockId, style),
    });

    // Tell renderer about drag manager so it can attach handles
    this.renderer.setDragManager(this.dragManager);

    // Wire events
    this.eventRouter.on(EngineEvent.BlockClick, this.handleBlockClick);
    this.eventRouter.on(EngineEvent.BlockDoubleClick, this.handleBlockDblClick);
    this.eventRouter.on(EngineEvent.KeyDown, this.handleKeyDown);
    this.eventRouter.on(EngineEvent.Paste, this.handlePaste);

    // Wire edge drag detection — only when NOT editing text
    this.eventRouter.onRawMouseMove((e: MouseEvent) => {
      if (!this.selection.isEditing()) {
        this.edgeDragManager?.handleMouseMove(e);
      }
    });
    this.eventRouter.onRawPointerDown((e: PointerEvent) => {
      if (!this.selection.isEditing()) {
        this.edgeDragManager?.handlePointerDown(e);
      }
    });

    // Wire selection changes → show/hide resize handles + toolbar update
    this.selection.onChange((ids) => {
      if (ids.length === 1) {
        this.resizeManager.showHandles(ids[0]);
      } else {
        this.resizeManager.hideHandles();
      }
      for (const cb of this.onSelectionCallbacks) cb(ids);
      this.emitToolbarUpdate();
    });

    // Render
    this.renderer.renderFull(container, this.tree.blocks);
  }

  /** Update content from external source (file open, undo from React) */
  update(tree: DocumentTree): void {
    if (!this.container) return;

    const newTree = {
      ...tree,
      blocks: assignBlockIds(tree.blocks),
    };

    this.renderer.diff(this.container, this.tree.blocks, newTree.blocks);
    this.tree = newTree;
  }

  /** Cleanup everything */
  destroy(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.eventRouter?.destroy();
    this.dragManager?.destroy();
    this.resizeManager.destroy();
    this.edgeDragManager?.destroy();
    this.registry.clear();
    this.history.clear();
    this.onChangeCallbacks = [];
    this.onSelectionCallbacks = [];
    this.onToolbarUpdateCallbacks = [];
    this.container = null;
  }

  // =====================
  //  CALLBACKS
  // =====================

  onChange(callback: OnChangeCallback): void {
    this.onChangeCallbacks.push(callback);
  }

  onSelectionChange(callback: OnSelectionCallback): void {
    this.onSelectionCallbacks.push(callback);
  }

  /** Subscribe to toolbar-relevant state changes (marks, selection, cursor) */
  onToolbarUpdate(callback: () => void): void {
    this.onToolbarUpdateCallbacks.push(callback);
  }

  // =====================
  //  COMMANDS (toolbar)
  // =====================

  /** Toggle a text mark on the current selection (bold, italic, etc.) */
  applyMark(markType: string, attrs?: Record<string, unknown>): void {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const block = this.registry.get(focusedId);
    block?.kernel?.toggleMark(markType, attrs);
  }

  /** Get active marks at cursor position (for toolbar button state) */
  getActiveMarks(): TextMark[] {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return [];
    const block = this.registry.get(focusedId);
    return block?.kernel?.getActiveMarks() ?? [];
  }

  /** Set text alignment on the focused block */
  setTextAlign(align: string): void {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const block = this.registry.get(focusedId);
    block?.kernel?.setTextAlign(align);
  }

  /** Get text alignment of the focused block */
  getTextAlign(): string {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return 'left';
    const block = this.registry.get(focusedId);
    return block?.kernel?.getTextAlign() ?? 'left';
  }

  /** Set font family on the focused block's selection */
  setFontFamily(family: string): void {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const block = this.registry.get(focusedId);
    block?.kernel?.setFontFamily(family);
  }

  /** Set font size on the focused block's selection */
  setFontSize(size: string): void {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const block = this.registry.get(focusedId);
    block?.kernel?.setFontSize(size);
  }

  /** Insert a link on the focused block's selection */
  insertLink(href: string, title?: string): void {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const block = this.registry.get(focusedId);
    block?.kernel?.insertLink(href, title);
  }

  /** Remove link from the focused block's selection */
  removeLink(): void {
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const block = this.registry.get(focusedId);
    block?.kernel?.removeLink();
  }

  /** Get the type of the currently focused/selected block (e.g. "paragraph", "heading:2") */
  getActiveBlockType(): string | null {
    const focusedId = this.selection.getFocused();
    const id = focusedId ?? (this.selection.getSelected().length === 1 ? this.selection.getSelected()[0] : null);
    if (!id) return null;
    const node = this.registry.get(id);
    if (!node) return null;
    const data = node.getData();
    if (data.type === 'heading') return `heading:${data.level}`;
    return data.type;
  }

  /** Change the focused block's type (paragraph ↔ heading) */
  setBlockType(type: string): void {
    if (!this.container) return;
    const focusedId = this.selection.getFocused();
    if (!focusedId) return;
    const node = this.registry.get(focusedId);
    if (!node) return;

    const currentData = node.getData();
    // Only convert between paragraph and heading
    if (currentData.type !== 'paragraph' && currentData.type !== 'heading') return;

    const content = currentData.content;
    const alignment = currentData.alignment;
    let newBlock: Block;

    if (type === 'paragraph') {
      newBlock = { type: 'paragraph', content, alignment, id: currentData.id, containerStyle: currentData.containerStyle };
    } else if (type.startsWith('heading:')) {
      const level = parseInt(type.split(':')[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      newBlock = { type: 'heading', level, content, alignment, id: currentData.id, containerStyle: currentData.containerStyle };
    } else {
      return;
    }

    // Replace the block: destroy old, create new at same position
    const index = this.registry.getRootIndex(focusedId);
    this.selection.exitEditMode();
    this.registry.unregister(focusedId);
    node.destroy();

    const newNode = this.createAndRegisterBlock(newBlock, index);
    this.insertDomAt(newNode.element, index);
    this.syncToReact();

    // Re-enter edit mode on the new block
    if (newNode.isEditable() && newNode.kernel) {
      requestAnimationFrame(() => {
        this.selection.enterEditMode(newNode.id);
      });
    }
  }

  /** Get all selected block IDs */
  getSelectedBlockIds(): string[] {
    return this.selection.getSelected();
  }

  /** Get the focused (text-editing) block ID */
  getFocusedBlockId(): string | null {
    return this.selection.getFocused();
  }

  /** Insert a table block */
  insertTable(rows: number, cols: number): void {
    const emptyCell = () => ({ content: [] });
    const block: Block = {
      type: 'table',
      headers: Array.from({ length: cols }, emptyCell),
      rows: Array.from({ length: rows - 1 }, () =>
        Array.from({ length: cols }, emptyCell)
      ),
    };
    this.insertBlock(block);
  }

  /** Insert an image from a data URL or path */
  insertImage(src: string, alt?: string): void {
    const imageBlock: Block = { type: 'image', src, alt };
    const containerBlock: Block = {
      type: 'container',
      id: generateBlockId(),
      children: [imageBlock],
      layout: 'flow',
      containerStyle: { display: 'inline-block' },
    };
    this.insertBlock(containerBlock);
  }

  /** Insert a new block after the current selection */
  insertBlock(block: Block, position: 'before' | 'after' = 'after'): void {
    if (!this.container) return;
    const newBlock = { ...block, id: generateBlockId() };
    const selected = this.selection.getSelected();
    const anchorId = selected[selected.length - 1] ?? null;

    let index: number;
    if (anchorId) {
      const anchorIdx = this.registry.getRootIndex(anchorId);
      index = position === 'after' ? anchorIdx + 1 : anchorIdx;
    } else {
      index = this.registry.rootSize();
    }

    // Direct manipulation (no CommandHistory for now — add later)
    const node = this.createAndRegisterBlock(newBlock, index);
    this.insertDomAt(node.element, index);
    this.syncToReact();
  }

  /** Insert a block after a specific block ID, and focus the new block */
  insertBlockAfter(afterId: string, block: Block): void {
    if (!this.container) return;
    const newBlock = { ...block, id: generateBlockId() };
    const anchorIdx = this.registry.getRootIndex(afterId);
    const index = anchorIdx === -1 ? this.registry.rootSize() : anchorIdx + 1;

    const node = this.createAndRegisterBlock(newBlock, index);
    this.insertDomAt(node.element, index);
    this.syncToReact();

    // Auto-focus the new block for immediate typing
    if (node.isEditable() && node.kernel) {
      requestAnimationFrame(() => {
        this.selection.enterEditMode(node.id);
      });
    }
  }

  /** Delete all selected blocks */
  deleteSelectedBlocks(): void {
    const selected = this.selection.getSelected();
    if (selected.length === 0) return;

    for (const id of selected) {
      const node = this.registry.get(id);
      if (node) {
        this.registry.unregister(id);
        node.destroy();
      }
    }

    this.selection.clearSelection();
    this.syncToReact();
  }

  /** Wrap selected blocks in a container */
  wrapInContainer(layout: 'flow' | 'flex-row' | 'flex-column' = 'flow'): void {
    if (!this.container) return;
    const selectedIds = this.selection.getSelected();
    if (selectedIds.length === 0) return;

    // Find the first selected block's index
    const rootOrder = this.registry.getRootOrder();
    const indices = selectedIds
      .map(id => rootOrder.indexOf(id))
      .filter(i => i !== -1)
      .sort((a, b) => a - b);
    if (indices.length === 0) return;

    // Collect selected blocks' data
    const childBlocks: Block[] = [];
    for (const idx of indices) {
      const id = rootOrder[idx];
      const node = this.registry.get(id);
      if (node) childBlocks.push(node.getData());
    }

    // Remove selected blocks from registry and DOM
    for (const id of selectedIds) {
      const node = this.registry.get(id);
      if (node) {
        this.registry.unregister(id);
        node.destroy();
      }
    }

    // Create container block
    const containerBlock: Block = {
      type: 'container',
      id: generateBlockId(),
      children: childBlocks,
      layout,
    };

    // Insert at the first selected position
    const insertIdx = indices[0];
    const newBlocks = [...this.registry.getRootBlocks().map(n => n.getData())];
    newBlocks.splice(insertIdx, 0, containerBlock);

    // Re-render with the new tree
    const newTree = {
      ...this.tree,
      blocks: assignBlockIds(newBlocks),
    };
    this.renderer.renderFull(this.container, newTree.blocks);
    this.tree = newTree;
    this.selection.clearSelection();
    this.syncToReact();
  }

  /** Move a block to a new root index */
  moveBlock(blockId: string, newIndex: number): void {
    if (!this.container) return;
    this.registry.moveToIndex(blockId, newIndex);
    this.renderer.reorderDomPublic(this.container, this.registry.getRootOrder());
    this.syncToReact();
  }

  // =====================
  //  UNDO / REDO
  // =====================

  undo(): void {
    // Text-level undo first if editing
    const focusedId = this.selection.getFocused();
    if (focusedId) {
      const block = this.registry.get(focusedId);
      if (block?.kernel?.undo()) return;
    }
    // Block-level undo
    if (this.history.undo()) {
      this.syncToReact();
    }
  }

  redo(): void {
    const focusedId = this.selection.getFocused();
    if (focusedId) {
      const block = this.registry.get(focusedId);
      if (block?.kernel?.redo()) return;
    }
    if (this.history.redo()) {
      this.syncToReact();
    }
  }

  canUndo(): boolean { return this.history.canUndo(); }
  canRedo(): boolean { return this.history.canRedo(); }

  // =====================
  //  EVENT HANDLERS
  // =====================

  private handleBlockClick = (payload: BlockClickPayload): void => {
    if (!payload.blockId) {
      this.selection.clearSelection();
      return;
    }

    // If clicking inside an already-focused block, let ProseMirror handle it
    if (this.selection.isFocused(payload.blockId)) return;

    if (payload.shiftKey) {
      this.selection.rangeSelect(payload.blockId);
    } else if (payload.ctrlKey || payload.metaKey) {
      this.selection.toggleSelect(payload.blockId);
    } else {
      // Single click on a text-editable block → enter edit mode directly
      const node = this.registry.get(payload.blockId);
      if (node?.isEditable() && node.kernel) {
        // skipFocus=true: the browser click already placed ProseMirror's cursor
        this.selection.enterEditMode(payload.blockId, true);
      } else {
        this.selection.select(payload.blockId);
      }
    }
  };

  private handleBlockDblClick = (payload: BlockClickPayload): void => {
    if (!payload.blockId) return;
    this.selection.enterEditMode(payload.blockId);
  };

  private handleKeyDown = (payload: KeyDownPayload): void => {
    const e = payload.event;

    // Global shortcuts (work regardless of mode)
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      // Only select-all if NOT in text editing mode
      if (!this.selection.isEditing()) {
        e.preventDefault();
        this.selection.selectAll();
        return;
      }
    }

    // If editing text, let ProseMirror handle most keys
    if (this.selection.isEditing()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.selection.exitEditMode();
      }
      return;
    }

    // Block-level navigation (only when not editing text)
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        this.selection.selectPrevious();
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        this.selection.selectNext();
        break;
      case 'Enter': {
        e.preventDefault();
        const selected = this.selection.getSelected();
        if (selected.length === 1) {
          this.selection.enterEditMode(selected[0]);
        }
        break;
      }
      case 'Escape':
        this.selection.clearSelection();
        break;
      case 'Delete':
      case 'Backspace':
        if (this.selection.hasSelection()) {
          e.preventDefault();
          this.deleteSelectedBlocks();
        }
        break;
    }
  };

  private handlePaste = (payload: PastePayload): void => {
    // If editing text, let ProseMirror handle paste
    if (this.selection.isEditing()) return;

    const e = payload.event;
    const dt = e.clipboardData;
    if (!dt) return;

    // Check for image files
    const imageFiles: File[] = [];
    for (let i = 0; i < dt.files.length; i++) {
      if (dt.files[i].type.startsWith('image/')) {
        imageFiles.push(dt.files[i]);
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      for (const file of imageFiles) {
        const reader = new FileReader();
        reader.onload = () => {
          const src = reader.result as string;
          // Auto-wrap image in a container for drag/resize
          const imageBlock: Block = {
            type: 'image',
            src,
            id: generateBlockId(),
          };
          const containerBlock: Block = {
            type: 'container',
            id: generateBlockId(),
            children: [imageBlock],
            layout: 'flow',
            containerStyle: {
              display: 'inline-block',
            },
          };
          this.insertBlock(containerBlock);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  private handleReorder = (blockId: string, newIndex: number): void => {
    this.moveBlock(blockId, newIndex);
  };

  private handleResize = (blockId: string, width: number, height: number): void => {
    const node = this.registry.get(blockId);
    if (!node) return;

    const data = node.getData();
    if (data.type === 'image') {
      // Update image dimensions directly
      const updated: Block = { ...data, width, height };
      node.updateData(updated);
    } else {
      // Update containerStyle
      const updated: Block = {
        ...data,
        containerStyle: ResizeManager.applyResizeToStyle(data.containerStyle, width, height),
      };
      node.updateData(updated);
    }
    this.syncToReact();
  };

  private handleStyleChange = (blockId: string, style: ContainerStyle): void => {
    const node = this.registry.get(blockId);
    if (!node) return;

    const data = node.getData();
    const updated: Block = {
      ...data,
      containerStyle: { ...(data.containerStyle ?? {}), ...style },
    };
    node.updateData(updated);
    this.syncToReact();
  };

  // =====================
  //  INTERNAL
  // =====================

  private emitToolbarUpdate(): void {
    for (const cb of this.onToolbarUpdateCallbacks) cb();
  }

  private debouncedSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncToReact();
    }, this.config.debounceMs);
  }

  /** Rebuild DocumentTree from current BlockNode states and emit onChange */
  private syncToReact(): void {
    const blocks = this.registry.getRootBlocks().map(node => this.collectBlockData(node));
    const newTree: DocumentTree = {
      blocks,
      metadata: {
        ...this.tree.metadata,
        modifiedAt: new Date().toISOString(),
      },
    };
    this.tree = newTree;
    for (const cb of this.onChangeCallbacks) {
      cb(newTree);
    }
  }

  /** Recursively collect Block data from a BlockNode tree */
  private collectBlockData(node: BlockNode): Block {
    const data = node.getData();

    if (node.isContainer() && node.children.length > 0) {
      if (data.type === 'container') {
        return { ...data, children: node.children.map(c => this.collectBlockData(c)) };
      }
      if (data.type === 'blockquote') {
        return { ...data, blocks: node.children.map(c => this.collectBlockData(c)) };
      }
    }

    return data;
  }

  private createAndRegisterBlock(block: Block, index: number): BlockNode {
    // Use the full renderer pipeline: creates DOM, mounts ProseMirror, attaches drag handle
    const node = this.renderer.createSingleBlock(block, true);
    this.registry.registerRoot(node, index);
    return node;
  }

  private insertDomAt(element: HTMLElement, index: number): void {
    if (!this.container) return;
    const children = this.container.children;
    if (index >= children.length) {
      this.container.appendChild(element);
    } else {
      this.container.insertBefore(element, children[index]);
    }
  }
}
