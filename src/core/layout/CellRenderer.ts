// ============================================================================
// CellRenderer — Renders a LayoutTree (BSP) to nested flex divs
//
// Split nodes become flex containers with a resize handle between children.
// Leaf nodes become content cells where blocks are rendered.
// ============================================================================

import type { LayoutNode, SplitNode, LeafNode } from './LayoutTree';
import type { Block } from '../model/DocumentTree';
import type { BlockNode } from '../engine/BlockNode';
import type { MountKernelFn } from '../engine/BlockRenderer';
import { BlockRenderer } from '../engine/BlockRenderer';
import { BlockRegistry } from '../engine/BlockRegistry';

export interface CellRendererCallbacks {
  /** Called when a split resize handle is dragged */
  onSplitResize?: (splitId: string, newRatio: number) => void;
  /** Called when a cell is clicked (for selection/focus) */
  onCellClick?: (cellId: string, event: MouseEvent) => void;
  /** Called when a cell is double-clicked (enter edit mode) */
  onCellDblClick?: (cellId: string, event: MouseEvent) => void;
  /** Called when content inside a cell changes */
  onCellContentChange?: (cellId: string, blocks: Block[]) => void;
  /** Called when a cell wants to split (e.g., via context menu or edge drag) */
  onCellSplit?: (cellId: string, direction: 'horizontal' | 'vertical') => void;
  /** Called when a cell wants to merge with sibling */
  onCellMerge?: (cellId: string) => void;
}

/** Maps cell IDs to their DOM elements and block content */
export interface CellHandle {
  cellId: string;
  element: HTMLElement;
  contentElement: HTMLElement;
  blockNodes: BlockNode[];
}

export class CellRenderer {
  private registry: BlockRegistry;
  private blockRenderer: BlockRenderer;
  private callbacks: CellRendererCallbacks;

  /** Maps cell (leaf) IDs to their handles */
  private cellMap = new Map<string, CellHandle>();
  /** Maps split IDs to their resize handle elements */
  private splitHandleMap = new Map<string, HTMLElement>();
  /** The root container element */
  // @ts-ignore — used for future operations
  private _rootElement: HTMLElement | null = null;

  constructor(callbacks: CellRendererCallbacks = {}) {
    this.registry = new BlockRegistry();
    this.blockRenderer = new BlockRenderer(this.registry);
    this.callbacks = callbacks;
  }

  setMountKernel(fn: MountKernelFn): void {
    this.blockRenderer.setMountKernel(fn);
  }

  getRegistry(): BlockRegistry {
    return this.registry;
  }

  getCellHandle(cellId: string): CellHandle | undefined {
    return this.cellMap.get(cellId);
  }

  getAllCellHandles(): CellHandle[] {
    return Array.from(this.cellMap.values());
  }

  // --- Render ---

  /** Full render of the layout tree into the container */
  render(container: HTMLElement, layout: LayoutNode): void {
    container.innerHTML = '';
    this.registry.clear();
    this.cellMap.clear();
    this.splitHandleMap.clear();

    const el = this.renderNode(layout);
    el.classList.add('bsp-root');
    container.appendChild(el);
    this._rootElement = el;
  }

  /** Re-render a single cell's content (after block changes) */
  rerenderCell(cellId: string, blocks: Block[]): void {
    const handle = this.cellMap.get(cellId);
    if (!handle) return;

    // Destroy old block nodes for this cell
    for (const bn of handle.blockNodes) {
      this.registry.unregister(bn.id);
      bn.destroy();
    }
    handle.blockNodes = [];
    handle.contentElement.innerHTML = '';

    // Render new blocks
    for (const block of blocks) {
      const node = this.blockRenderer.createSingleBlock(block, false);
      this.registry.register(node);
      handle.blockNodes.push(node);
      handle.contentElement.appendChild(node.element);
    }
  }

