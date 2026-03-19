// ============================================================================
// SelectionManager — Block selection, focus, and multi-select
//
// Manages which blocks are selected/focused/hovered. Syncs CSS classes
// to DOM elements for visual feedback. Handles the state machine:
// Idle → Selected → Editing (and transitions between).
// ============================================================================

import type { BlockRegistry } from './BlockRegistry';
import { BlockStatus } from './types';

export type SelectionChangeCallback = (selectedIds: string[]) => void;

export class SelectionManager {
  private selected = new Set<string>();
  private focused: string | null = null;
  private anchor: string | null = null; // for shift+click range selection
  private callbacks: SelectionChangeCallback[] = [];

  constructor(private registry: BlockRegistry) {}

  // --- Selection ---

  /** Single-select a block (clears others) */
  select(id: string): void {
    if (!this.registry.has(id)) return;
    this.exitEditMode();
    this.selected.clear();
    this.selected.add(id);
    this.anchor = id;
    this.applyVisualState();
    this.emitChange();
  }

  /** Toggle a block in/out of selection (Ctrl+click) */
  toggleSelect(id: string): void {
    if (!this.registry.has(id)) return;
    this.exitEditMode();
    if (this.selected.has(id)) {
      this.selected.delete(id);
    } else {
      this.selected.add(id);
    }
    this.anchor = id;
    this.applyVisualState();
    this.emitChange();
  }

  /** Range-select from anchor to target (Shift+click) */
  rangeSelect(id: string): void {
    if (!this.registry.has(id)) return;
    this.exitEditMode();

    const rootOrder = this.registry.getRootOrder();
    const anchorIdx = this.anchor ? rootOrder.indexOf(this.anchor) : -1;
    const targetIdx = rootOrder.indexOf(id);

    if (anchorIdx === -1 || targetIdx === -1) {
      this.select(id);
      return;
    }

    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);

    this.selected.clear();
    for (let i = start; i <= end; i++) {
      this.selected.add(rootOrder[i]);
    }

    this.applyVisualState();
    this.emitChange();
  }

  /** Select all root blocks */
  selectAll(): void {
    this.exitEditMode();
    const rootOrder = this.registry.getRootOrder();
    this.selected.clear();
    for (const id of rootOrder) {
      this.selected.add(id);
    }
    this.applyVisualState();
    this.emitChange();
  }

  /** Clear all selection */
  clearSelection(): void {
    this.exitEditMode();
    this.selected.clear();
    this.anchor = null;
    this.applyVisualState();
    this.emitChange();
  }

  // --- Focus (text editing mode) ---

  /** Enter editing mode: focus ProseMirror kernel in a text block */
  enterEditMode(id: string, skipFocus = false): void {
    const block = this.registry.get(id);
    if (!block?.isEditable() || !block.kernel) return;

    // Already editing this block — nothing to do
    if (this.focused === id) return;

    this.exitEditMode();
    this.focused = id;
    this.selected.clear();
    this.selected.add(id);

    // skipFocus when the browser click already placed ProseMirror's cursor
    if (!skipFocus) {
      block.kernel.focus();
    }
    this.applyVisualState();
    this.emitChange();
  }

  /** Exit editing mode: blur ProseMirror, keep block selected */
  exitEditMode(): void {
    if (!this.focused) return;
    const block = this.registry.get(this.focused);
    block?.kernel?.blur();
    this.focused = null;
    this.applyVisualState();
  }

  // --- Queries ---

  getSelected(): string[] {
    return [...this.selected];
  }

  getFocused(): string | null {
    return this.focused;
  }

  isSelected(id: string): boolean {
    return this.selected.has(id);
  }

  isFocused(id: string): boolean {
    return this.focused === id;
  }

  hasSelection(): boolean {
    return this.selected.size > 0;
  }

  isEditing(): boolean {
    return this.focused !== null;
  }

  // --- Keyboard Navigation ---

  /** Select the next block in root order */
  selectNext(): void {
    const rootOrder = this.registry.getRootOrder();
    if (rootOrder.length === 0) return;

    const current = this.getLastSelected();
    if (!current) {
      this.select(rootOrder[0]);
      return;
    }

    const idx = rootOrder.indexOf(current);
    if (idx < rootOrder.length - 1) {
      this.select(rootOrder[idx + 1]);
    }
  }

  /** Select the previous block in root order */
  selectPrevious(): void {
    const rootOrder = this.registry.getRootOrder();
    if (rootOrder.length === 0) return;

    const current = this.getFirstSelected();
    if (!current) {
      this.select(rootOrder[rootOrder.length - 1]);
      return;
    }

    const idx = rootOrder.indexOf(current);
    if (idx > 0) {
      this.select(rootOrder[idx - 1]);
    }
  }

  // --- Callbacks ---

  onChange(callback: SelectionChangeCallback): void {
    this.callbacks.push(callback);
  }

  // --- Internal ---

  private getFirstSelected(): string | null {
    const rootOrder = this.registry.getRootOrder();
    for (const id of rootOrder) {
      if (this.selected.has(id)) return id;
    }
    return null;
  }

  private getLastSelected(): string | null {
    const rootOrder = this.registry.getRootOrder();
    for (let i = rootOrder.length - 1; i >= 0; i--) {
      if (this.selected.has(rootOrder[i])) return rootOrder[i];
    }
    return null;
  }

  /** Sync CSS classes on all block elements to reflect current state */
  private applyVisualState(): void {
    for (const [id, node] of this.registry.getAll()) {
      const el = node.element;
      const isSelected = this.selected.has(id);
      const isFocused = this.focused === id;

      el.classList.toggle('block-selected', isSelected && !isFocused);
      el.classList.toggle('block-editing', isFocused);

      // Update BlockNode status
      if (isFocused) {
        node.status = BlockStatus.Editing;
      } else if (isSelected) {
        node.status = BlockStatus.Selected;
      } else {
        // Preserve hover state if it was set by EventRouter
        if (node.status !== BlockStatus.Hovered) {
          node.status = BlockStatus.Idle;
        }
      }
    }
  }

  private emitChange(): void {
    const selected = this.getSelected();
    for (const cb of this.callbacks) {
      cb(selected);
    }
  }
}
