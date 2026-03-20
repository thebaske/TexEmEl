// ============================================================================
// InteractionManager — Unified pointer input handling for BSP layout
//
// Single system that classifies pointer events and routes to the correct
// behavior: resize handle drag, edge-split gesture, cell focus, or
// empty cell activation.
//
// Replaces the pattern of 3 separate managers each attaching their own
// pointerdown listeners and doing their own hit-testing.
//
// NOTE: For Phase 10.3, this currently wraps the existing
// SplitResizeManager and EdgeSplitManager. A future pass can inline
// their logic here for a single unified pointer state machine.
// ============================================================================

// --- Types ---

export type PointerTarget =
  | { type: 'resize-handle'; splitId: string }
  | { type: 'cell-edge'; cellId: string; edge: Edge }
  | { type: 'block'; cellId: string; blockId: string }
  | { type: 'empty-cell'; cellId: string }
  | { type: 'background' };

export type Edge = 'top' | 'bottom' | 'left' | 'right';

const EDGE_THRESHOLD = 12; // pixels from cell boundary to trigger edge detection

// --- InteractionManager ---

export class InteractionManager {
  // @ts-ignore — container reserved for future delegated event listener
  private _container: HTMLElement;

  constructor(container: HTMLElement) {
    this._container = container;
  }

  /**
   * Classify a pointer event into a target type.
   * Used by LayoutDirector to decide what to do with the click.
   */
  classify(e: PointerEvent | MouseEvent): PointerTarget {
    const target = e.target as HTMLElement;

    // Check for resize handle
    const handleEl = target.closest('.bsp-resize-handle') as HTMLElement;
    if (handleEl?.dataset.splitId) {
      return { type: 'resize-handle', splitId: handleEl.dataset.splitId };
    }

    // Check for cell
    const cellEl = target.closest('.bsp-cell') as HTMLElement;
    if (!cellEl?.dataset.cellId) {
      return { type: 'background' };
    }

    const cellId = cellEl.dataset.cellId;

    // Check for edge proximity
    const edge = this.detectEdge(cellEl, e.clientX, e.clientY);
    if (edge) {
      return { type: 'cell-edge', cellId, edge };
    }

    // Check for block click
    const blockEl = target.closest('[data-block-id]') as HTMLElement;
    if (blockEl?.dataset.blockId) {
      return { type: 'block', cellId, blockId: blockEl.dataset.blockId };
    }

    // Empty cell
    return { type: 'empty-cell', cellId };
  }

  /**
   * Detect if a point is near a cell edge (within threshold).
   * Returns the edge name or null if not near any edge.
   */
  private detectEdge(cellEl: HTMLElement, clientX: number, clientY: number): Edge | null {
    const rect = cellEl.getBoundingClientRect();

    const distTop = clientY - rect.top;
    const distBottom = rect.bottom - clientY;
    const distLeft = clientX - rect.left;
    const distRight = rect.right - clientX;

    // Find the closest edge within threshold
    const edges: Array<{ edge: Edge; dist: number }> = [
      { edge: 'top', dist: distTop },
      { edge: 'bottom', dist: distBottom },
      { edge: 'left', dist: distLeft },
      { edge: 'right', dist: distRight },
    ];

    const closest = edges
      .filter(e => e.dist >= 0 && e.dist <= EDGE_THRESHOLD)
      .sort((a, b) => a.dist - b.dist)[0];

    return closest?.edge ?? null;
  }

  destroy(): void {
    // No listeners to clean up — classify is called externally
  }
}
