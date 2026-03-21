// ============================================================================
// ContentStream — Single source of truth for document content
//
// The document is ONE ordered array of blocks. Cells don't own content —
// they display computed slices. This eliminates:
//   - Block moving (trimFrom/prependBlocks)
//   - Two-authority problem (PM vs cell blocks)
//   - Content duplication/loss
//
// Analogy: the stream is light, cells are broken glass — each shard shows
// a piece of the same picture.
//
// This file has ZERO DOM dependencies. Pure data.
// ============================================================================

import type { Block, InlineContent } from '../model/DocumentTree';
import { generateBlockId } from '../engine/BlockId';

// --- Types ---

export type StreamChangeCallback = () => void;

export interface StreamBlock {
  /** Index in the stream */
  index: number;
  /** The block data */
  block: Block;
}

// --- ContentStream ---

export class ContentStream {
  private blocks: Block[] = [];
  private changeCallbacks: StreamChangeCallback[] = [];
  private suppressNotify = false;

  // =====================
  //  CONSTRUCTION
  // =====================

  /** Create stream from initial blocks (e.g., from document import) */
  static fromBlocks(blocks: Block[]): ContentStream {
    const stream = new ContentStream();
    // Normalize: split multi-paragraph blocks on entry
    const normalized = blocks.flatMap(b => normalizeBlock(b));
    stream.blocks = normalized.map(b => ({
      ...b,
      id: b.id || generateBlockId(),
    }));
    return stream;
  }

  /** Create empty stream */
  static empty(): ContentStream {
    return new ContentStream();
  }

  // =====================
  //  READ
  // =====================

  /** Total number of blocks */
  get length(): number {
    return this.blocks.length;
  }

  /** Get a block by index */
  get(index: number): Block | undefined {
    return this.blocks[index];
  }

  /** Get a slice of blocks [start, end) */
  getSlice(start: number, end: number): Block[] {
    return this.blocks.slice(start, end);
  }

  /** Get all blocks (for serialization/export) */
  getAll(): Block[] {
    return [...this.blocks];
  }

  /** Find index of a block by ID */
  findIndex(blockId: string): number {
    return this.blocks.findIndex(b => b.id === blockId);
  }

  /** Get a block by ID */
  getById(blockId: string): Block | undefined {
    return this.blocks.find(b => b.id === blockId);
  }

  // =====================
  //  WRITE
  // =====================

  /** Replace a block at an index (e.g., ProseMirror content update) */
  update(index: number, block: Block): void {
    if (index < 0 || index >= this.blocks.length) return;
    this.blocks[index] = block;
    this.notify();
  }

  /** Update a block by ID */
  updateById(blockId: string, block: Block): void {
    const index = this.findIndex(blockId);
    if (index >= 0) {
      this.blocks[index] = block;
      this.notify();
    }
  }

  /** Insert a block at an index */
  insert(index: number, block: Block): void {
    const normalized = normalizeBlock(block);
    const withIds = normalized.map(b => ({
      ...b,
      id: b.id || generateBlockId(),
    }));
    this.blocks.splice(index, 0, ...withIds);
    this.notify();
  }

  /** Append a block at the end */
  append(block: Block): void {
    this.insert(this.blocks.length, block);
  }

  /** Remove a block at an index */
  remove(index: number): Block | undefined {
    if (index < 0 || index >= this.blocks.length) return undefined;
    const [removed] = this.blocks.splice(index, 1);
    this.notify();
    return removed;
  }

  /** Remove a block by ID */
  removeById(blockId: string): Block | undefined {
    const index = this.findIndex(blockId);
    if (index >= 0) return this.remove(index);
    return undefined;
  }

  /** Bulk replace all blocks (e.g., file open) */
  replaceAll(blocks: Block[]): void {
    const normalized = blocks.flatMap(b => normalizeBlock(b));
    this.blocks = normalized.map(b => ({
      ...b,
      id: b.id || generateBlockId(),
    }));
    this.notify();
  }

  /** Batch operations without intermediate notifications */
  batch(fn: () => void): void {
    this.suppressNotify = true;
    try {
      fn();
    } finally {
      this.suppressNotify = false;
      this.notify();
    }
  }

  // =====================
  //  EVENTS
  // =====================

  /** Subscribe to stream changes */
  onChange(callback: StreamChangeCallback): void {
    this.changeCallbacks.push(callback);
  }

  /** Remove a change callback */
  offChange(callback: StreamChangeCallback): void {
    this.changeCallbacks = this.changeCallbacks.filter(cb => cb !== callback);
  }

  /** Clear all callbacks */
  clearCallbacks(): void {
    this.changeCallbacks = [];
  }

  // =====================
  //  INTERNAL
  // =====================

  private notify(): void {
    if (this.suppressNotify) return;
    for (const cb of this.changeCallbacks) {
      cb();
    }
  }
}

// ============================================================================
// Block Normalization — split multi-paragraph blocks on stream entry
// ============================================================================

/**
 * Normalize a block: if it's a paragraph/heading with { type: 'break' }
 * separators (from ProseMirror multi-paragraph serialization), split into
 * individual blocks.
 *
 * This ensures every block in the stream is exactly one paragraph/heading,
 * enabling clean block-level overflow.
 */
function normalizeBlock(block: Block): Block[] {
  if (block.type !== 'paragraph' && block.type !== 'heading') return [block];
  if (!block.content || block.content.length === 0) return [block];

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

  return segments.map((content, i) => {
    if (i === 0) {
      // First segment keeps original type, ID, alignment
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
