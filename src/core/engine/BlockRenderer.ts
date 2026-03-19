// ============================================================================
// BlockRenderer — DocumentTree → DOM rendering with diffing
//
// Creates, updates, and removes DOM elements to match the DocumentTree.
// Preserves ProseMirror kernels during updates to avoid losing cursor state.
// ============================================================================

import type {
  Block, ContainerStyle, InlineContent, ListItem,
  TableCell, ImageBlock,
} from '../model/DocumentTree';
import { BlockNode } from './BlockNode';
import { BlockRegistry } from './BlockRegistry';
import type { DragManager } from './DragManager';

/**
 * Callback to mount a TextKernel into a content element.
 * Provided by BlockEngine so renderer doesn't depend on ProseMirror.
 */
export type MountKernelFn = (node: BlockNode, contentEl: HTMLElement, block: Block) => void;

export class BlockRenderer {
  private registry: BlockRegistry;
  private mountKernel: MountKernelFn | null = null;
  private dragManager: DragManager | null = null;

  constructor(registry: BlockRegistry) {
    this.registry = registry;
  }

  setMountKernel(fn: MountKernelFn): void {
    this.mountKernel = fn;
  }

  setDragManager(dm: DragManager): void {
    this.dragManager = dm;
  }

  // --- Full Render ---

  /** Initial render: create all blocks from a DocumentTree */
  renderFull(container: HTMLElement, blocks: Block[]): void {
    container.innerHTML = '';
    this.registry.clear();

    for (const block of blocks) {
      const node = this.createBlockNode(block, true);
      this.registry.registerRoot(node);
      container.appendChild(node.element);
    }
  }

  // --- Diff & Patch ---

  /** Diff old and new block arrays, patch the DOM minimally */
  diff(container: HTMLElement, _oldBlocks: Block[], newBlocks: Block[]): void {
    const oldMap = new Map<string, BlockNode>();
    for (const node of this.registry.getRootBlocks()) {
      oldMap.set(node.id, node);
    }

    const newIds: string[] = [];

    // 1. Create or update each new block
    for (const block of newBlocks) {
      const id = block.id!;
      newIds.push(id);
      const existing = oldMap.get(id);

      if (existing) {
        // UPDATE: patch the existing node
        this.updateBlockNode(existing, block);
        oldMap.delete(id);
      } else {
        // CREATE: new block
        const node = this.createBlockNode(block, true);
        this.registry.registerRoot(node);
        container.appendChild(node.element);
      }
    }

    // 2. Remove blocks that no longer exist
    for (const [id, node] of oldMap) {
      this.registry.unregister(id);
      node.destroy();
    }

    // 3. Reorder DOM children to match new order
    this.registry.setRootOrder(newIds);
    this.reorderDom(container, newIds);
  }

  // --- Block Creation ---

  /** Public: create a single fully-wired block node (with kernel, drag handle, children) */
  createSingleBlock(block: Block, isRoot = false): BlockNode {
    return this.createBlockNode(block, isRoot);
  }

  private createBlockNode(block: Block, isRoot = false): BlockNode {
    const el = this.createElement(block);
    const node = new BlockNode(block, el);

    // Attach drag handle for root-level blocks
    if (isRoot && this.dragManager) {
      this.dragManager.attachHandle(el, block.id!);
    }

    // Mount TextKernel for editable blocks
    if (node.isEditable()) {
      const contentEl = el.querySelector('.block-content') as HTMLElement;
      if (contentEl && this.mountKernel) {
        this.mountKernel(node, contentEl, block);
      }
    }

    // Recursive: create children for containers/blockquotes
    if (block.type === 'container') {
      const childContainer = el; // children go directly inside
      for (const childBlock of block.children) {
        const childNode = this.createBlockNode(childBlock);
        node.addChild(childNode);
        this.registry.register(childNode);
        childContainer.appendChild(childNode.element);
      }
    } else if (block.type === 'blockquote') {
      const bqEl = el.querySelector('blockquote') as HTMLElement;
      if (bqEl) {
        for (const childBlock of block.blocks) {
          const childNode = this.createBlockNode(childBlock);
          node.addChild(childNode);
          this.registry.register(childNode);
          bqEl.appendChild(childNode.element);
        }
      }
    }

    return node;
  }

  private createElement(block: Block): HTMLElement {
    const el = document.createElement('div');
    el.classList.add('block', `block-${block.type}`);

    // Apply layout styles from containerStyle
    if (block.containerStyle) {
      this.applyLayoutStyles(el, block.containerStyle);
    }

    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'codeBlock': {
        // Text-editable blocks get a content div where ProseMirror mounts
        const contentEl = document.createElement('div');
        contentEl.classList.add('block-content');
        el.appendChild(contentEl);
        break;
      }

      case 'image': {
        const img = this.createImageElement(block);
        el.appendChild(img);
        break;
      }

      case 'divider': {
        el.appendChild(document.createElement('hr'));
        break;
      }

      case 'list': {
        const listEl = this.createListElement(block.ordered, block.items);
        el.appendChild(listEl);
        break;
      }

      case 'table': {
        const tableEl = this.createTableElement(block.headers, block.rows);
        el.appendChild(tableEl);
        break;
      }

      case 'blockquote': {
        const bq = document.createElement('blockquote');
        el.appendChild(bq);
        // Children appended later in createBlockNode
        break;
      }

      case 'container': {
        const layout = block.layout ?? 'flow';
        el.classList.add(`layout-${layout}`);
        // Children appended later in createBlockNode
        break;
      }
    }

