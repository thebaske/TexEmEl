// ============================================================================
// Layout Types — Shared interfaces for the BSP layout system
//
// This file has ZERO DOM manipulation. Layout components import from here.
// ============================================================================

import type { Block, TextMark } from '../model/DocumentTree';

// --- Text Kernel Interface ---

/** Interface for the cell-level ProseMirror editor.
 *  One kernel per cell — manages the full PM document. */
export interface ITextKernel {
  // --- Content ---

  /** Read all blocks from the PM document (one Block per top-level PM node) */
  getBlocks(): Block[];
  /** Replace the entire PM document with new blocks */
  setBlocks(blocks: Block[]): void;
  /** Legacy single-block read (backward compat) */
  getContent(): Block;
  /** Legacy single-block write (backward compat) */
  setContent(block: Block): void;

  // --- Overflow ---

  /** Get the scrollHeight of the PM document */
  getDocHeight(): number;
  /** Split the PM doc at maxHeight. Keeps "before" in editor, returns "after" as Block[]. */
  splitAt(maxHeight: number): Block[];
  /** Split the PM doc at the current cursor position. Returns content after cursor. */
  splitAtCursor(): Block[];

  // --- Formatting ---

  toggleMark(markType: string, attrs?: Record<string, unknown>): void;
  getActiveMarks(): TextMark[];
  setTextAlign(align: string): void;
  getTextAlign(): string;
  setFontFamily(family: string): void;
  setFontSize(size: string): void;
  insertLink(href: string, title?: string): void;
  removeLink(): void;

  // --- Block Type ---

  /** Get the type of the block at cursor position */
  getCurrentBlockType(): { type: string; level?: number } | null;
  /** Change block type at cursor (paragraph ↔ heading) */
  setBlockType(type: string): void;

  // --- Focus & Cursor ---

  focus(): void;
  blur(): void;
  focusStart(): void;
  focusEnd(): void;
  focusLineAtX(line: 'first' | 'last', targetX: number | null): void;
  selectAll(): void;
  isCursorAtStart(): boolean;
  isCursorAtEnd(): boolean;

  // --- Goal Column ---

  /** Stored cursor X from last boundary crossing (for goal-column preservation) */
  lastCursorX: number | null;

  // --- Navigation ---

  setNavigationHandler(handler: NavigationHandler | null): void;

  // --- Lifecycle ---

  onUpdate(callback: () => void): void;
  onSelectionUpdate?(callback: () => void): void;
  undo(): boolean;
  redo(): boolean;
  destroy(): void;
  getView(): unknown;
}

// --- Navigation Handler ---

/** Callback interface for cross-cell keyboard navigation.
 *  TextKernel calls these when cursor hits a cell boundary. */
export interface NavigationHandler {
  /** Cursor reached a cell boundary — request focus transfer */
  onBoundary(direction: 'up' | 'down' | 'left' | 'right'): void;
}
