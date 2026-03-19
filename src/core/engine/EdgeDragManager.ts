// ============================================================================
// EdgeDragManager — Padding & margin adjustment by dragging block edges
//
// Detects when the cursor is near a block's edge. Changes cursor and
// enables drag to adjust padding or margin in real-time. Shows colored
// overlays during drag (green = padding, orange = margin).
// ============================================================================

import type { BlockRegistry } from './BlockRegistry';
import type { BoxSpacing, ContainerStyle } from '../model/DocumentTree';

export interface EdgeDragCallbacks {
  onStyleChange: (blockId: string, style: ContainerStyle) => void;
}

type Edge = 'top' | 'right' | 'bottom' | 'left';
type DragMode = 'padding' | 'margin';

interface EdgeHitResult {
  blockId: string;
  edge: Edge;
  mode: DragMode;
}

interface DragState {
  blockId: string;
  edge: Edge;
  mode: DragMode;
  startPos: number; // clientX or clientY depending on edge
  startValue: number; // current padding/margin value in px
  overlay: HTMLElement;
  blockEl: HTMLElement;
}

const EDGE_THRESHOLD = 8; // px from edge to trigger

export class EdgeDragManager {
  private container: HTMLElement;
  private registry: BlockRegistry;
  private callbacks: EdgeDragCallbacks;
  private state: DragState | null = null;
  private currentHit: EdgeHitResult | null = null;
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;

  constructor(container: HTMLElement, registry: BlockRegistry, callbacks: EdgeDragCallbacks) {
    this.container = container;
    this.registry = registry;
    this.callbacks = callbacks;
    this.boundMove = this.onDragMove.bind(this);
    this.boundUp = this.onDragEnd.bind(this);
  }

  /** Called on every mousemove from EventRouter to detect edge proximity */
  handleMouseMove(e: MouseEvent): void {
    if (this.state) return; // don't detect while dragging

    const hit = this.detectEdge(e);

    if (hit) {
      this.currentHit = hit;
      this.setCursorForEdge(hit.edge);
    } else if (this.currentHit) {
      this.currentHit = null;
      this.container.style.cursor = '';
    }
  }

  /** Called on pointerdown — starts edge drag if cursor is on an edge */
  handlePointerDown(e: PointerEvent): boolean {
    if (!this.currentHit) return false;

    e.preventDefault();
    e.stopPropagation();
    this.startDrag(this.currentHit, e);
    return true; // consumed the event
  }

  destroy(): void {
    if (this.state) {
      this.state.overlay.remove();
      document.removeEventListener('pointermove', this.boundMove);
      document.removeEventListener('pointerup', this.boundUp);
      this.state = null;
    }
    this.container.style.cursor = '';
  }

  // --- Edge Detection ---

  private detectEdge(e: MouseEvent): EdgeHitResult | null {
    const target = e.target as HTMLElement;
    if (!target) return null;

    const node = this.registry.findByElement(target);
    if (!node) return null;

    const rect = node.element.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;

    // Check each edge
    const distTop = Math.abs(y - rect.top);
    const distBottom = Math.abs(y - rect.bottom);
    const distLeft = Math.abs(x - rect.left);
    const distRight = Math.abs(x - rect.right);

    const minDist = Math.min(distTop, distBottom, distLeft, distRight);
    if (minDist > EDGE_THRESHOLD) return null;

    let edge: Edge;
    if (minDist === distTop) edge = 'top';
    else if (minDist === distBottom) edge = 'bottom';
    else if (minDist === distLeft) edge = 'left';
    else edge = 'right';

    // Determine mode: inside edge = padding, outside = margin
    const isInside = this.isInsideBlock(x, y, rect);
    const mode: DragMode = isInside ? 'padding' : 'margin';

    return { blockId: node.id, edge, mode };
  }

  private isInsideBlock(x: number, y: number, rect: DOMRect): boolean {
    return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
  }

  // --- Drag Lifecycle ---

  private startDrag(hit: EdgeHitResult, e: PointerEvent): void {
    const node = this.registry.get(hit.blockId);
    if (!node) return;

    const el = node.element;
    const computed = getComputedStyle(el);
    const prop = hit.mode === 'padding'
      ? `padding-${hit.edge}` as any
      : `margin-${hit.edge}` as any;
    const currentValue = parseFloat(computed.getPropertyValue(prop)) || 0;

    const isVertical = hit.edge === 'top' || hit.edge === 'bottom';
    const startPos = isVertical ? e.clientY : e.clientX;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = hit.mode === 'padding' ? 'block-padding-overlay' : 'block-margin-overlay';
    this.positionOverlay(overlay, el, hit.edge, hit.mode, currentValue);
    el.style.position === 'static' && (el.style.position = 'relative');
    el.appendChild(overlay);

    this.state = {
      blockId: hit.blockId,
      edge: hit.edge,
      mode: hit.mode,
      startPos,
      startValue: currentValue,
      overlay,
      blockEl: el,
    };

    document.addEventListener('pointermove', this.boundMove);
    document.addEventListener('pointerup', this.boundUp);
  }