  /** Update just the split ratio (resize a split border) */
  updateSplitRatio(splitId: string, ratio: number, _layout: LayoutNode): void {
    // Find the split's DOM element and update flex sizes
    const splitEl = document.querySelector(`[data-split-id="${splitId}"]`) as HTMLElement;
    if (!splitEl) return;

    const children = splitEl.children;
    // children[0] = first, children[1] = handle, children[2] = second
    if (children.length >= 3) {
      const pct1 = (ratio * 100).toFixed(2);
      const pct2 = ((1 - ratio) * 100).toFixed(2);
      const direction = splitEl.dataset.splitDirection;

      const first = children[0] as HTMLElement;
      const second = children[2] as HTMLElement;

      if (direction === 'vertical') {
        first.style.width = `calc(${pct1}% - 2px)`;
        second.style.width = `calc(${pct2}% - 2px)`;
      } else {
        first.style.height = `calc(${pct1}% - 2px)`;
        second.style.height = `calc(${pct2}% - 2px)`;
      }
    }
  }

  destroy(): void {
    for (const handle of this.cellMap.values()) {
      for (const bn of handle.blockNodes) {
        bn.destroy();
      }
    }
    this.registry.clear();
    this.cellMap.clear();
    this.splitHandleMap.clear();
    this._rootElement = null;
  }

  // --- Private Rendering ---

  private renderNode(node: LayoutNode): HTMLElement {
    if (node.type === 'leaf') {
      return this.renderLeaf(node);
    }
    return this.renderSplit(node);
  }

  private renderLeaf(leaf: LeafNode): HTMLElement {
    const cell = document.createElement('div');
    cell.classList.add('bsp-cell');
    cell.dataset.cellId = leaf.id;

    // Content area where blocks go
    const content = document.createElement('div');
    content.classList.add('bsp-cell-content');
    cell.appendChild(content);

    // Render blocks into the content area
    const blockNodes: BlockNode[] = [];
    for (const block of leaf.blocks) {
      const node = this.blockRenderer.createSingleBlock(block, false);
      this.registry.register(node);
      blockNodes.push(node);
      content.appendChild(node.element);
    }

    // If empty, show placeholder
    if (leaf.blocks.length === 0) {
      content.classList.add('bsp-cell-empty');
    }

    // Register cell handle
    const handle: CellHandle = {
      cellId: leaf.id,
      element: cell,
      contentElement: content,
      blockNodes,
    };
    this.cellMap.set(leaf.id, handle);

    // Cell events
    cell.addEventListener('click', (e) => {
      this.callbacks.onCellClick?.(leaf.id, e);
    });
    cell.addEventListener('dblclick', (e) => {
      this.callbacks.onCellDblClick?.(leaf.id, e);
    });

    return cell;
  }

  private renderSplit(split: SplitNode): HTMLElement {
    const container = document.createElement('div');
    container.classList.add('bsp-split');
    container.dataset.splitId = split.id;
    container.dataset.splitDirection = split.direction;

    const isVertical = split.direction === 'vertical';
    container.style.display = 'flex';
    container.style.flexDirection = isVertical ? 'row' : 'column';
    container.style.width = '100%';
    container.style.height = '100%';

    // First child
    const first = this.renderNode(split.first);
    first.classList.add('bsp-split-child');
    const pct1 = (split.ratio * 100).toFixed(2);
    const pct2 = ((1 - split.ratio) * 100).toFixed(2);
    if (isVertical) {
      first.style.width = `calc(${pct1}% - 2px)`;
      first.style.height = '100%';
    } else {
      first.style.height = `calc(${pct1}% - 2px)`;
      first.style.width = '100%';
    }
    first.style.flex = 'none';

    // Resize handle (the draggable border between split children)
    const resizeHandle = document.createElement('div');
    resizeHandle.classList.add('bsp-resize-handle');
    resizeHandle.classList.add(isVertical ? 'bsp-resize-handle--vertical' : 'bsp-resize-handle--horizontal');
    resizeHandle.dataset.splitId = split.id;
    this.splitHandleMap.set(split.id, resizeHandle);

    // Second child
    const second = this.renderNode(split.second);
    second.classList.add('bsp-split-child');
    if (isVertical) {
      second.style.width = `calc(${pct2}% - 2px)`;
      second.style.height = '100%';
    } else {
      second.style.height = `calc(${pct2}% - 2px)`;
      second.style.width = '100%';
    }
    second.style.flex = 'none';

    container.appendChild(first);
    container.appendChild(resizeHandle);
    container.appendChild(second);

    return container;
  }
}
