import type { FormatCodec } from './CodecRegistry';
import type {
  DocumentTree,
  Block,
  InlineContent,
  TextMark,
  ListItem,
  TableCell,
  LayoutPageData,
  LayoutNodeData,
} from '../model/DocumentTree';

// HTML Codec — parses HTML into DocumentTree using DOMParser
// This is also used by DocxCodec (mammoth outputs HTML)

export const htmlCodec: FormatCodec = {
  id: 'html',
  name: 'HTML Document',
  extensions: ['html', 'htm', 'xhtml'],
  mimeTypes: ['text/html', 'application/xhtml+xml'],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    const html = new TextDecoder('utf-8').decode(buffer);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const title =
      doc.querySelector('title')?.textContent ??
      fileName?.replace(/\.[^.]+$/, '') ??
      'Untitled';

    const body = doc.body;

    // Detect TexElEm layout structure
    const pageEls = body.querySelectorAll('.texemel-page');
    if (pageEls.length > 0) {
      return parseTexemelLayout(pageEls, title, fileName);
    }

    // Standard flat HTML parsing
    const blocks = parseElements(body.children);

    return {
      blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }],
      metadata: {
        title,
        sourceFormat: 'html',
        sourceFileName: fileName,
        modifiedAt: new Date().toISOString(),
      },
    };
  },
};

// ============================================================================
// TexElEm Layout Parsing — Reconstruct BSP tree from texemel-* classes
// ============================================================================

function parseTexemelLayout(
  pageEls: NodeListOf<Element>,
  title: string,
  fileName?: string,
): DocumentTree {
  const layoutPages: LayoutPageData[] = [];
  const allBlocks: Block[] = [];

  for (let i = 0; i < pageEls.length; i++) {
    const pageEl = pageEls[i] as HTMLElement;
    const pageId = pageEl.dataset.pageId ?? `page-${i}`;

    // Parse the BSP structure from nested children
    const layout = parseLayoutNode(pageEl);
    if (layout) {
      layoutPages.push({ id: pageId, layout });
      // Collect all blocks from leaves for the flat block list
      collectBlocksFromLayout(layout, allBlocks);
    }
  }

  return {
    blocks: allBlocks.length > 0 ? allBlocks : [{ type: 'paragraph', content: [] }],
    metadata: {
      title,
      sourceFormat: 'html',
      sourceFileName: fileName,
      modifiedAt: new Date().toISOString(),
      layoutPages,
    },
  };
}

function parseLayoutNode(el: HTMLElement): LayoutNodeData | null {
  // Check if this element IS a cell
  if (el.classList.contains('texemel-cell')) {
    const cellId = el.dataset.cellId ?? crypto.randomUUID();
    const blocks = parseElements(el.children);
    return { type: 'leaf', id: cellId, blocks };
  }

  // Check if this element IS a split
  if (el.classList.contains('texemel-split-h') || el.classList.contains('texemel-split-v')) {
    const direction = el.classList.contains('texemel-split-h') ? 'horizontal' as const : 'vertical' as const;
    const splitId = el.dataset.splitId ?? crypto.randomUUID();
    const ratio = parseFloat(el.dataset.ratio ?? '0.5');

    // Children should be two divs with flex styles wrapping the actual split/cell nodes
    const children = Array.from(el.children).filter(c => c instanceof HTMLElement) as HTMLElement[];
    if (children.length < 2) return null;

    // Each child wrapper contains the actual layout node
    const firstChild = findLayoutChild(children[0]);
    const secondChild = findLayoutChild(children[1]);

    if (!firstChild || !secondChild) return null;

    return { type: 'split', id: splitId, direction, ratio, first: firstChild, second: secondChild };
  }

  // Check if this element is a page wrapper — look for first layout child
  const firstLayoutChild = findLayoutChild(el);
  return firstLayoutChild;
}

