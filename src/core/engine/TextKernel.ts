// ============================================================================
// TextKernel — ProseMirror wrapper for text-editable blocks
//
// Mounts a ProseMirror editor inside a block's content element.
// Handles text input, cursor, selection, inline formatting, and undo/redo.
// Block-level concerns (positioning, drag, resize) are NOT handled here.
// ============================================================================

import { EditorState, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { Schema, DOMParser } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { inputRules, wrappingInputRule, textblockTypeInputRule } from 'prosemirror-inputrules';

import type { Block, InlineContent, TextMark, ParagraphBlock, HeadingBlock, CodeBlock } from '../model/DocumentTree';
import type { ITextKernel } from './types';

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
        keymap(baseKeymap),
      ],
    });

    this.view = new EditorView(container, {
      state,
      dispatchTransaction: (tr: Transaction) => {
        const newState = this.view.state.apply(tr);
        this.view.updateState(newState);

        if (tr.docChanged) {
          for (const cb of this.updateCallbacks) {
            cb();
          }
        }

        // Selection/storedMarks changed (cursor moved, mark toggled) — toolbar needs update
        if (tr.selectionSet || tr.storedMarksSet || tr.docChanged) {
          for (const cb of this.selectionUpdateCallbacks) {
            cb();
          }
        }
      },
    });
  }

  // --- ITextKernel Implementation ---

  getContent(): Block {
    const doc = this.view.state.doc;
    const inlines = this.docToInlines(doc);

    // Read alignment from first block node
    const alignment = this.getTextAlign() || undefined;

    switch (this.block.type) {
      case 'paragraph':
        return { ...this.block, content: inlines, alignment } as ParagraphBlock;
      case 'heading':
        return { ...this.block, content: inlines, alignment } as HeadingBlock;
      case 'codeBlock': {
        const text = doc.textContent;
        return { ...this.block, code: text } as CodeBlock;
      }
      default:
        return this.block;
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

  destroy(): void {
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
    switch (block.type) {
      case 'paragraph': {
        const html = this.inlinesToHtml(block.content);
        const alignStyle = block.alignment ? ` style="text-align:${block.alignment}"` : '';
        return this.htmlToDoc(`<p${alignStyle}>${html}</p>`);
      }
      case 'heading': {
        const html = this.inlinesToHtml(block.content);
        const alignStyle = block.alignment ? ` style="text-align:${block.alignment}"` : '';
        return this.htmlToDoc(`<h${block.level}${alignStyle}>${html}</h${block.level}>`);
      }
      case 'codeBlock': {
        return this.htmlToDoc(`<pre><code>${this.escapeHtml(block.code)}</code></pre>`);
      }
      default:
        return this.htmlToDoc('<p></p>');
    }
  }

  private htmlToDoc(html: string): any {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    return DOMParser.fromSchema(this.schema).parse(wrapper);
  }

  private docToInlines(doc: any): InlineContent[] {
    const inlines: InlineContent[] = [];

    doc.descendants((node: any) => {
      if (node.isText) {
        const marks: TextMark[] = [];
        for (const mark of node.marks) {
          const mapped = this.mapPmMarkToTextMark(mark);
          if (mapped) marks.push(mapped);
        }
        inlines.push({
          type: 'text',
          text: node.text!,
          marks: marks.length > 0 ? marks : undefined,
        });
        return false;
      }
      if (node.type.name === 'hard_break') {
        inlines.push({ type: 'break' });
        return false;
      }
      return true;
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
