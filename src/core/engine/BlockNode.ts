// ============================================================================
// BlockNode — Per-block runtime instance
//
// Wraps a DOM element, holds block data, manages optional TextKernel,
// and tracks visual/version state. This is the "component" for each block
// in the editor — vanilla JS, not React.
// ============================================================================

import type { Block } from '../model/DocumentTree';
import { BlockStatus, type ITextKernel } from './types';

export class BlockNode {
  readonly id: string;
  readonly type: Block['type'];

  element: HTMLElement;
  kernel: ITextKernel | null = null;
  children: BlockNode[] = [];
  parent: BlockNode | null = null;
  status: BlockStatus = BlockStatus.Idle;

  /** Incremented by TextKernel on each user edit */
  contentVersion = 0;
  /** Incremented by external updates (file open, undo) */
  treeVersion = 0;

  private data: Block;

  constructor(block: Block, element: HTMLElement) {
    this.id = block.id!;
    this.type = block.type;
    this.data = block;
    this.element = element;
    this.element.dataset.blockId = this.id;
  }

  /**
   * Get current block data, merging TextKernel content if present.
   * Used when syncing the DocumentTree back to React.
   */
  getData(): Block {
    if (this.kernel) {
      return this.kernel.getContent();
    }
    return this.data;
  }

  /**
   * Update from external source (file open, undo, tree update).
   * Only pushes content to TextKernel if the external version is newer.
   */
  updateData(block: Block): void {
    this.data = block;
    this.treeVersion++;

    if (this.kernel && this.treeVersion > this.contentVersion) {
      this.kernel.setContent(block);
      this.contentVersion = this.treeVersion;
    }
  }

  /** Called by TextKernel on each user edit */
  onKernelChange(): void {
    this.contentVersion++;
  }

  /** Mount a TextKernel into this block (for text-editable blocks) */
  mountKernel(kernel: ITextKernel): void {
    this.kernel = kernel;
    kernel.onUpdate(() => this.onKernelChange());
  }

  /** Is this a text-editable block type? */
  isEditable(): boolean {
    return this.type === 'paragraph'
      || this.type === 'heading'
      || this.type === 'codeBlock';
  }

  /** Is this a container with child blocks? */
  isContainer(): boolean {
    return this.type === 'container' || this.type === 'blockquote';
  }

  /** Add a child BlockNode (for containers/blockquotes) */
  addChild(child: BlockNode): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Remove a child by ID */
  removeChild(id: string): BlockNode | undefined {
    const index = this.children.findIndex(c => c.id === id);
    if (index === -1) return undefined;
    const [removed] = this.children.splice(index, 1);
    removed.parent = null;
    return removed;
  }

  /** Cleanup: destroy kernel, remove DOM, cascade to children */
  destroy(): void {
    this.kernel?.destroy();
    this.kernel = null;
    this.element.remove();
    for (const child of this.children) {
      child.destroy();
    }
    this.children = [];
    this.parent = null;
  }
}