function findLayoutChild(el: HTMLElement): LayoutNodeData | null {
  // The element itself might be the layout node
  if (el.classList.contains('texemel-cell') ||
      el.classList.contains('texemel-split-h') ||
      el.classList.contains('texemel-split-v')) {
    return parseLayoutNode(el);
  }

  // Search direct children
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i] as HTMLElement;
    if (child.classList.contains('texemel-cell') ||
        child.classList.contains('texemel-split-h') ||
        child.classList.contains('texemel-split-v')) {
      return parseLayoutNode(child);
    }
  }

  // If no layout node found, treat entire content as a single cell
  const blocks = parseElements(el.children);
  if (blocks.length > 0) {
    return { type: 'leaf', id: crypto.randomUUID(), blocks };
  }

  return null;
}

function collectBlocksFromLayout(node: LayoutNodeData, blocks: Block[]): void {
  if (node.type === 'leaf') {
    blocks.push(...node.blocks);
  } else {
    collectBlocksFromLayout(node.first, blocks);
    collectBlocksFromLayout(node.second, blocks);
  }
}

function parseElements(elements: HTMLCollection): Block[] {
  const blocks: Block[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as HTMLElement;
    const tag = el.tagName.toLowerCase();

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, content: parseInlineChildren(el) });
      continue;
    }

    // Paragraph
    if (tag === 'p') {
      const content = parseInlineChildren(el);
      if (content.length > 0) {
        blocks.push({ type: 'paragraph', content });
      }
      continue;
    }

    // Lists
    if (tag === 'ul' || tag === 'ol') {
      blocks.push(parseList(el, tag === 'ol'));
      continue;
    }

    // Table
    if (tag === 'table') {
      blocks.push(parseTable(el));
      continue;
    }

    // Blockquote
    if (tag === 'blockquote') {
      blocks.push({ type: 'blockquote', blocks: parseElements(el.children) });
      continue;
    }

    // Code block (pre > code)
    if (tag === 'pre') {
      const codeEl = el.querySelector('code');
      const language = codeEl?.className?.match(/language-(\w+)/)?.[1];
      blocks.push({
        type: 'codeBlock',
        language,
        code: (codeEl ?? el).textContent ?? '',
      });
      continue;
    }

    // Image (block-level)
    if (tag === 'img') {
      blocks.push({
        type: 'image',
        src: el.getAttribute('src') ?? '',
        alt: el.getAttribute('alt') ?? undefined,
        title: el.getAttribute('title') ?? undefined,
      });
      continue;
    }

    // Figure (wraps image)
    if (tag === 'figure') {
      const img = el.querySelector('img');
      if (img) {
        const caption = el.querySelector('figcaption')?.textContent;
        blocks.push({
          type: 'image',
          src: img.getAttribute('src') ?? '',
          alt: caption ?? img.getAttribute('alt') ?? undefined,
        });
      }
      continue;
    }

    // Divider
    if (tag === 'hr') {
      blocks.push({ type: 'divider' });
      continue;
    }

    // Div or section — recurse into children
    if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main') {
      blocks.push(...parseElements(el.children));
      continue;
    }

    // Fallback: if element has text content, treat as paragraph
    const text = el.textContent?.trim();
    if (text) {
      blocks.push({ type: 'paragraph', content: parseInlineChildren(el) });
    }
  }

  return blocks;
}

function parseInlineChildren(el: HTMLElement): InlineContent[] {
  const result: InlineContent[] = [];

  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text) {
        result.push({ type: 'text', text });
      }
      continue;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const child = node as HTMLElement;
      const tag = child.tagName.toLowerCase();

      // Link
      if (tag === 'a') {
        result.push({
          type: 'link',
          href: child.getAttribute('href') ?? '',
          title: child.getAttribute('title') ?? undefined,
          content: parseInlineChildren(child),
        });
        continue;
      }

      // Inline image
      if (tag === 'img') {
        result.push({
          type: 'image',
          src: child.getAttribute('src') ?? '',
          alt: child.getAttribute('alt') ?? undefined,
        });
        continue;
      }

      // Code inline
      if (tag === 'code') {
        result.push({ type: 'code', text: child.textContent ?? '' });
        continue;
      }

      // Line break
      if (tag === 'br') {
        result.push({ type: 'break' });
        continue;
      }

      // Marks: bold, italic, underline, strikethrough
      const marks: TextMark[] = collectMarks(child);
      if (marks.length > 0) {
        // Recursively parse children and apply marks
        const children = parseInlineChildren(child);
        for (const c of children) {
          if (c.type === 'text') {
            c.marks = [...(c.marks ?? []), ...marks];
          }
          result.push(c);
        }
        continue;
      }

      // Span or unknown inline — recurse
      result.push(...parseInlineChildren(child));
    }
  }

  return result;
}

