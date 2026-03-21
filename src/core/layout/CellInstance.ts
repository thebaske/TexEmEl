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
  //  NORMALIZATION
  // =====================

  /**
   * Split multi-paragraph ProseMirror editors into individual blocks.
   * Paste creates ONE PM editor with multiple <p> elements.
   * This splits them into separate BlockNodes so page overflow
   * can measure and split at block boundaries.
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
        const refElement = bn.element.nextSibling;

        this.config.registry.unregister(bn.id);
        bn.destroy();

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

function splitBlockByBreaks(block: Block): Block[] {
  if (block.type !== 'paragraph' && block.type !== 'heading') return [block];
  if (!block.content || block.content.length === 0) return [block];

  const hasBreaks = block.content.some((item: InlineContent) => item.type === 'break');
  if (!hasBreaks) return [block];

  const segments: InlineContent[][] = [[]];
  for (const item of block.content) {
    if (item.type === 'break') {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(item);
    }
  }

  if (segments.length <= 1) return [block];

  return segments.map((content, i) => {
    if (i === 0) {
      return { ...block, content, pmDocJson: undefined };
    }
    return {
      type: 'paragraph' as const,
      content,
      alignment: (block as any).alignment,
      id: generateBlockId(),
    };
  });
}
