// ============================================================================
// ResizeManager — Corner-handle resizing for images and containers
//
// Shows corner handles on selected image/container blocks. Handles pointer
// drag to resize with aspect ratio preservation (shift or default for images).
// ============================================================================

import type { BlockRegistry } from './BlockRegistry';
import type { BlockNode } from './BlockNode';
import type { ContainerStyle } from '../model/DocumentTree';

export interface ResizeCallbacks {
  onResize: (blockId: string, width: number, height: number) => void;
}

interface ResizeState {
  blockId: string;
  handle: 'nw' | 'ne' | 'sw' | 'se';
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
  aspectRatio: number;
  blockEl: HTMLElement;
}

const HANDLE_POSITIONS = ['nw', 'ne', 'sw', 'se'] as const;

export class ResizeManager {
  private registry: BlockRegistry;
  private callbacks: ResizeCallbacks;
  private state: ResizeState | null = null;
  private activeHandles: HTMLElement[] = [];
  private boundMove: (e: PointerEvent) => void;
  private boundUp: (e: PointerEvent) => void;

  constructor(registry: BlockRegistry, callbacks: ResizeCallbacks) {
    this.registry = registry;
    this.callbacks = callbacks;
    this.boundMove = this.onPointerMove.bind(this);
    this.boundUp = this.onPointerUp.bind(this);
  }

  /** Show resize handles on a block (called when selection changes) */
  showHandles(blockId: string): void {
    this.hideHandles();

    const node = this.registry.get(blockId);
    if (!node) return;
    if (!this.isResizable(node)) return;

    const el = node.element;

    // Ensure block is positioned for absolute handle placement
    const computed = getComputedStyle(el);
    if (computed.position === 'static') {
      el.style.position = 'relative';
    }

    for (const pos of HANDLE_POSITIONS) {
      const handle = document.createElement('div');
      handle.className = `block-resize-handle block-resize-handle--${pos}`;
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startResize(blockId, pos, e);
      });
      el.appendChild(handle);
      this.activeHandles.push(handle);
    }
  }

  /** Remove all resize handles */
  hideHandles(): void {
    for (const handle of this.activeHandles) {
      handle.remove();
    }
    this.activeHandles = [];
  }

  destroy(): void {
    this.hideHandles();
    if (this.state) {
      document.removeEventListener('pointermove', this.boundMove);
      document.removeEventListener('pointerup', this.boundUp);
      this.state = null;
    }
  }

  // --- Resize Lifecycle ---

  private startResize(blockId: string, handle: ResizeState['handle'], e: PointerEvent): void {
    const node = this.registry.get(blockId);
    if (!node) return;

    const el = node.element;
    const rect = el.getBoundingClientRect();

    this.state = {
      blockId,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      aspectRatio: rect.width / rect.height,
      blockEl: el,
    };

    document.addEventListener('pointermove', this.boundMove);
    document.addEventListener('pointerup', this.boundUp);
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.state) return;

    const { handle, startX, startY, startWidth, startHeight, aspectRatio, blockEl } = this.state;

    let dx = e.clientX - startX;
    let dy = e.clientY - startY;

    // Invert deltas for north/west handles
    if (handle.includes('n')) dy = -dy;
    if (handle.includes('w')) dx = -dx;

    // Calculate new dimensions preserving aspect ratio for images
    const node = this.registry.get(this.state.blockId);
    const isImage = node?.type === 'image';

    let newWidth: number;
    let newHeight: number;

    if (isImage) {
      // Preserve aspect ratio — use the larger delta
      const scaleFactor = Math.abs(dx) > Math.abs(dy)
        ? (startWidth + dx) / startWidth
        : (startHeight + dy) / startHeight;
      newWidth = Math.max(50, startWidth * scaleFactor);
      newHeight = Math.max(50, newWidth / aspectRatio);
    } else {
      newWidth = Math.max(50, startWidth + dx);
      newHeight = Math.max(30, startHeight + dy);
    }

    // Live preview
    blockEl.style.width = `${newWidth}px`;
    blockEl.style.height = isImage ? `${newHeight}px` : `${newHeight}px`;

    // Also resize the actual img element if this is an image block
    if (isImage) {
      const img = blockEl.querySelector('img');
      if (img) {
        img.style.width = `${newWidth}px`;
        img.style.height = `${newHeight}px`;
      }
    }
  }

  private onPointerUp(_e: PointerEvent): void {
    if (!this.state) return;

    const { blockId, blockEl } = this.state;
    const finalWidth = blockEl.offsetWidth;
    const finalHeight = blockEl.offsetHeight;

    document.removeEventListener('pointermove', this.boundMove);
    document.removeEventListener('pointerup', this.boundUp);
    this.state = null;

    this.callbacks.onResize(blockId, finalWidth, finalHeight);
  }

  // --- Helpers ---

  private isResizable(node: BlockNode): boolean {
    return node.type === 'image' || node.type === 'container';
  }

  /** Update containerStyle dimensions on a block's data */
  static applyResizeToStyle(style: ContainerStyle | undefined, width: number, height: number): ContainerStyle {
    return {
      ...(style ?? {}),
      width: `${width}px`,
      height: `${height}px`,
    };
  }
}