  private onDragMove(e: PointerEvent): void {
    if (!this.state) return;

    const { edge, mode, startPos, startValue, blockEl, overlay } = this.state;
    const isVertical = edge === 'top' || edge === 'bottom';
    const currentPos = isVertical ? e.clientY : e.clientX;

    // Determine delta direction
    let delta = currentPos - startPos;
    if (edge === 'top' || edge === 'left') delta = -delta;

    const newValue = Math.max(0, Math.round(startValue + delta));
    const prop = `${mode}${edge.charAt(0).toUpperCase() + edge.slice(1)}` as
      'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft' |
      'marginTop' | 'marginRight' | 'marginBottom' | 'marginLeft';

    blockEl.style[prop] = `${newValue}px`;
    this.positionOverlay(overlay, blockEl, edge, mode, newValue);
  }

  private onDragEnd(_e: PointerEvent): void {
    if (!this.state) return;

    const { blockId, blockEl, overlay } = this.state;

    // Read final computed values
    const computed = getComputedStyle(blockEl);
    const style: ContainerStyle = {};

    const readSpacing = (prefix: 'padding' | 'margin'): BoxSpacing | undefined => {
      const t = parseFloat(computed.getPropertyValue(`${prefix}-top`)) || 0;
      const r = parseFloat(computed.getPropertyValue(`${prefix}-right`)) || 0;
      const b = parseFloat(computed.getPropertyValue(`${prefix}-bottom`)) || 0;
      const l = parseFloat(computed.getPropertyValue(`${prefix}-left`)) || 0;
      if (t === 0 && r === 0 && b === 0 && l === 0) return undefined;
      return {
        top: `${t}px`,
        right: `${r}px`,
        bottom: `${b}px`,
        left: `${l}px`,
      };
    };

    style.padding = readSpacing('padding');
    style.margin = readSpacing('margin');

    overlay.remove();
    document.removeEventListener('pointermove', this.boundMove);
    document.removeEventListener('pointerup', this.boundUp);
    this.state = null;
    this.container.style.cursor = '';

    this.callbacks.onStyleChange(blockId, style);
  }

  // --- Helpers ---

  private setCursorForEdge(edge: Edge): void {
    const cursors: Record<Edge, string> = {
      top: 'n-resize',
      bottom: 's-resize',
      left: 'w-resize',
      right: 'e-resize',
    };
    this.container.style.cursor = cursors[edge];
  }

  private positionOverlay(
    overlay: HTMLElement,
    _blockEl: HTMLElement,
    edge: Edge,
    mode: DragMode,
    value: number,
  ): void {
    overlay.style.position = 'absolute';

    if (mode === 'padding') {
      // Inside the block
      switch (edge) {
        case 'top':
          overlay.style.top = '0';
          overlay.style.left = '0';
          overlay.style.right = '0';
          overlay.style.height = `${value}px`;
          overlay.style.bottom = '';
          break;
        case 'bottom':
          overlay.style.bottom = '0';
          overlay.style.left = '0';
          overlay.style.right = '0';
          overlay.style.height = `${value}px`;
          overlay.style.top = '';
          break;
        case 'left':
          overlay.style.top = '0';
          overlay.style.bottom = '0';
          overlay.style.left = '0';
          overlay.style.width = `${value}px`;
          overlay.style.right = '';
          break;
        case 'right':
          overlay.style.top = '0';
          overlay.style.bottom = '0';
          overlay.style.right = '0';
          overlay.style.width = `${value}px`;
          overlay.style.left = '';
          break;
      }
    } else {
      // Outside the block (margin overlay)
      switch (edge) {
        case 'top':
          overlay.style.bottom = '100%';
          overlay.style.left = '0';
          overlay.style.right = '0';
          overlay.style.height = `${value}px`;
          break;
        case 'bottom':
          overlay.style.top = '100%';
          overlay.style.left = '0';
          overlay.style.right = '0';
          overlay.style.height = `${value}px`;
          break;
        case 'left':
          overlay.style.right = '100%';
          overlay.style.top = '0';
          overlay.style.bottom = '0';
          overlay.style.width = `${value}px`;
          break;
        case 'right':
          overlay.style.left = '100%';
          overlay.style.top = '0';
          overlay.style.bottom = '0';
          overlay.style.width = `${value}px`;
          break;
      }
    }
  }
}
