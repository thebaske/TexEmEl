// ============================================================================
// BlockRegistry — Central registry of all live BlockNode instances
//
// Provides O(1) lookup by ID, manages root block ordering,
// and resolves DOM elements back to BlockNodes.
// ============================================================================

import { BlockNode } from './BlockNode';

export class BlockRegistry {
  private blocks = new Map<string, BlockNode>();
  private rootOrder: string[] = [];
  private container: HTMLElement | null = null;

  setContainer(container: HTMLElement): void {
    this.container = container;
  }

  // --- Registration ---

  register(node: BlockNode): void {
    this.blocks.set(node.id, node);
  }

  registerRoot(node: BlockNode, index?: number): void {
    this.register(node);
    if (index !== undefined && index >= 0 && index <= this.rootOrder.length) {
      this.rootOrder.splice(index, 0, node.id);
    } else {
      this.rootOrder.push(node.id);
    }
  }

  unregister(id: string): void {
    this.blocks.delete(id);
    const rootIdx = this.rootOrder.indexOf(id);
    if (rootIdx !== -1) {
      this.rootOrder.splice(rootIdx, 1);
    }
  }

  // --- Lookup ---

  get(id: string): BlockNode | undefined {
    return this.blocks.get(id);
  }

  has(id: string): boolean {
    return this.blocks.has(id);
  }

  getAll(): Map<string, BlockNode> {
    return this.blocks;
  }

  /** Get root-level blocks in display order */
  getRootBlocks(): BlockNode[] {
    return this.rootOrder
      .map(id => this.blocks.get(id))
      .filter((n): n is BlockNode => n !== undefined);
  }

  getRootOrder(): string[] {
    return [...this.rootOrder];
  }

  getRootIndex(id: string): number {
    return this.rootOrder.indexOf(id);
  }

  // --- Order Management ---

  moveToIndex(id: string, newIndex: number): void {
    const oldIndex = this.rootOrder.indexOf(id);
    if (oldIndex === -1) return;
    this.rootOrder.splice(oldIndex, 1);
    this.rootOrder.splice(newIndex, 0, id);
  }

  setRootOrder(order: string[]): void {
    this.rootOrder = [...order];
  }

  // --- DOM Resolution ---

  /**
   * Walk up from a DOM element to find the nearest BlockNode.
   * Uses data-block-id attributes set by BlockNode constructor.
   */
  findByElement(el: HTMLElement): BlockNode | null {
    let current: HTMLElement | null = el;
    while (current && current !== this.container) {
      const id = current.dataset.blockId;
      if (id) {
        return this.blocks.get(id) ?? null;
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * Find the nearest BlockNode for a DOM element, but only return
   * root-level blocks (not nested children inside containers).
   */
  findRootByElement(el: HTMLElement): BlockNode | null {
    const node = this.findByElement(el);
    if (!node) return null;
    // Walk up to root
    let current = node;
    while (current.parent) {
      current = current.parent;
    }
    return current;
  }

  // --- Bulk Operations ---

  size(): number {
    return this.blocks.size;
  }

  rootSize(): number {
    return this.rootOrder.length;
  }

  /** Destroy all blocks and clear the registry */
  clear(): void {
    // Destroy root blocks (cascades to children)
    for (const id of this.rootOrder) {
      const node = this.blocks.get(id);
      node?.destroy();
    }
    this.blocks.clear();
    this.rootOrder = [];
  }
}
