// ============================================================================
// TextKernel — ProseMirror wrapper for text-editable blocks
//
// Mounts a ProseMirror editor inside a block's content element.
// Handles text input, cursor, selection, inline formatting, and undo/redo.
// Block-level concerns (positioning, drag, resize) are NOT handled here.
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

import type { Block, InlineContent, TextMark, ParagraphBlock, HeadingBlock, CodeBlock } from '../model/DocumentTree';
import type { ITextKernel, NavigationHandler } from './types';
import { TextSelection } from 'prosemirror-state';

// --- Schema ---

/** Build a ProseMirror schema with our mark types */
function buildSchema(): Schema {
  // Start with basic nodes and add list nodes
  let nodes = addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block');

  // Override paragraph node to support alignment
  nodes = nodes.update('paragraph', {
    ...nodes.get('paragraph')!,
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
    ...nodes.get('heading')!,
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

  // Extend marks with our custom types
  const marks = basicSchema.spec.marks
    .append({
      underline: {
        parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
        toDOM() { return ['u', 0]; },
      },
      strikethrough: {
        parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
        toDOM() { return ['s', 0]; },
      },
      highlight: {
        attrs: { color: { default: null } },
        parseDOM: [{ tag: 'mark', getAttrs(node: HTMLElement) { return { color: node.style.backgroundColor || null }; } }],
        toDOM(mark: any) {
          const attrs: Record<string, string> = {};
          if (mark.attrs.color) attrs.style = `background-color: ${mark.attrs.color}`;
          return ['mark', attrs, 0];
        },
      },
      color: {
        attrs: { color: { default: null } },
        parseDOM: [{ style: 'color', getAttrs(value: string) { return { color: value }; } }],
        toDOM(mark: any) {
          return ['span', { style: `color: ${mark.attrs.color}` }, 0];
        },
      },
      fontFamily: {
        attrs: { family: { default: null } },
        parseDOM: [{ style: 'font-family', getAttrs(value: string) { return { family: value.replace(/['"]/g, '') }; } }],
        toDOM(mark: any) {
          return ['span', { style: `font-family: ${mark.attrs.family}` }, 0];
        },
      },
      fontSize: {
        attrs: { size: { default: null } },
        parseDOM: [{ style: 'font-size', getAttrs(value: string) { return { size: value }; } }],
        toDOM(mark: any) {
          return ['span', { style: `font-size: ${mark.attrs.size}` }, 0];
        },
      },
      superscript: {
        parseDOM: [{ tag: 'sup' }],
        toDOM() { return ['sup', 0]; },
        excludes: 'subscript',
      },
      subscript: {
        parseDOM: [{ tag: 'sub' }],
        toDOM() { return ['sub', 0]; },
        excludes: 'superscript',
      },
      link: {
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
  private block: Block;
  private updateCallbacks: (() => void)[] = [];
  private selectionUpdateCallbacks: (() => void)[] = [];
  private enterAtEndCallbacks: (() => void)[] = [];
  private navHandler: NavigationHandler | null = null;
  /** Stored cursor X for goal-column preservation across block boundaries */
  lastCursorX: number | null = null;

  constructor(container: HTMLElement, block: Block) {
    this.schema = pmSchema;
    this.block = block;

    const doc = this.blockToDoc(block);

    const state = EditorState.create({
      doc,
      schema: this.schema,
      plugins: [
        history(),
        buildKeymaps(this.schema),
        buildInputRules(this.schema),
        // Custom ArrowUp/Down handler that lets PM try first, then crosses blocks
        keymap({
          'ArrowUp': (state, dispatch, view) => this.handleVerticalNav('up', state, dispatch, view),
          'ArrowDown': (state, dispatch, view) => this.handleVerticalNav('down', state, dispatch, view),
        }),
        keymap(baseKeymap),
      ],
    });

    this.view = new EditorView(container, {
      state,
      dispatchTransaction: (tr: Transaction) => {
        const shouldScroll = tr.scrolledIntoView;
        const newState = this.view.state.apply(tr);
        this.view.updateState(newState);

        // Preserve ProseMirror's scrollIntoView intent (e.g. after Enter creates a new paragraph).
        // Without this, the cursor can end up in a paragraph below the cell's visible area.
        if (shouldScroll) {
          this.scrollCursorIntoView();
        }

        if (tr.docChanged) {
          for (const cb of this.updateCallbacks) {
            cb();
          }
        }

        if (tr.selectionSet || tr.storedMarksSet || tr.docChanged) {
          for (const cb of this.selectionUpdateCallbacks) {
            cb();
          }
        }
      },
      handleDOMEvents: {
        keydown: (_view: EditorView, event: KeyboardEvent) => {
          return this.handleHorizontalNav(event);
        },
      },
    });
  }

  // --- Scroll cursor into view within cell ---

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
      } catch { /* ignore if view was destroyed */ }
    });
  }

  // --- Navigation: Vertical (ArrowUp/Down) ---
  // Strategy: Record cursor position before PM handles the key. If PM doesn't move
  // the cursor (we're at a boundary), hand off to NavigationController.
  // This is a PM keymap command, so PM has NOT processed it yet when this runs.
  // We return false to let PM try; if PM can't move, we act in the next frame.

  private handleVerticalNav(
    direction: 'up' | 'down',
    state: EditorState,
    _dispatch: ((tr: Transaction) => void) | undefined,
    _view: EditorView | undefined,
  ): boolean {
    if (!this.navHandler) return false;

    const posBefore = state.selection.from;

    // Let ProseMirror handle the key first by returning false.
    // Then check in the next microtask whether the cursor actually moved.
    // If it didn't move, we're at a boundary → hand off to NavigationController.
    requestAnimationFrame(() => {
      const posAfter = this.view.state.selection.from;
      if (posAfter === posBefore) {
        // PM couldn't move — we're at a document boundary
        // Store cursor X for goal-column preservation in the target block
        try {
          this.lastCursorX = this.view.coordsAtPos(posAfter).left;
        } catch {
          this.lastCursorX = null;
        }
        this.navHandler?.onBoundary(direction);
      }
    });

    return false; // Always let PM try first
  }

  // --- Navigation: Horizontal (ArrowLeft/Right) ---
  // Only intercept at absolute start/end — these are cheap checks with no false positives.

  private handleHorizontalNav(event: KeyboardEvent): boolean {
    if (!this.navHandler) return false;
    if (event.shiftKey) return false;

    if (event.key === 'ArrowRight' && this.isCursorAtEnd()) {
      event.preventDefault();
      this.navHandler.onBoundary('right');
      return true;
    }

    if (event.key === 'ArrowLeft' && this.isCursorAtStart()) {
      event.preventDefault();
      this.navHandler.onBoundary('left');
      return true;
    }

    return false;
  }

  // --- ITextKernel Implementation ---

  getContent(): Block {
    const doc = this.view.state.doc;
    const inlines = this.docToInlines(doc);

    // Read alignment from first block node
    const alignment = this.getTextAlign() || undefined;

    // Capture lossless ProseMirror doc JSON for structural operations
    const pmDocJson = doc.toJSON() as Record<string, unknown>;

    switch (this.block.type) {
      case 'paragraph':
        return { ...this.block, content: inlines, alignment, pmDocJson } as ParagraphBlock;
      case 'heading':
        return { ...this.block, content: inlines, alignment, pmDocJson } as HeadingBlock;
      case 'codeBlock': {
        const text = doc.textContent;
        return { ...this.block, code: text, pmDocJson } as CodeBlock;
      }
      default:
        return { ...this.block, pmDocJson };
    }
  }

  setContent(block: Block): void {
    this.block = block;
    const doc = this.blockToDoc(block);
    const state = EditorState.create({
      doc,
      schema: this.schema,
      plugins: this.view.state.plugins,
    });
    this.view.updateState(state);
  }

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

  focus(): void {
    this.view.focus();
  }

  blur(): void {
    (this.view.dom as HTMLElement).blur();
  }

  undo(): boolean {
    return undo(this.view.state, this.view.dispatch);
  }

  redo(): boolean {
    return redo(this.view.state, this.view.dispatch);
  }

  onUpdate(callback: () => void): void {
    this.updateCallbacks.push(callback);
  }

  onSelectionUpdate(callback: () => void): void {
    this.selectionUpdateCallbacks.push(callback);
  }

  onEnterAtEnd(callback: () => void): void {
    this.enterAtEndCallbacks.push(callback);
  }

  // --- Navigation Methods ---

  setNavigationHandler(handler: NavigationHandler | null): void {
    this.navHandler = handler;
  }

  isCursorAtStart(): boolean {
    const { selection } = this.view.state;
    return selection.empty && selection.from <= 1; // pos 0 is before doc, 1 is start of first text
  }

  isCursorAtEnd(): boolean {
    const { selection, doc } = this.view.state;
    return selection.empty && selection.to >= doc.content.size - 1;
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
   * Focus the first or last line of this editor, placing the cursor at the
   * closest horizontal position to `targetX`. This preserves "goal column"
   * when arrowing between blocks — e.g. if the cursor was at column 5,
   * it should land near column 5 in the target block, not at position 0.
   */
  focusLineAtX(line: 'first' | 'last', targetX: number | null): void {
    this.view.focus();
    const { doc } = this.view.state;

    if (targetX === null) {
      // Fallback: no X info, just go to start/end
      if (line === 'first') { this.focusStart(); } else { this.focusEnd(); }
      return;
    }

    try {
      // Get the Y coordinate of the target line
      let lineY: number;
      if (line === 'first') {
        const coords = this.view.coordsAtPos(1);
        lineY = (coords.top + coords.bottom) / 2;
      } else {
        const endPos = Math.max(1, doc.content.size - 1);
        const coords = this.view.coordsAtPos(endPos);
        lineY = (coords.top + coords.bottom) / 2;
      }

      // Use posAtCoords to find the closest position at (targetX, lineY)
      const posInfo = this.view.posAtCoords({ left: targetX, top: lineY });
      if (posInfo) {
        const tr = this.view.state.tr.setSelection(
          TextSelection.create(doc, posInfo.pos)
        );
        this.view.dispatch(tr);
      } else {
        // Fallback
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

  destroy(): void {
    this.navHandler = null;
    this.view.destroy();
    this.updateCallbacks = [];
    this.selectionUpdateCallbacks = [];
    this.enterAtEndCallbacks = [];
  }

  // --- Phase 6: Text Alignment ---

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
    // Walk up to find the nearest block node
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node.type === this.schema.nodes.paragraph || node.type === this.schema.nodes.heading) {
        return node.attrs.align || 'left';
      }
    }
    return 'left';
  }

  // --- Phase 6: Font Family & Size ---

  setFontFamily(family: string): void {
    const mark = this.schema.marks.fontFamily;
    if (!mark) return;

    const { from, to, empty } = this.view.state.selection;
    if (empty) {
      // Store mark for next typed text
      const storedMark = mark.create({ family });
      this.view.dispatch(this.view.state.tr.addStoredMark(storedMark));
    } else {
      this.view.dispatch(
        this.view.state.tr.addMark(from, to, mark.create({ family }))
      );
    }
  }

  setFontSize(size: string): void {
    const mark = this.schema.marks.fontSize;
    if (!mark) return;

    const { from, to, empty } = this.view.state.selection;
    if (empty) {
      const storedMark = mark.create({ size });
      this.view.dispatch(this.view.state.tr.addStoredMark(storedMark));
    } else {
      this.view.dispatch(
        this.view.state.tr.addMark(from, to, mark.create({ size }))
      );
    }
  }

  // --- Phase 6: Links ---

  insertLink(href: string, title?: string): void {
    const mark = this.schema.marks.link;
    if (!mark) return;

    const { from, to, empty } = this.view.state.selection;
    if (empty) return; // need selected text to create link

    this.view.dispatch(
      this.view.state.tr.addMark(from, to, mark.create({ href, title: title || null }))
    );
  }

  removeLink(): void {
    const mark = this.schema.marks.link;
    if (!mark) return;

    const { from, to } = this.view.state.selection;
    this.view.dispatch(this.view.state.tr.removeMark(from, to, mark));
  }

  getView(): EditorView {
    return this.view;
  }

  // --- Conversion Helpers ---

  private blockToDoc(block: Block): any {
    // If we have a lossless ProseMirror doc snapshot, use it directly
    if (block.pmDocJson) {
      try {
        return PmNode.fromJSON(this.schema, block.pmDocJson);
      } catch {
        // Fall through to legacy conversion if JSON is incompatible
      }
    }

    switch (block.type) {
      case 'paragraph': {
        const alignStyle = block.alignment ? ` style="text-align:${block.alignment}"` : '';
        // Split content on breaks to create separate <p> tags (preserves empty lines)
        const paragraphs = this.splitOnBreaks(block.content);
        const html = paragraphs
          .map(p => `<p${alignStyle}>${this.inlinesToHtml(p)}</p>`)
          .join('');
        return this.htmlToDoc(html || `<p${alignStyle}></p>`);
      }
      case 'heading': {
        const alignStyle = block.alignment ? ` style="text-align:${block.alignment}"` : '';
        // For headings, first paragraph is the heading, rest become <p> tags
        const paragraphs = this.splitOnBreaks(block.content);
        const firstPara = paragraphs[0] ?? [];
        let html = `<h${block.level}${alignStyle}>${this.inlinesToHtml(firstPara)}</h${block.level}>`;
        for (let i = 1; i < paragraphs.length; i++) {
          html += `<p${alignStyle}>${this.inlinesToHtml(paragraphs[i])}</p>`;
        }
        return this.htmlToDoc(html);
      }
      case 'codeBlock': {
        return this.htmlToDoc(`<pre><code>${this.escapeHtml(block.code)}</code></pre>`);
      }
      default:
        return this.htmlToDoc('<p></p>');
    }
  }

  /** Split InlineContent[] on break elements into separate paragraph groups */
  private splitOnBreaks(content: InlineContent[]): InlineContent[][] {
    const result: InlineContent[][] = [[]];
    for (const inline of content) {
      if (inline.type === 'break') {
        result.push([]); // Start new paragraph
      } else {
        result[result.length - 1].push(inline);
      }
    }
    return result;
  }

  private htmlToDoc(html: string): any {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return DOMParser.fromSchema(this.schema).parse(wrapper);
  }

  private docToInlines(doc: any): InlineContent[] {
    const inlines: InlineContent[] = [];
    let isFirstBlock = true;

    // Walk top-level block nodes (paragraphs, headings) to preserve line breaks
    doc.forEach((blockNode: any) => {
      // Add a break between paragraphs (not before the first one)
      if (!isFirstBlock) {
        inlines.push({ type: 'break' });
      }
      isFirstBlock = false;

      // Empty paragraph → just the break above is enough (represents an empty line)
      if (blockNode.content.size === 0) {
        return;
      }

      // Walk inline content within this block node
      blockNode.forEach((inlineNode: any) => {
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
        }
      });
    });

    return inlines;
  }

  private mapMarkName(markType: string): string {
    const map: Record<string, string> = {
      bold: 'strong',
      italic: 'em',
      underline: 'underline',
      strikethrough: 'strikethrough',
      code: 'code',
      highlight: 'highlight',
      color: 'color',
      fontFamily: 'fontFamily',
      fontSize: 'fontSize',
      superscript: 'superscript',
      subscript: 'subscript',
      link: 'link',
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
}

// --- Factory ---

export function createTextKernel(container: HTMLElement, block: Block): TextKernel {
  return new TextKernel(container, block);
}
