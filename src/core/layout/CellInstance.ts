// ============================================================================
// CellInstance — Persistent cell that owns its DOM + ProseMirror kernels
//
// A CellInstance is created ONCE and lives until the cell is explicitly removed
// (merge or page deletion). Split/resize operations reparent the cell's DOM
// element without destroying it — ProseMirror survives reparenting.
//
// This is the SINGLE authority for a cell's content. No dual tree-vs-kernel
// state. The cell owns its blocks, period.
// ============================================================================

import type { Block, InlineContent } from '../model/DocumentTree';
import type { ITextKernel } from '../engine/types';
import type { BlockNode } from '../engine/BlockNode';
import { BlockRenderer } from '../engine/BlockRenderer';
import { BlockRegistry } from '../engine/BlockRegistry';
import { generateBlockId } from '../engine/BlockId';

// --- Types ---

export type KernelFactory = (node: BlockNode, el: HTMLElement, block: Block) => ITextKernel;

export interface CellInstanceConfig {
  kernelFactory: KernelFactory;
  registry: BlockRegistry;
  blockRenderer: BlockRenderer;
  onContentChange?: (cellId: string) => void;
  onSelectionChange?: (cellId: string) => void;
}

// --- CellInstance ---

export class CellInstance {
  readonly id: string;
  readonly element: HTMLElement;
  readonly contentElement: HTMLElement;

  private blocks: BlockNode[] = [];
  private config: CellInstanceConfig;

  constructor(id: string, config: CellInstanceConfig, initialBlocks: Block[] = []) {
    this.id = id;
    this.config = config;

    // Create cell DOM — once, never again
    this.element = document.createElement('div');
    this.element.classList.add('bsp-cell');
    this.element.dataset.cellId = id;

    this.contentElement = document.createElement('div');
    this.contentElement.classList.add('bsp-cell-content');
    this.element.appendChild(this.contentElement);

    // Render initial blocks
    if (initialBlocks.length > 0) {
      for (const block of initialBlocks) {
        this.createAndAppendBlock(block);
      }
    } else {
      this.contentElement.classList.add('bsp-cell-empty');
    }
  }

  // =====================
  //  CONTENT READS
  // =====================

  /** Read live content from kernels — always authoritative */
  getContent(): Block[] {
    return this.blocks.map(bn => bn.getData());
  }

  /** Get the live BlockNode instances */
  getBlockNodes(): BlockNode[] {
    return this.blocks;
  }

  /** Number of blocks in this cell */
  blockCount(): number {
    return this.blocks.length;
  }

  /** Is this cell empty? */
  isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  /** Find a BlockNode by ID */
  getBlockNode(blockId: string): BlockNode | undefined {
    return this.blocks.find(bn => bn.id === blockId);
  }

  // =====================
  //  CONTENT MUTATIONS
  //  All local DOM operations — no global render
  // =====================

  /** Add a block at the end or at a specific index */
  addBlock(block: Block, index?: number): BlockNode {
    const blockWithId = block.id ? block : { ...block, id: generateBlockId() };
    const node = this.createAndAppendBlock(blockWithId, index);
    this.updateEmptyState();
    return node;
  }

  /** Remove trailing blocks starting from index. Returns the removed block data. */
  trimFrom(index: number): Block[] {
    if (index >= this.blocks.length) return [];

    const removed = this.blocks.splice(index);
    const removedData: Block[] = [];

    for (const bn of removed) {
      removedData.push(bn.getData());
      this.config.registry.unregister(bn.id);
      bn.destroy(); // removes DOM, destroys kernel
    }

    this.updateEmptyState();
    return removedData;
  }

  /** Receive overflow blocks from a previous cell — prepend at the top */
  prependBlocks(blocks: Block[]): void {
    const firstExisting = this.contentElement.firstChild;

    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const node = this.createBlockNode(block);
      this.config.registry.register(node);
      this.blocks.unshift(node);

      if (firstExisting) {
        this.contentElement.insertBefore(node.element, firstExisting);
      } else {
        this.contentElement.appendChild(node.element);
      }
    }