function collectMarks(el: HTMLElement): TextMark[] {
  const tag = el.tagName.toLowerCase();
  const marks: TextMark[] = [];

  // Tag-based marks
  if (tag === 'strong' || tag === 'b') marks.push({ type: 'bold' });
  if (tag === 'em' || tag === 'i') marks.push({ type: 'italic' });
  if (tag === 'u') marks.push({ type: 'underline' });
  if (tag === 's' || tag === 'del' || tag === 'strike') marks.push({ type: 'strikethrough' });
  if (tag === 'mark') marks.push({ type: 'highlight' });
  if (tag === 'sup') marks.push({ type: 'superscript' });
  if (tag === 'sub') marks.push({ type: 'subscript' });

  // Inline style-based marks (common in DOCX→HTML via mammoth, pasted HTML)
  const style = el.style;
  if (style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700) {
    if (!marks.some((m) => m.type === 'bold')) marks.push({ type: 'bold' });
  }
  if (style.fontStyle === 'italic') {
    if (!marks.some((m) => m.type === 'italic')) marks.push({ type: 'italic' });
  }
  if (style.textDecoration?.includes('underline')) {
    if (!marks.some((m) => m.type === 'underline')) marks.push({ type: 'underline' });
  }
  if (style.textDecoration?.includes('line-through')) {
    if (!marks.some((m) => m.type === 'strikethrough')) marks.push({ type: 'strikethrough' });
  }
  if (style.color) {
    marks.push({ type: 'color', color: style.color });
  }
  if (style.backgroundColor && style.backgroundColor !== 'transparent') {
    marks.push({ type: 'highlight', color: style.backgroundColor });
  }

  return marks;
}

function parseList(el: HTMLElement, ordered: boolean): Block {
  const items: ListItem[] = [];

  const lis = el.querySelectorAll(':scope > li');
  for (let i = 0; i < lis.length; i++) {
    const li = lis[i] as HTMLElement;
    const nestedList = li.querySelector(':scope > ul, :scope > ol');
    const content = parseInlineChildren(li);

    const item: ListItem = { content };

    // Task list detection (GitHub-style)
    const checkbox = li.querySelector(':scope > input[type="checkbox"]');
    if (checkbox) {
      item.checked = (checkbox as HTMLInputElement).checked;
    }

    if (nestedList) {
      item.children = parseList(
        nestedList as HTMLElement,
        nestedList.tagName.toLowerCase() === 'ol',
      ) as ListItem['children'];
    }

    items.push(item);
  }

  return { type: 'list', ordered, items };
}

function parseTable(el: HTMLElement): Block {
  const headers: TableCell[] = [];
  const rows: TableCell[][] = [];

  const thead = el.querySelector('thead');
  if (thead) {
    const ths = thead.querySelectorAll('th');
    for (let i = 0; i < ths.length; i++) {
      headers.push({
        content: parseInlineChildren(ths[i] as HTMLElement),
        colspan: parseInt(ths[i].getAttribute('colspan') ?? '1') || undefined,
        rowspan: parseInt(ths[i].getAttribute('rowspan') ?? '1') || undefined,
      });
    }
  }

  const tbody = el.querySelector('tbody') ?? el;
  const trs = tbody.querySelectorAll(':scope > tr');
  for (let i = 0; i < trs.length; i++) {
    const row: TableCell[] = [];
    const tds = trs[i].querySelectorAll('td, th');
    for (let j = 0; j < tds.length; j++) {
      row.push({
        content: parseInlineChildren(tds[j] as HTMLElement),
        colspan: parseInt(tds[j].getAttribute('colspan') ?? '1') || undefined,
        rowspan: parseInt(tds[j].getAttribute('rowspan') ?? '1') || undefined,
      });
    }
    // If no thead, treat first row as headers
    if (!thead && i === 0 && headers.length === 0) {
      headers.push(...row);
    } else {
      rows.push(row);
    }
  }

  return { type: 'table', headers, rows };
}
