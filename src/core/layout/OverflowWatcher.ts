// ============================================================================
// OverflowWatcher — ResizeObserver-based overflow/underflow detection
//
// Watches cell content elements for size changes. When a cell's content
// exceeds its container, emits an overflow event. When a cell has room
// and has a flow source, emits an underflow event.
//
// Replaces timer-based overflow checking (500ms debounce for typing,
// 50ms for structural changes) with native browser observation.
// ============================================================================

import type { CellInstance } from './CellInstance';

// --- Types ---

export type OverflowCallback = (cellId: string) => void;

export interface OverflowWatcherConfig {
  /** Called when a cell's content exceeds its container */
  onOverflow: OverflowCallback;
  /** Called when a cell has room and could accept content from its flow source */
  onUnderflow: OverflowCallback;
  /** Minimum overflow/underflow threshold in pixels (avoids sub-pixel thrashing) */
  threshold?: number;
}

// --- OverflowWatcher ---

export class OverflowWatcher {
  private observer: ResizeObserver;
  private config: OverflowWatcherConfig;
  private threshold: number;

  /** Maps observed elements back to cell IDs */
  private elementToCellId = new Map<Element, string>();
  /** Tracks current overflow state to avoid duplicate events */
  private overflowState = new Map<string, boolean>();
  /** Whether we're currently resolving overflow (prevents re-entrant checks) */
  private resolving = false;
  /** Queued cells to check after current resolution completes */
  private pendingChecks = new Set<string>();
  /** Maps cell IDs to their CellInstances for measurement */
  private cells = new Map<string, CellInstance>();

  constructor(config: OverflowWatcherConfig) {
    this.config = config;
    this.threshold = config.threshold ?? 2; // 2px threshold to avoid sub-pixel noise

    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cellId = this.elementToCellId.get(entry.target);
        if (cellId) {
          if (this.resolving) {
            this.pendingChecks.add(cellId);
          } else {
            this.checkCell(cellId);
          }
        }
      }
    });
  }

  // =====================
  //  WATCH / UNWATCH
  // =====================

  /** Start watching a cell's content element for size changes */
  watch(cell: CellInstance): void {
    this.elementToCellId.set(cell.contentElement, cell.id);
    this.cells.set(cell.id, cell);
    this.observer.observe(cell.contentElement);
  }

  /** Stop watching a cell */
  unwatch(cell: CellInstance): void {
    this.observer.unobserve(cell.contentElement);
    this.elementToCellId.delete(cell.contentElement);
    this.cells.delete(cell.id);
    this.overflowState.delete(cell.id);
    this.pendingChecks.delete(cell.id);
  }

  // =====================
  //  RESOLUTION GUARD
  // =====================

  /**
   * Mark that we're currently resolving overflow.
   * Any ResizeObserver events during resolution get queued instead of processed.
   */
  beginResolving(): void {
    this.resolving = true;
  }

  /**
   * Mark that resolution is complete. Process any queued checks.
   */
  endResolving(): void {
    this.resolving = false;

    // Process any checks that were queued during resolution
    if (this.pendingChecks.size > 0) {
      const pending = [...this.pendingChecks];
      this.pendingChecks.clear();
      for (const cellId of pending) {
        this.checkCell(cellId);
      }
    }
  }

  // =====================
  //  MANUAL CHECK
  // =====================

  /** Force a check on a specific cell (e.g., after structural changes) */
  forceCheck(cellId: string): void {
    this.checkCell(cellId);
  }

  /** Force check all watched cells */
  forceCheckAll(): void {
    for (const cellId of this.cells.keys()) {
      this.checkCell(cellId);
    }
  }

  // =====================
  //  CLEANUP
  // =====================

  destroy(): void {
    this.observer.disconnect();
    this.elementToCellId.clear();
    this.overflowState.clear();
    this.cells.clear();
    this.pendingChecks.clear();
  }

  // =====================
  //  INTERNAL
  // =====================

  private checkCell(cellId: string): void {
    const cell = this.cells.get(cellId);
    if (!cell) return;

    const el = cell.contentElement;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const diff = scrollHeight - clientHeight;

    const wasOverflowing = this.overflowState.get(cellId) ?? false;
    const isOverflowing = diff > this.threshold;

    if (isOverflowing && !wasOverflowing) {
      // Transitioned to overflow
      this.overflowState.set(cellId, true);
      this.config.onOverflow(cellId);
    } else if (!isOverflowing && wasOverflowing) {
      // Transitioned to underflow (had overflow, now has room)
      this.overflowState.set(cellId, false);
      this.config.onUnderflow(cellId);
    } else if (!isOverflowing && !wasOverflowing) {
      // Never overflowed, but check if we have room to pull content back
      // Only emit underflow if there's meaningful spare room
      const spareRoom = clientHeight - scrollHeight;
      if (spareRoom > this.threshold) {
        this.config.onUnderflow(cellId);
      }
    }
  }
}