    return el;
  }

  // --- Update ---

  private updateBlockNode(node: BlockNode, block: Block): void {
    // Update layout styles
    if (block.containerStyle) {
      this.applyLayoutStyles(node.element, block.containerStyle);
    }

    // Update block data (may push to TextKernel if version is newer)
    node.updateData(block);
  }

  // --- DOM Helpers ---

  private applyLayoutStyles(el: HTMLElement, style: ContainerStyle): void {
    if (style.padding) {
      if (style.padding.top) el.style.paddingTop = style.padding.top;
      if (style.padding.right) el.style.paddingRight = style.padding.right;
      if (style.padding.bottom) el.style.paddingBottom = style.padding.bottom;
      if (style.padding.left) el.style.paddingLeft = style.padding.left;
    }
    if (style.margin) {
      if (style.margin.top) el.style.marginTop = style.margin.top;
      if (style.margin.right) el.style.marginRight = style.margin.right;
      if (style.margin.bottom) el.style.marginBottom = style.margin.bottom;
      if (style.margin.left) el.style.marginLeft = style.margin.left;
    }
    if (style.width) el.style.width = style.width;
    if (style.height) el.style.height = style.height;
    if (style.position) el.style.position = style.position;
    if (style.top) el.style.top = style.top;
    if (style.left) el.style.left = style.left;
    if (style.display) el.style.display = style.display;
    if (style.flexDirection) el.style.flexDirection = style.flexDirection;
    if (style.flexWrap) el.style.flexWrap = style.flexWrap;
    if (style.gap) el.style.gap = style.gap;
    if (style.alignItems) el.style.alignItems = style.alignItems;
    if (style.justifyContent) el.style.justifyContent = style.justifyContent;
  }

  private createImageElement(block: ImageBlock): HTMLElement {
    const img = document.createElement('img');
    img.src = block.src;
    if (block.alt) img.alt = block.alt;
    if (block.title) img.title = block.title;
    if (block.width) img.style.width = `${block.width}px`;
    if (block.height) img.style.height = `${block.height}px`;
    img.style.maxWidth = '100%';
    img.draggable = false; // prevent native image drag
    return img;
  }

  private createListElement(ordered: boolean, items: ListItem[]): HTMLElement {
    const list = document.createElement(ordered ? 'ol' : 'ul');
    for (const item of items) {
      const li = document.createElement('li');
      // Render inline content as HTML text
      li.innerHTML = this.inlinesToHtml(item.content);
      if (item.checked !== undefined) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = item.checked;
        cb.disabled = true;
        li.prepend(cb);
      }
      if (item.children) {
        li.appendChild(this.createListElement(item.children.ordered, item.children.items));
      }
      list.appendChild(li);
    }
    return list;
  }

  private createTableElement(headers: TableCell[], rows: TableCell[][]): HTMLElement {
    const table = document.createElement('table');

    if (headers.length > 0) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      for (const cell of headers) {
        const th = document.createElement('th');
        th.innerHTML = this.inlinesToHtml(cell.content);
        if (cell.colspan && cell.colspan > 1) th.colSpan = cell.colspan;
        if (cell.rowspan && cell.rowspan > 1) th.rowSpan = cell.rowspan;
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        td.innerHTML = this.inlinesToHtml(cell.content);
        if (cell.colspan && cell.colspan > 1) td.colSpan = cell.colspan;
        if (cell.rowspan && cell.rowspan > 1) td.rowSpan = cell.rowspan;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return table;
  }

  /** Simple inline content → HTML string (for non-editable blocks like lists/tables) */
  private inlinesToHtml(inlines: InlineContent[]): string {
    return inlines.map(inline => {
      switch (inline.type) {
        case 'text': {
          let html = this.escapeHtml(inline.text);
          if (inline.marks) {
            for (const mark of inline.marks) {
              switch (mark.type) {
                case 'bold': html = `<strong>${html}</strong>`; break;
                case 'italic': html = `<em>${html}</em>`; break;
                case 'underline': html = `<u>${html}</u>`; break;
                case 'strikethrough': html = `<s>${html}</s>`; break;
                case 'code': html = `<code>${html}</code>`; break;
                case 'superscript': html = `<sup>${html}</sup>`; break;
                case 'subscript': html = `<sub>${html}</sub>`; break;
              }
            }
          }
          return html;
        }
        case 'link':
          return `<a href="${this.escapeHtml(inline.href)}">${this.inlinesToHtml(inline.content)}</a>`;
        case 'image':
          return `<img src="${this.escapeHtml(inline.src)}" alt="${this.escapeHtml(inline.alt ?? '')}">`;
        case 'code':
          return `<code>${this.escapeHtml(inline.text)}</code>`;
        case 'break':
          return '<br>';
      }
    }).join('');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Public reorder for BlockEngine.moveBlock */
  reorderDomPublic(container: HTMLElement, ids: string[]): void {
    this.reorderDom(container, ids);
  }

  /** Reorder DOM children to match the given ID order (minimal moves) */
  private reorderDom(container: HTMLElement, ids: string[]): void {
    let currentChild = container.firstElementChild as HTMLElement | null;

    for (const id of ids) {
      const node = this.registry.get(id);
      if (!node) continue;

      if (currentChild === node.element) {
        // Already in correct position
        currentChild = currentChild.nextElementSibling as HTMLElement | null;
      } else {
        // Move element to correct position
        container.insertBefore(node.element, currentChild);
      }
    }
  }
}
