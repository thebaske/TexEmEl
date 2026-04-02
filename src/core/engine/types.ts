// ============================================================================
// Engine Types — Shared interfaces, enums, and type definitions
//
// This file has ZERO DOM manipulation. All other engine files import from here.
// ============================================================================

import type { Block, DocumentTree, TextMark } from '../model/DocumentTree';

// --- Block Runtime State ---

export enum BlockStatus {
  Idle = 'idle',
  Hovered = 'hovered',
  Selected = 'selected',
  Editing = 'editing',
}

// --- Engine Events ---

export enum EngineEvent {
  BlockClick = 'block:click',
  BlockDoubleClick = 'block:dblclick',
  BlockHoverEnter = 'block:hover:enter',
  BlockHoverLeave = 'block:hover:leave',
  BlockDragStart = 'block:drag:start',
  BlockDragOver = 'block:drag:over',
  BlockDrop = 'block:drop',
  TextChange = 'text:change',
  TextSelectionChange = 'text:selection:change',
  KeyDown = 'key:down',
  Paste = 'paste',
  Drop = 'drop',
  ContextMenu = 'context:menu',
}

// --- Engine Event Payloads ---

export interface BlockClickPayload {
  blockId: string | null;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface BlockHoverPayload {
  blockId: string | null;
}

export interface TextChangePayload {
  blockId: string;
}

export interface KeyDownPayload {
  blockId: string | null;
  event: KeyboardEvent;
}

export interface PastePayload {
  blockId: string | null;
  event: ClipboardEvent;
}

export type EngineEventPayload =
  | BlockClickPayload
  | BlockHoverPayload
  | TextChangePayload
  | KeyDownPayload
  | PastePayload;

// --- Commands (for undo/redo) ---

export interface EngineCommand {
  readonly type: string;
  readonly description: string;
  execute(): void;
  undo(): void;
}

// --- Callbacks ---

export type OnChangeCallback = (tree: DocumentTree) => void;
export type OnSelectionCallback = (blockIds: string[]) => void;
export type OnActiveMarksCallback = (marks: TextMark[]) => void;

// --- Engine Configuration ---

export interface EngineConfig {
  /** Debounce ms for syncing model changes back to React (default: 150) */
  debounceMs: number;
  /** Pixel grid for drag snapping (default: 8) */
  snapGrid: number;
  /** Max undo/redo stack depth (default: 100) */
  maxHistory: number;
  /** Show alignment guides during drag (default: true) */
  showAlignmentGuides: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  debounceMs: 150,
  snapGrid: 8,
  maxHistory: 100,
  showAlignmentGuides: true,
};

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
