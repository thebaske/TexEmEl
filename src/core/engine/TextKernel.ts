// ============================================================================
// TextKernel — ProseMirror wrapper for cell-level text editing
//
// Mounts a SINGLE ProseMirror editor per cell. The PM document contains all
// blocks (paragraphs, headings, code blocks) for that cell. PM handles
// navigation, Enter, paste, undo/redo natively within the cell.
//
// Cross-cell navigation is detected by checking if PM failed to move the
// cursor (position unchanged after PM processed the key).
// ============================================================================

import { EditorState, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Schema, DOMParser, Node as PmNode } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { inputRules, wrappingInputRule, textblockTypeInputRule } from 'prosemirror-inputrules';

import type {
  Block, InlineContent, TextMark,
  ParagraphBlock, HeadingBlock, CodeBlock,
} from '../model/DocumentTree';
import type { ITextKernel, NavigationHandler } from './types';
import { TextSelection } from 'prosemirror-state';
import { generateBlockId } from './BlockId';

// --- Schema ---

/** Build a ProseMirror schema with our mark types */
function buildSchema(): Schema {
  // Start with basic nodes and add list nodes
  let nodes = addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block');

  // Override paragraph node to support alignment
  nodes = nodes.update('paragraph', {
    content: 'inline*',
    group: 'block',
    attrs: { align: { default: null } },
    parseDOM: [{
      tag: 'p',
      getAttrs(node: HTMLElement) {
        return { align: node.style.textAlign || null };
      },
    }],
    toDOM(node: any) {
      const attrs: Record<string, string> = {};
      if (node.attrs.align) attrs.style = `text-align: ${node.attrs.align}`;
      return ['p', attrs, 0];
    },
  });

  // Override heading node to support alignment
  nodes = nodes.update('heading', {
    content: 'inline*',
    group: 'block',
    attrs: {
      level: { default: 1 },
      align: { default: null },
    },
    parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({
      tag: `h${level}`,
      attrs: { level },
      getAttrs(node: HTMLElement) {
        return { level, align: node.style.textAlign || null };
      },
    })),
    toDOM(node: any) {
      const attrs: Record<string, string> = {};
      if (node.attrs.align) attrs.style = `text-align: ${node.attrs.align}`;
      return [`h${node.attrs.level}`, attrs, 0];
    },
  });

  // Build marks
  const marks = basicSchema.spec.marks
    .update('underline', {
      parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
      toDOM() { return ['u', 0]; },
    })
    .update('strikethrough', {
      parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
      toDOM() { return ['s', 0]; },
    })
    .addToEnd('highlight', {
      attrs: { color: { default: null } },
      parseDOM: [{ tag: 'mark', getAttrs(node: HTMLElement) { return { color: node.style.backgroundColor || null }; } }],
      toDOM(mark: any) {
        const attrs: Record<string, string> = {};
        if (mark.attrs.color) attrs.style = `background-color: ${mark.attrs.color}`;
        return ['mark', attrs, 0];
      },
    })
    .addToEnd('color', {
      attrs: { color: { default: null } },
      parseDOM: [{ style: 'color', getAttrs(value: string) { return { color: value }; } }],
      toDOM(mark: any) {
        return ['span', { style: `color: ${mark.attrs.color}` }, 0];
      },
    })
    .addToEnd('fontFamily', {
      attrs: { family: { default: null } },
      parseDOM: [{ style: 'font-family', getAttrs(value: string) { return { family: value.replace(/['"]/g, '') }; } }],
      toDOM(mark: any) {
        return ['span', { style: `font-family: ${mark.attrs.family}` }, 0];
      },
    })
    .addToEnd('fontSize', {
      attrs: { size: { default: null } },
      parseDOM: [{ style: 'font-size', getAttrs(value: string) { return { size: value }; } }],
      toDOM(mark: any) {
        return ['span', { style: `font-size: ${mark.attrs.size}` }, 0];
      },
    })
    .addToEnd('superscript', {
      parseDOM: [{ tag: 'sup' }],
      toDOM() { return ['sup', 0]; },
      excludes: 'subscript',
    })
    .addToEnd('subscript', {
      parseDOM: [{ tag: 'sub' }],
      toDOM() { return ['sub', 0]; },
      excludes: 'superscript',
    })
    .addToEnd('link', {
      attrs: { href: { default: '' }, title: { default: null } },
      inclusive: false,
      parseDOM: [{
        tag: 'a[href]',
        getAttrs(node: HTMLElement) {
          return { href: node.getAttribute('href'), title: node.getAttribute('title') };
        },
      }],
      toDOM(mark: any) {
        return ['a', { href: mark.attrs.href, title: mark.attrs.title, target: '_blank', rel: 'noopener' }, 0];
      },
    });

  return new Schema({ nodes, marks });
}

const pmSchema = buildSchema();

// --- Keymaps ---

function buildKeymaps(schema: Schema) {
  const keys: Record<string, any> = {};

  if (schema.marks.strong) keys['Mod-b'] = toggleMark(schema.marks.strong);
  if (schema.marks.em) keys['Mod-i'] = toggleMark(schema.marks.em);
  if (schema.marks.underline) keys['Mod-u'] = toggleMark(schema.marks.underline);
  if (schema.marks.strikethrough) keys['Mod-Shift-x'] = toggleMark(schema.marks.strikethrough);

  return keymap(keys);
}

// --- Input Rules ---

function buildInputRules(schema: Schema) {
  const rules = [];

  if (schema.nodes.heading) {
    for (let level = 1; level <= 6; level++) {
      rules.push(
        textblockTypeInputRule(
          new RegExp(`^(#{${level}})\\s$`),
          schema.nodes.heading,
          { level }
        )
      );
    }
  }

  if (schema.nodes.blockquote) {
    rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));
  }

  return inputRules({ rules });
}

// --- TextKernel Class ---

export class TextKernel implements ITextKernel {
  private view: EditorView;
  private schema: Schema;
  private updateCallbacks: (() => void)[] = [];
  private selectionUpdateCallbacks: (() => void)[] = [];
  /** Stored cursor X for goal-column preservation across cell boundaries */
  lastCursorX: number | null = null;

  constructor(container: HTMLElement, blocks: Block[]) {
    this.schema = pmSchema;

    const doc = this.blocksToDoc(blocks);

    const state = EditorState.create({
      doc,
      schema: this.schema,
      plugins: [
        history(),
        buildKeymaps(this.schema),
        buildInputRules(this.schema),
        keymap(baseKeymap),
      ],
    });

    this.view = new EditorView(container, {
      state,
      dispatchTransaction: (tr: Transaction) => {
        const shouldScroll = tr.scrolledIntoView;
        const newState = this.view.state.apply(tr);
        this.view.updateState(newState);

        if (shouldScroll) {
          this.scrollCursorIntoView();
        }

        if (tr.docChanged) {
          for (const cb of this.updateCallbacks) cb();
        }

        if (tr.selectionSet || tr.storedMarksSet || tr.docChanged) {
          for (const cb of this.selectionUpdateCallbacks) cb();
        }
      },
    });
  }

  // =====================
  //  SCROLL INTO VIEW
  // =====================

  private scrollCursorIntoView(): void {
    requestAnimationFrame(() => {
      try {
        const coords = this.view.coordsAtPos(this.view.state.selection.from);
        const scrollParent = this.view.dom.closest('.bsp-cell-content');
        if (scrollParent) {
          const parentRect = scrollParent.getBoundingClientRect();
          if (coords.bottom > parentRect.bottom) {
            scrollParent.scrollTop += coords.bottom - parentRect.bottom + 10;
          } else if (coords.top < parentRect.top) {
            scrollParent.scrollTop -= parentRect.top - coords.top + 10;
          }
        }
      } catch { /* view may be destroyed */ }
    });
  }

  // Cross-cell navigation removed — cell switching is mouse-only.
  // PM handles all arrow key navigation natively within the cell.

  // =====================
  //  CONTENT: READ
  // =====================

  /** Read all blocks from the PM document. One Block per top-level PM node. */
  getBlocks(): Block[] {
    const { doc } = this.view.state;
    const blocks: Block[] = [];

    doc.forEach((node: PmNode, _offset: number) => {
      const block = this.pmNodeToBlock(node);
      if (block) blocks.push(block);
    });

    // If PM doc is empty (just one empty paragraph), return one empty paragraph
    if (blocks.length === 0) {
      blocks.push({ type: 'paragraph', content: [], id: generateBlockId() });
    }

    return blocks;
  }

  /** Legacy single-block read — returns first block (backward compat) */
  getContent(): Block {
    const blocks = this.getBlocks();
    return blocks[0] ?? { type: 'paragraph', content: [] };
  }

  /** Get the height of the PM document (for overflow detection) */
  getDocHeight(): number {
    return this.view.dom.scrollHeight;
  }

  // =====================
  //  CONTENT: WRITE
  // =====================

  /** Replace the entire PM document with new blocks */
  setBlocks(blocks: Block[]): void {
    const doc = this.blocksToDoc(blocks);
    const state = EditorState.create({
      doc,
      schema: this.schema,
      plugins: this.view.state.plugins,
    });
    this.view.updateState(state);
  }

  /** Legacy single-block write (backward compat) */
  setContent(block: Block): void {
    this.setBlocks([block]);
  }

  // =====================
  //  OVERFLOW SPLIT
  // =====================

  /**
   * Split the PM document at the given pixel height.
   * Finds the last top-level node that fits within maxHeight,
   * keeps the "before" portion in this editor, and returns the
   * "after" portion as Block[].
   *
   * Returns empty array if everything fits.
   */
  splitAt(maxHeight: number): Block[] {
    const { doc } = this.view.state;
    const editorTop = this.view.dom.getBoundingClientRect().top;

    // Walk top-level nodes to find the last one that fits
    let lastFittingEnd = 0;
    let splitFound = false;

    doc.forEach((node: PmNode, offset: number) => {
      const endPos = offset + node.nodeSize;
      try {
        // Get the bottom coordinate of this node
        // Use endPos - 1 to get position inside the node (not after it)
        const coords = this.view.coordsAtPos(Math.min(endPos, doc.content.size));
        const relativeBottom = coords.bottom - editorTop;

        if (relativeBottom <= maxHeight) {
          lastFittingEnd = endPos;
        } else {
          splitFound = true;
        }
      } catch {
        // If coordsAtPos fails, assume it doesn't fit
        splitFound = true;
      }
    });

    if (!splitFound) return []; // Everything fits

    // Ensure we keep at least one node
    if (lastFittingEnd === 0) {
      // Even the first node doesn't fit — keep it anyway and split after it
      doc.forEach((node: PmNode, offset: number) => {
        if (lastFittingEnd === 0) {
          lastFittingEnd = offset + node.nodeSize;
        }
      });
    }

    // Split the PM doc
    const beforeDoc = doc.cut(0, lastFittingEnd);
    const afterDoc = doc.cut(lastFittingEnd);

    // Update this editor with the "before" portion
    const newState = EditorState.create({
      doc: beforeDoc,
      schema: this.schema,
      plugins: this.view.state.plugins,
    });
    this.view.updateState(newState);

    // Convert "after" to Block[]
    const overflowBlocks: Block[] = [];
    afterDoc.forEach((node: PmNode) => {
      const block = this.pmNodeToBlock(node);
      if (block) overflowBlocks.push(block);
    });

    return overflowBlocks;
  }

  /**
   * Split the PM document at the current cursor position.
   * Content before cursor stays in this editor.
   * Content after cursor (from the start of the next top-level node) is returned.
   * If cursor is at the very start or end, returns empty (no split).
   */
  splitAtCursor(): Block[] {
    const { doc, selection } = this.view.state;
    const cursorPos = selection.from;

    // Don't split at very start or very end
    if (cursorPos <= 1 || cursorPos >= doc.content.size - 1) return [];

    // Find the top-level node boundary nearest to (and after) the cursor.
    // We split BETWEEN top-level nodes, not mid-node.
    let splitPos = 0;
    let found = false;

    doc.forEach((node: PmNode, offset: number) => {
      if (found) return;
      const nodeEnd = offset + node.nodeSize;
      // If cursor is inside this node, split AFTER this node
      if (cursorPos >= offset && cursorPos < nodeEnd) {
        splitPos = nodeEnd;
        found = true;
      }
    });

    if (!found || splitPos === 0 || splitPos >= doc.content.size) return [];

    // Split the doc
    const beforeDoc = doc.cut(0, splitPos);
    const afterDoc = doc.cut(splitPos);

    // Update this editor with "before"
    const newState = EditorState.create({
      doc: beforeDoc,
      schema: this.schema,
      plugins: this.view.state.plugins,
    });
    this.view.updateState(newState);

    // Convert "after" to Block[]
    const overflowBlocks: Block[] = [];
    afterDoc.forEach((node: PmNode) => {
      const block = this.pmNodeToBlock(node);
      if (block) overflowBlocks.push(block);
    });

    return overflowBlocks;
  }

  // =====================
  //  MARKS & FORMATTING
  // =====================

  toggleMark(markType: string, attrs?: Record<string, unknown>): void {
    const pmMarkName = this.mapMarkName(markType);
    const mark = this.schema.marks[pmMarkName];
    if (!mark) return;
    toggleMark(mark, attrs as any)(this.view.state, this.view.dispatch);
  }

  getActiveMarks(): TextMark[] {
    const state = this.view.state;
    const { from, $from, to, empty } = state.selection;
    const marks: TextMark[] = [];

    if (empty) {
      const storedMarks = state.storedMarks || $from.marks();
      for (const mark of storedMarks) {
        const mapped = this.mapPmMarkToTextMark(mark);
        if (mapped) marks.push(mapped);
      }
    } else {
      state.doc.nodesBetween(from, to, (node) => {
        if (node.isText && node.marks) {
          for (const mark of node.marks) {
            const mapped = this.mapPmMarkToTextMark(mark);
            if (mapped && !marks.some(m => m.type === mapped.type)) {
              marks.push(mapped);
            }
          }
        }
      });
    }

    return marks;
  }

  setTextAlign(align: string): void {
    const state = this.view.state;
    const { from, to } = state.selection;
    const tr = state.tr;

    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === this.schema.nodes.paragraph || node.type === this.schema.nodes.heading) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: align || null });
      }
    });

    if (tr.docChanged) {
      this.view.dispatch(tr);
    }
  }

  getTextAlign(): string {
    const state = this.view.state;
    const { $from } = state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node.type === this.schema.nodes.paragraph || node.type === this.schema.nodes.heading) {
        return node.attrs.align || 'left';
      }
    }
    return 'left';
  }

  setFontFamily(family: string): void {
    const mark = this.schema.marks.fontFamily;
    if (!mark) return;
    const { from, to, empty } = this.view.state.selection;
    if (empty) {
      this.view.dispatch(this.view.state.tr.addStoredMark(mark.create({ family })));
    } else {
      this.view.dispatch(this.view.state.tr.addMark(from, to, mark.create({ family })));
    }
  }

  setFontSize(size: string): void {
    const mark = this.schema.marks.fontSize;
    if (!mark) return;
    const { from, to, empty } = this.view.state.selection;
    if (empty) {
      this.view.dispatch(this.view.state.tr.addStoredMark(mark.create({ size })));
    } else {
      this.view.dispatch(this.view.state.tr.addMark(from, to, mark.create({ size })));
    }
  }

  insertLink(href: string, title?: string): void {
    const mark = this.schema.marks.link;
    if (!mark) return;
    const { from, to, empty } = this.view.state.selection;
    if (empty) return;
    this.view.dispatch(this.view.state.tr.addMark(from, to, mark.create({ href, title: title || null })));
  }

  removeLink(): void {
    const mark = this.schema.marks.link;
    if (!mark) return;
    const { from, to } = this.view.state.selection;
    this.view.dispatch(this.view.state.tr.removeMark(from, to, mark));
  }

  // =====================
  //  FOCUS & CURSOR
  // =====================

  focus(): void {
    this.view.focus();
  }

  blur(): void {
    (this.view.dom as HTMLElement).blur();
  }

  focusStart(): void {
    this.view.focus();
    const tr = this.view.state.tr.setSelection(
      TextSelection.create(this.view.state.doc, 1)
    );
    this.view.dispatch(tr);
  }

  focusEnd(): void {
    this.view.focus();
    const endPos = Math.max(1, this.view.state.doc.content.size - 1);
    const tr = this.view.state.tr.setSelection(
      TextSelection.create(this.view.state.doc, endPos)
    );
    this.view.dispatch(tr);
  }

  /**
   * Focus the first or last line and place cursor at closest position to targetX.
   * Preserves goal-column when crossing cell boundaries.
   */
  focusLineAtX(line: 'first' | 'last', targetX: number | null): void {
    this.view.focus();
    const { doc } = this.view.state;

    if (targetX === null) {
      if (line === 'first') { this.focusStart(); } else { this.focusEnd(); }
      return;
    }

    try {
      let lineY: number;
      if (line === 'first') {
        const coords = this.view.coordsAtPos(1);
        lineY = (coords.top + coords.bottom) / 2;
      } else {
        const endPos = Math.max(1, doc.content.size - 1);
        const coords = this.view.coordsAtPos(endPos);
        lineY = (coords.top + coords.bottom) / 2;
      }

      const posInfo = this.view.posAtCoords({ left: targetX, top: lineY });
      if (posInfo) {
        const tr = this.view.state.tr.setSelection(
          TextSelection.create(doc, posInfo.pos)
        );
        this.view.dispatch(tr);
      } else {
        if (line === 'first') { this.focusStart(); } else { this.focusEnd(); }
      }
    } catch {
      if (line === 'first') { this.focusStart(); } else { this.focusEnd(); }
    }
  }

  selectAll(): void {
    this.view.focus();
    const { doc } = this.view.state;
    const tr = this.view.state.tr.setSelection(
      TextSelection.create(doc, 1, Math.max(1, doc.content.size - 1))
    );
    this.view.dispatch(tr);
  }

  // =====================
  //  BOUNDARY CHECKS
  // =====================

  isCursorAtStart(): boolean {
    const { selection } = this.view.state;
    return selection.empty && selection.from <= 1;
  }

  isCursorAtEnd(): boolean {
    const { selection, doc } = this.view.state;
    return selection.empty && selection.to >= doc.content.size - 1;
  }

  // =====================
  //  UNDO / REDO
  // =====================

  undo(): boolean {
    return undo(this.view.state, this.view.dispatch);
  }

  redo(): boolean {
    return redo(this.view.state, this.view.dispatch);
  }

  // =====================
  //  CALLBACKS
  // =====================

  onUpdate(callback: () => void): void {
    this.updateCallbacks.push(callback);
  }

  onSelectionUpdate(callback: () => void): void {
    this.selectionUpdateCallbacks.push(callback);
  }

  setNavigationHandler(_handler: NavigationHandler | null): void {
    // Navigation is mouse-only — handler stored but not used for arrow keys
  }

  getView(): EditorView {
    return this.view;
  }

  // =====================
  //  BLOCK TYPE OPERATIONS
  // =====================

  /** Get the type of the block at the current cursor position */
  getCurrentBlockType(): { type: string; level?: number } | null {
    const { $from } = this.view.state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node.type === this.schema.nodes.heading) {
        return { type: 'heading', level: node.attrs.level };
      }
      if (node.type === this.schema.nodes.paragraph) {
        return { type: 'paragraph' };
      }
      if (node.type === this.schema.nodes.code_block) {
        return { type: 'codeBlock' };
      }
    }
    return null;
  }

  /** Change the block type at the current cursor (paragraph ↔ heading) */
  setBlockType(type: string): void {
    const { $from } = this.view.state.selection;
    const pos = $from.before($from.depth);

    if (type === 'paragraph') {
      const tr = this.view.state.tr.setNodeMarkup(pos, this.schema.nodes.paragraph, { align: null });
      this.view.dispatch(tr);
    } else if (type.startsWith('heading:')) {
      const level = parseInt(type.split(':')[1]);
      const tr = this.view.state.tr.setNodeMarkup(pos, this.schema.nodes.heading, { level, align: null });
      this.view.dispatch(tr);
    }
  }

  // =====================
  //  LIFECYCLE
  // =====================

  destroy(): void {
    this.view.destroy();
    this.updateCallbacks = [];
    this.selectionUpdateCallbacks = [];
  }

  // =====================
  //  CONVERSION: Blocks → PM Doc
  // =====================

  /** Convert Block[] to a single PM document */
  private blocksToDoc(blocks: Block[]): PmNode {
    if (blocks.length === 0) {
      return this.htmlToDoc('<p></p>');
    }

    // Build HTML for all blocks, then parse into one PM doc
    const htmlParts: string[] = [];

    for (const block of blocks) {
      htmlParts.push(this.blockToHtml(block));
    }

    return this.htmlToDoc(htmlParts.join(''));
  }

  /** Convert a single Block to HTML string */
  private blockToHtml(block: Block): string {
    // If we have a lossless ProseMirror doc snapshot, convert it via PM
    // (only for single-block compat — multi-block uses the HTML path)
    switch (block.type) {
      case 'paragraph': {
        const alignStyle = block.alignment ? ` style="text-align:${block.alignment}"` : '';
        const paragraphs = this.splitOnBreaks(block.content);
        return paragraphs
          .map(p => `<p${alignStyle}>${this.inlinesToHtml(p)}</p>`)
          .join('');
      }
      case 'heading': {
        const alignStyle = block.alignment ? ` style="text-align:${block.alignment}"` : '';
        const paragraphs = this.splitOnBreaks(block.content);
        const firstPara = paragraphs[0] ?? [];
        let html = `<h${block.level}${alignStyle}>${this.inlinesToHtml(firstPara)}</h${block.level}>`;
        for (let i = 1; i < paragraphs.length; i++) {
          html += `<p${alignStyle}>${this.inlinesToHtml(paragraphs[i])}</p>`;
        }
        return html;
      }
      case 'codeBlock':
        return `<pre><code>${this.escapeHtml(block.code)}</code></pre>`;
      case 'divider':
        return '<hr>';
      case 'image':
        return `<p><img src="${this.escapeHtml(block.src)}" alt="${this.escapeHtml(block.alt ?? '')}"></p>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const listItems = block.items.map(item => {
          const content = this.inlinesToHtml(item.content);
          const children = item.children ? this.blockToHtml(item.children) : '';
          return `<li>${content}${children}</li>`;
        }).join('');
        return `<${tag}>${listItems}</${tag}>`;
      }
      case 'blockquote': {
        const inner = block.blocks.map(b => this.blockToHtml(b)).join('');
        return `<blockquote>${inner}</blockquote>`;
      }
      case 'table': {
        // PM basic schema has no table nodes — render as paragraphs with tab-separated cells.
        // Each row becomes a paragraph. Headers are bold.
        const lines: string[] = [];
        if (block.headers.length > 0) {
          const headerText = block.headers.map(h =>
            `<strong>${this.inlinesToHtml(h.content) || ' '}</strong>`
          ).join(' │ ');
          lines.push(`<p>${headerText}</p>`);
          // Separator line
          lines.push(`<p>${block.headers.map(() => '────').join('─┼─')}</p>`);
        }
        for (const row of block.rows) {
          const rowText = row.map(c => this.inlinesToHtml(c.content) || ' ').join(' │ ');
          lines.push(`<p>${rowText}</p>`);
        }
        return lines.join('');
      }
      case 'container': {
        return block.children.map(b => this.blockToHtml(b)).join('');
      }
      default:
        return '<p></p>';
    }
  }

  // =====================
  //  CONVERSION: PM Doc → Blocks
  // =====================

  /** Convert a top-level PM node to a Block */
  private pmNodeToBlock(node: PmNode): Block | null {
    const id = generateBlockId();

    if (node.type === this.schema.nodes.paragraph) {
      const inlines = this.nodeToInlines(node);
      const align = node.attrs.align || undefined;
      return { type: 'paragraph', content: inlines, alignment: align, id } as ParagraphBlock;
    }

    if (node.type === this.schema.nodes.heading) {
      const inlines = this.nodeToInlines(node);
      const align = node.attrs.align || undefined;
      const level = node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6;
      return { type: 'heading', level, content: inlines, alignment: align, id } as HeadingBlock;
    }

    if (node.type === this.schema.nodes.code_block) {
      return { type: 'codeBlock', code: node.textContent, id } as CodeBlock;
    }

    if (node.type === this.schema.nodes.horizontal_rule) {
      return { type: 'divider', id };
    }

    // Fallback: convert to paragraph
    const inlines = this.nodeToInlines(node);
    return { type: 'paragraph', content: inlines, id };
  }

  /** Extract InlineContent[] from a single PM block node */
  private nodeToInlines(blockNode: PmNode): InlineContent[] {
    const inlines: InlineContent[] = [];

    if (blockNode.content.size === 0) return inlines;

    blockNode.forEach((inlineNode: PmNode) => {
      if (inlineNode.isText) {
        const marks: TextMark[] = [];
        for (const mark of inlineNode.marks) {
          const mapped = this.mapPmMarkToTextMark(mark);
          if (mapped) marks.push(mapped);
        }
        inlines.push({
          type: 'text',
          text: inlineNode.text!,
          marks: marks.length > 0 ? marks : undefined,
        });
      } else if (inlineNode.type.name === 'hard_break') {
        inlines.push({ type: 'break' });
      } else if (inlineNode.type.name === 'image') {
        inlines.push({
          type: 'image',
          src: inlineNode.attrs.src ?? '',
          alt: inlineNode.attrs.alt ?? '',
        });
      }
    });

    return inlines;
  }

  // =====================
  //  HTML HELPERS
  // =====================

  private splitOnBreaks(content: InlineContent[]): InlineContent[][] {
    const result: InlineContent[][] = [[]];
    for (const inline of content) {
      if (inline.type === 'break') {
        result.push([]);
      } else {
        result[result.length - 1].push(inline);
      }
    }
    return result;
  }

  private htmlToDoc(html: string): PmNode {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return DOMParser.fromSchema(this.schema).parse(wrapper);
  }

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
                case 'highlight': {
                  const style = mark.color ? ` style="background-color:${mark.color}"` : '';
                  html = `<mark${style}>${html}</mark>`;
                  break;
                }
                case 'color':
                  html = `<span style="color:${mark.color}">${html}</span>`;
                  break;
                case 'fontFamily':
                  html = `<span style="font-family:${mark.family}">${html}</span>`;
                  break;
                case 'fontSize':
                  html = `<span style="font-size:${mark.size}">${html}</span>`;
                  break;
                case 'superscript': html = `<sup>${html}</sup>`; break;
                case 'subscript': html = `<sub>${html}</sub>`; break;
                case 'link':
                  html = `<a href="${this.escapeHtml(mark.href)}">${html}</a>`;
                  break;
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

  // =====================
  //  MARK MAPPING
  // =====================

  private mapMarkName(markType: string): string {
    const map: Record<string, string> = {
      bold: 'strong', italic: 'em', underline: 'underline',
      strikethrough: 'strikethrough', code: 'code', highlight: 'highlight',
      color: 'color', fontFamily: 'fontFamily', fontSize: 'fontSize',
      superscript: 'superscript', subscript: 'subscript', link: 'link',
    };
    return map[markType] ?? markType;
  }

  private mapPmMarkToTextMark(mark: any): TextMark | null {
    switch (mark.type.name) {
      case 'strong': return { type: 'bold' };
      case 'em': return { type: 'italic' };
      case 'underline': return { type: 'underline' };
      case 'strikethrough': return { type: 'strikethrough' };
      case 'code': return { type: 'code' };
      case 'highlight': return { type: 'highlight', color: mark.attrs.color };
      case 'color': return { type: 'color', color: mark.attrs.color };
      case 'fontFamily': return { type: 'fontFamily', family: mark.attrs.family };
      case 'fontSize': return { type: 'fontSize', size: mark.attrs.size };
      case 'superscript': return { type: 'superscript' };
      case 'subscript': return { type: 'subscript' };
      case 'link': return { type: 'link', href: mark.attrs.href, title: mark.attrs.title };
      default: return null;
    }
  }
}