    this.updateEmptyState();
  }

  /** Append blocks at the end (for merge — absorb sibling's content) */
  appendBlocks(blocks: Block[]): void {
    for (const block of blocks) {
      this.createAndAppendBlock(block);
    }
    this.updateEmptyState();
  }

  /** Remove all blocks and return their data (for merge — this cell is being absorbed) */
  drainAll(): Block[] {
    const data = this.getContent();

    for (const bn of this.blocks) {
      this.config.registry.unregister(bn.id);
      bn.destroy();
    }
    this.blocks = [];

    this.updateEmptyState();
    return data;
  }

  /**
   * Replace a block at a specific index with new data.
   * Destroys the old block and creates a new one in its place.
   * Used for line-level overflow splitting (replacing a paragraph with its first half).
   */
  replaceBlock(index: number, newBlockData: Block): BlockNode | null {
    if (index < 0 || index >= this.blocks.length) return null;

    const old = this.blocks[index];
    const refElement = old.element.nextSibling;

    // Destroy old
    this.config.registry.unregister(old.id);
    old.destroy();

    // Create new
    const node = this.createBlockNode(newBlockData);
    this.config.registry.register(node);
    this.blocks[index] = node;

    // Insert at same position
    if (refElement) {
      this.contentElement.insertBefore(node.element, refElement);
    } else {
      this.contentElement.appendChild(node.element);
    }

    return node;
  }

  /** Remove a specific block by ID */
  removeBlock(blockId: string): Block | null {
    const index = this.blocks.findIndex(bn => bn.id === blockId);
    if (index === -1) return null;

    const [bn] = this.blocks.splice(index, 1);
    const data = bn.getData();
    this.config.registry.unregister(bn.id);
    bn.destroy();

    this.updateEmptyState();
    return data;
  }

  // =====================
  //  STREAM SLICE — Content Stream Model
  // =====================

  /** The stream range this cell currently displays */
  private sliceStart = 0;
  private sliceEnd = 0;

  /** Get the current stream range */
  getStreamRange(): { start: number; end: number } {
    return { start: this.sliceStart, end: this.sliceEnd };
  }

  /**
   * Set the blocks this cell should display (from the ContentStream).
   *
   * Reconciles against current blocks by ID:
   *   - Same ID → keep existing BlockNode (ProseMirror preserved)
   *   - New ID → create new BlockNode
   *   - Missing ID → destroy BlockNode
   *
   * This is the CORE of the Content Stream Model. Cells don't own blocks —
   * they receive slices to display.
   */
  setSlice(blocks: Block[], startIndex: number, endIndex: number): void {
    this.sliceStart = startIndex;
    this.sliceEnd = endIndex;

    // Build map of current blocks by ID for O(1) lookup
    const currentMap = new Map<string, BlockNode>();
    for (const bn of this.blocks) {
      currentMap.set(bn.id, bn);
    }

    const newBlockIds = new Set(blocks.map(b => b.id).filter(Boolean) as string[]);

    // Destroy blocks no longer in this cell's slice
    for (const [id, bn] of currentMap) {
      if (!newBlockIds.has(id)) {
        this.config.registry.unregister(bn.id);
        bn.destroy(); // removes DOM + kernel
      }
    }

    // Build new block array, reusing existing BlockNodes where possible
    const newBlocks: BlockNode[] = [];
    for (const block of blocks) {
      const existing = block.id ? currentMap.get(block.id) : undefined;
      if (existing) {
        // Reuse existing BlockNode — ProseMirror editor preserved!
        // Don't update content from stream — PM editor IS the authority
        // for blocks currently being displayed. Stream was already updated
        // by the PM editor's onUpdate callback.
        newBlocks.push(existing);
      } else {
        // Create new BlockNode from stream data
        const node = this.createBlockNode(block);
        this.config.registry.register(node);
        newBlocks.push(node);
      }
    }

    // Reorder DOM to match new slice order.
    // appendChild on already-attached children MOVES them (no duplication).
    this.blocks = newBlocks;
    for (const bn of newBlocks) {
      this.contentElement.appendChild(bn.element);
    }

    this.updateEmptyState();
  }

  /**
   * Clear all blocks from this cell (used before setSlice on fresh layout).
   */
  clearBlocks(): void {
    for (const bn of this.blocks) {
      this.config.registry.unregister(bn.id);
      bn.destroy();
    }
    this.blocks = [];
    this.updateEmptyState();
  }

  // =====================
  //  NORMALIZATION (legacy — used by old overflow system)
  // =====================

  /**
   * Normalize multi-paragraph ProseMirror editors into individual blocks.
   *
   * When content is pasted, ProseMirror creates multiple <p> elements inside
   * a single editor. The serialized Block has { type: 'break' } separating
   * paragraphs. This method splits such blocks into individual BlockNodes,
   * enabling block-level overflow detection.
   *
   * Returns true if any blocks were split.
   */
  normalizeBlocks(): boolean {
    let changed = false;
    const newBlocks: BlockNode[] = [];

    for (const bn of this.blocks) {
      const data = bn.getData();
      const split = splitBlockByBreaks(data);

      if (split.length > 1) {
        changed = true;

        // Get reference element before destroying (to insert at correct position)
        const refElement = bn.element.nextSibling;

        // Destroy the original multi-paragraph block
        this.config.registry.unregister(bn.id);
        bn.destroy();

        // Create individual blocks at the correct DOM position
        for (const blockData of split) {
          const node = this.createBlockNode(blockData);
          this.config.registry.register(node);

          if (refElement) {
            this.contentElement.insertBefore(node.element, refElement);
          } else {
            this.contentElement.appendChild(node.element);
          }

          newBlocks.push(node);
        }
      } else {
        newBlocks.push(bn);
      }
    }

    if (changed) {
      this.blocks = newBlocks;
      this.updateEmptyState();
    }

    return changed;
  }

  // =====================
  //  FOCUS
  // =====================

  /** Focus the last editable block in this cell */
  focusLastEditable(): BlockNode | null {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const bn = this.blocks[i];
      if (bn.isEditable() && bn.kernel) {
        bn.kernel.focus();
        return bn;
      }
    }
    return null;
  }

  /** Focus a specific block by ID */
  focusBlock(blockId: string): boolean {
    const bn = this.getBlockNode(blockId);
    if (bn?.isEditable() && bn.kernel) {
      bn.kernel.focus();
      return true;
    }
    return false;
  }

  /** Ensure the cell has at least one editable block, creating one if needed */
  ensureEditable(): BlockNode {
    if (this.blocks.length === 0) {
      return this.addBlock({ type: 'paragraph', content: [], id: generateBlockId() });
    }

    // Find an existing editable block
    const editable = this.blocks.find(bn => bn.isEditable());
    if (editable) return editable;

    // No editable blocks — add a paragraph
    return this.addBlock({ type: 'paragraph', content: [], id: generateBlockId() });
  }

  // =====================
  //  VISUAL STATE
  // =====================

  setActive(active: boolean): void {
    this.element.classList.toggle('bsp-cell--active', active);
  }

  // =====================
  //  LIFECYCLE
  // =====================

  /** Destroy this cell — remove all blocks, remove DOM */
  destroy(): void {
    for (const bn of this.blocks) {
      this.config.registry.unregister(bn.id);
      bn.destroy();
    }
    this.blocks = [];
    this.element.remove();
  }

  // =====================
  //  INTERNAL
  // =====================

  private createAndAppendBlock(block: Block, index?: number): BlockNode {
    const node = this.createBlockNode(block);
    this.config.registry.register(node);

    if (index !== undefined && index >= 0 && index < this.blocks.length) {
      const refNode = this.blocks[index];
      this.contentElement.insertBefore(node.element, refNode.element);
      this.blocks.splice(index, 0, node);
    } else {
      this.contentElement.appendChild(node.element);
      this.blocks.push(node);
    }

    return node;
  }

  private createBlockNode(block: Block): BlockNode {
    const node = this.config.blockRenderer.createSingleBlock(block, false);

    // Wire up kernel callbacks for content/selection change propagation
    if (node.kernel) {
      this.wireKernelCallbacks(node);
    }

    return node;
  }

  private wireKernelCallbacks(node: BlockNode): void {
    if (!node.kernel) return;

    node.kernel.onUpdate(() => {
      node.onKernelChange();
      this.config.onContentChange?.(this.id);
    });

    node.kernel.onSelectionUpdate?.(() => {
      this.config.onSelectionChange?.(this.id);
    });
  }

  private updateEmptyState(): void {
    this.contentElement.classList.toggle('bsp-cell-empty', this.blocks.length === 0);
  }
}

