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

/** Interface that TextKernel must implement — used by BlockNode without importing ProseMirror */
export interface ITextKernel {
  /** Get the current inline content from ProseMirror */
  getContent(): Block;
  /** Set content from a Block (external update) */
  setContent(block: Block): void;
  /** Toggle a mark on the current selection */
  toggleMark(markType: string, attrs?: Record<string, unknown>): void;
  /** Get active marks at current cursor position */
  getActiveMarks(): TextMark[];
  /** Focus the ProseMirror editor */
  focus(): void;
  /** Blur the ProseMirror editor */
  blur(): void;
  /** Attempt undo — returns true if handled */
  undo(): boolean;
  /** Attempt redo — returns true if handled */
  redo(): boolean;
  /** Register update callback (doc changes) */
  onUpdate(callback: () => void): void;
  /** Register selection change callback (cursor moves without doc change) */
  onSelectionUpdate?(callback: () => void): void;
  /** Register callback for when Enter is pressed at end of document (create new block) */
  onEnterAtEnd?(callback: () => void): void;
  /** Cleanup */
  destroy(): void;

  // --- Phase 6 additions ---

  /** Set text alignment on the current block node */
  setTextAlign(align: string): void;
  /** Get current text alignment */
  getTextAlign(): string;
  /** Set font family on selection */
  setFontFamily(family: string): void;
  /** Set font size on selection */
  setFontSize(size: string): void;
  /** Insert or edit a link on the selection */
  insertLink(href: string, title?: string): void;
  /** Remove link from selection */
  removeLink(): void;
  /** Get the ProseMirror view for advanced operations */
  getView(): unknown;

  // --- Navigation (cross-block keyboard movement) ---

  /** Check if cursor is at the very start of the document (position 0) */
  isCursorAtStart(): boolean;
  /** Check if cursor is at the very end of the document */
  isCursorAtEnd(): boolean;
  /** Place cursor at the start and focus */
  focusStart(): void;
  /** Place cursor at the end and focus */
  focusEnd(): void;
  /** Focus the first or last line, placing cursor at the closest position to targetX */
  focusLineAtX(line: 'first' | 'last', targetX: number | null): void;
  /** Stored cursor X from last boundary crossing (for goal-column preservation) */
  lastCursorX: number | null;
  /** Select all content in this editor */
  selectAll(): void;
  /** Set the navigation handler for cross-block movement */
  setNavigationHandler(handler: NavigationHandler | null): void;
}

// --- Navigation Handler ---

/** Callback interface for cross-block keyboard navigation.
 *  TextKernel calls these when cursor hits a document boundary. */
export interface NavigationHandler {
  /** Cursor reached a boundary — request focus transfer */
  onBoundary(direction: 'up' | 'down' | 'left' | 'right'): void;
  /** Enter pressed at end of last block — create new paragraph */
  onEnterAtEnd(): void;
  /** Ctrl+A pressed — select all in cell */
  onSelectAll(): void;
}
