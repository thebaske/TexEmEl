// ============================================================================
// CellInstance — Persistent cell that owns ONE ProseMirror editor
//
// A CellInstance is created ONCE and lives until the cell is explicitly removed
// (merge or page deletion). Split/resize operations reparent the cell's DOM
// element without destroying it — ProseMirror survives reparenting.
//
// Each cell has a SINGLE TextKernel (ProseMirror editor) that manages all
// paragraphs, headings, etc. within the cell. PM handles navigation, Enter,
// paste, and formatting natively. No BlockNode layer.
// ============================================================================

import type { Block } from '../model/DocumentTree';
import type { ITextKernel } from './types';

// --- Types ---

export type KernelFactory = (el: HTMLElement, blocks: Block[]) => ITextKernel;

export interface CellInstanceConfig {
  kernelFactory: KernelFactory;
  onContentChange?: (cellId: string) => void;
  onSelectionChange?: (cellId: string) => void;
  navigationController?: import('./NavigationController').NavigationController;
}

// --- CellInstance ---

export class CellInstance {
  readonly id: string;
  readonly element: HTMLElement;
  readonly contentElement: HTMLElement;

  private kernel: ITextKernel | null = null;
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

    // Create the single ProseMirror editor for this cell
    this.kernel = config.kernelFactory(this.contentElement, initialBlocks);
    this.wireKernelCallbacks();

    this.updateEmptyState();
  }

  // =====================
  //  KERNEL ACCESS
  // =====================

  /** Get the cell's TextKernel (ProseMirror editor) */
  getKernel(): ITextKernel | null {
    return this.kernel;
  }

  // =====================
  //  CONTENT READS
  // =====================

  /** Read live content from the kernel — always authoritative */
  getContent(): Block[] {
    if (!this.kernel) return [];
    return this.kernel.getBlocks();
  }

  /** Is this cell empty? (no content or only empty paragraph) */
  isEmpty(): boolean {
    if (!this.kernel) return true;
    const blocks = this.kernel.getBlocks();
    if (blocks.length === 0) return true;
    if (blocks.length === 1 && blocks[0].type === 'paragraph') {
      const p = blocks[0];
      if ('content' in p && (!p.content || p.content.length === 0)) return true;
    }
    return false;
  }

  // =====================
  //  CONTENT MUTATIONS
  // =====================

  /** Replace all content in this cell */
  setContent(blocks: Block[]): void {
    if (!this.kernel) return;
    this.kernel.setBlocks(blocks);
    this.updateEmptyState();
  }

  /** Prepend blocks at the beginning (for overflow — content goes before existing) */
  prependBlocks(blocks: Block[]): void {
    if (!this.kernel || blocks.length === 0) return;
    const current = this.kernel.getBlocks();
    const filtered = current.length === 1 && this.isEmpty() ? [] : current;
    this.kernel.setBlocks([...blocks, ...filtered]);
    this.updateEmptyState();
  }

  /** Append blocks at the end (for merge — absorb sibling's content) */
  appendBlocks(blocks: Block[]): void {
    if (!this.kernel || blocks.length === 0) return;
    const current = this.kernel.getBlocks();
    // Filter out empty paragraphs from current if we're appending real content
    const filtered = current.length === 1 && this.isEmpty() ? [] : current;
    this.kernel.setBlocks([...filtered, ...blocks]);
    this.updateEmptyState();
  }

  /** Remove all content and return it (for merge — this cell is being absorbed) */
  drainAll(): Block[] {
    if (!this.kernel) return [];
    const data = this.kernel.getBlocks();
    this.kernel.setBlocks([]);
    this.updateEmptyState();
    return data;
  }

  // =====================
  //  OVERFLOW SPLIT
  // =====================

  /**
   * Split content at the given pixel height.
   * Keeps the portion that fits in this cell.
   * Returns the overflow portion as Block[].
   */
  splitOverflow(maxHeight: number): Block[] {
    if (!this.kernel) return [];
    return this.kernel.splitAt(maxHeight);
  }

  /** Split content at the cursor position. Returns content after cursor. */
  splitAtCursor(): Block[] {
    if (!this.kernel) return [];
    return this.kernel.splitAtCursor();
  }

  /** Check if the cell's content overflows its visible area */
  hasOverflow(): boolean {
    return this.contentElement.scrollHeight > this.contentElement.clientHeight + 1;
  }

  // =====================
  //  FOCUS
  // =====================

  /** Focus the editor at the end */
  focusEnd(): void {
    this.kernel?.focusEnd();
  }

  /** Focus the editor at the start */
  focusStart(): void {
    this.kernel?.focusStart();
  }

  /** Focus the editor (just focus, no cursor positioning) */
  focus(): void {
    this.kernel?.focus();
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

  /** Destroy this cell — destroy kernel, remove DOM */
  destroy(): void {
    if (this.kernel) {
      this.kernel.destroy();
      this.kernel = null;
    }
    this.element.remove();
  }

  // =====================
  //  INTERNAL
  // =====================

  private wireKernelCallbacks(): void {
    if (!this.kernel) return;

    this.kernel.onUpdate(() => {
      this.updateEmptyState();
      this.config.onContentChange?.(this.id);
    });

    this.kernel.onSelectionUpdate?.(() => {
      this.config.onSelectionChange?.(this.id);
    });

    // Wire navigation handler for cross-cell keyboard movement
    if (this.config.navigationController) {
      const handler = this.config.navigationController.createHandler(this.id);
      this.kernel.setNavigationHandler(handler);
    }
  }

  private updateEmptyState(): void {
    this.contentElement.classList.toggle('bsp-cell-empty', this.isEmpty());
  }
}