// ============================================================================
// Utility: Split a Block by its break elements into individual blocks
// ============================================================================

/**
 * Split a paragraph/heading Block that contains { type: 'break' } separators
 * into multiple individual Blocks (one per paragraph).
 *
 * ProseMirror packs multiple <p> elements into one Block during serialization,
 * using break inlines as separators. This undoes that packing.
 *
 * Returns [block] unchanged if no breaks found.
 */
function splitBlockByBreaks(block: Block): Block[] {
  if (block.type !== 'paragraph' && block.type !== 'heading') return [block];
  if (!block.content || block.content.length === 0) return [block];

  // Check if there are any breaks
  const hasBreaks = block.content.some(item => item.type === 'break');
  if (!hasBreaks) return [block];

  // Split content on break elements
  const segments: InlineContent[][] = [[]];
  for (const item of block.content) {
    if (item.type === 'break') {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(item);
    }
  }

  if (segments.length <= 1) return [block];

  // Create a Block for each segment
  return segments.map((content, i) => {
    if (i === 0) {
      // First segment keeps original block type, ID, and alignment
      // Clear pmDocJson since we're splitting the PM document
      return { ...block, content, pmDocJson: undefined };
    }
    // Subsequent segments become paragraphs
    return {
      type: 'paragraph' as const,
      content,
      alignment: (block as any).alignment,
      id: generateBlockId(),
    };
  });
}
