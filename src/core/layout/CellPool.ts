// ============================================================================
// CellPool — Manages CellInstance lifecycle
//
// Cells are acquired (created or reused) and released (destroyed).
// A cell is NEVER released during split or resize — only on explicit merge
// or page deletion.
// ============================================================================

import type { Block } from '../model/DocumentTree';
import { CellInstance, type KernelFactory } from './CellInstance';

// --- Types ---

export interface CellPoolConfig {
  kernelFactory: KernelFactory;
  onContentChange?: (cellId: string) => void;
  onSelectionChange?: (cellId: string) => void;
  navigationController?: import('./NavigationController').NavigationController;
}

// --- CellPool ---

export class CellPool {
  private cells = new Map<string, CellInstance>();
  private config: CellPoolConfig;

  constructor(config: CellPoolConfig) {
    this.config = config;
  }

  // =====================
  //  CELL LIFECYCLE
  // =====================

  /**
   * Get an existing cell or create a new one.
   * If the cell already exists, returns it as-is (content preserved).
   * If new, creates with optional initial blocks.
   */
  acquire(cellId: string, initialBlocks: Block[] = []): CellInstance {
    const existing = this.cells.get(cellId);
    if (existing) return existing;

    const cell = new CellInstance(cellId, {
      kernelFactory: this.config.kernelFactory,
      onContentChange: this.config.onContentChange,
      onSelectionChange: this.config.onSelectionChange,
      navigationController: this.config.navigationController,
    }, initialBlocks);

    this.cells.set(cellId, cell);
    return cell;
  }

  /**
   * Destroy a cell permanently. Only call on merge or page deletion.
   * Returns the cell's live content before destruction.
   */
  release(cellId: string): Block[] {
    const cell = this.cells.get(cellId);
    if (!cell) return [];

    const content = cell.getContent();
    cell.destroy();
    this.cells.delete(cellId);
    return content;
  }

  /** Get a cell without creating it */
  get(cellId: string): CellInstance | undefined {
    return this.cells.get(cellId);
  }

  /** Check if a cell exists in the pool */
  has(cellId: string): boolean {
    return this.cells.has(cellId);
  }

  // =====================
  //  BULK OPERATIONS
  // =====================

  /** Snapshot all cells' live content (for serialization/export) */
  serializeAll(): Map<string, Block[]> {
    const result = new Map<string, Block[]>();
    for (const [id, cell] of this.cells) {
      result.set(id, cell.getContent());
    }
    return result;
  }

  /** Get all cell IDs currently in the pool */
  getAllCellIds(): string[] {
    return Array.from(this.cells.keys());
  }

  /** Number of active cells */
  size(): number {
    return this.cells.size;
  }

  /**
   * Release all cells that are NOT in the given set of IDs.
   * Used after tree reconciliation to clean up orphaned cells.
   */
  releaseExcept(keepIds: Set<string>): void {
    const toRelease: string[] = [];
    for (const id of this.cells.keys()) {
      if (!keepIds.has(id)) {
        toRelease.push(id);
      }
    }
    for (const id of toRelease) {
      this.release(id);
    }
  }

  // =====================
  //  CLEANUP
  // =====================

  /** Destroy all cells */
  destroy(): void {
    for (const cell of this.cells.values()) {
      cell.destroy();
    }
    this.cells.clear();
  }
}
