import type { FormatCodec } from './CodecRegistry';
import type {
  DocumentTree,
  Block,
  InlineContent,
  TextMark,
  ListItem,
  TableCell,
} from '../model/DocumentTree';

// ODT Codec — parses OpenDocument Text (.odt) files into DocumentTree
// ODT is a ZIP archive containing content.xml (ODF XML format)
// Uses JSZip to extract, then DOM-parses the XML

export const odtCodec: FormatCodec = {
  id: 'odt',
  name: 'OpenDocument Text',
  extensions: ['odt'],
  mimeTypes: ['application/vnd.oasis.opendocument.text'],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);

    // Extract content.xml
    const contentXml = await zip.file('content.xml')?.async('string');
    if (!contentXml) {
      return {
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Could not read ODT content.' }] }],
        metadata: { title: fileName ?? 'Untitled', sourceFormat: 'odt', sourceFileName: fileName },
      };
    }

    // Extract images from the archive for base64 embedding
    const images = new Map<string, string>();
    const imageFiles = Object.keys(zip.files).filter((f) => f.startsWith('Pictures/'));
    for (const imgPath of imageFiles) {
      const data = await zip.file(imgPath)?.async('base64');
      if (data) {
        const ext = imgPath.split('.').pop()?.toLowerCase() ?? 'png';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'svg' ? 'image/svg+xml'
          : `image/${ext}`;
        images.set(imgPath, `data:${mime};base64,${data}`);
      }
    }

    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(contentXml, 'application/xml');
    const ns = {
      text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
      table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
      draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
      xlink: 'http://www.w3.org/1999/xlink',
      style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
      fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
    };

    // Build style map for bold/italic detection
    const styleMap = new Map<string, TextMark[]>();
    const autoStyles = doc.getElementsByTagNameNS(ns.style, 'style');
    for (let i = 0; i < autoStyles.length; i++) {
      const style = autoStyles[i];
      const name = style.getAttribute('style:name');
      if (!name) continue;
      const marks: TextMark[] = [];
      const textProps = style.getElementsByTagNameNS(ns.style, 'text-properties')[0];
      if (textProps) {
        const weight = textProps.getAttributeNS(ns.fo, 'font-weight');
        if (weight === 'bold') marks.push({ type: 'bold' });
        const fontStyle = textProps.getAttributeNS(ns.fo, 'font-style');
        if (fontStyle === 'italic') marks.push({ type: 'italic' });
        const underline = textProps.getAttributeNS(ns.style, 'text-underline-style');
        if (underline && underline !== 'none') marks.push({ type: 'underline' });
        const strikethrough = textProps.getAttributeNS(ns.style, 'text-line-through-style');
        if (strikethrough && strikethrough !== 'none') marks.push({ type: 'strikethrough' });
        const color = textProps.getAttributeNS(ns.fo, 'color');
        if (color && color !== '#000000') marks.push({ type: 'color', color });
      }
      if (marks.length > 0) styleMap.set(name, marks);
    }

    // Parse body content
    const body = doc.getElementsByTagNameNS(ns.text, 'body')[0];
    const textBody = body?.getElementsByTagNameNS(ns.text, 'text')[0];
    if (!textBody) {
      return {
        blocks: [{ type: 'paragraph', content: [] }],
        metadata: { title: fileName ?? 'Untitled', sourceFormat: 'odt', sourceFileName: fileName },
      };
    }

    const blocks = parseOdtChildren(textBody, ns, styleMap, images);

    // Extract title
    let title = fileName?.replace(/\.[^.]+$/, '') ?? 'Untitled';
    const firstHeading = blocks.find((b) => b.type === 'heading');
    if (firstHeading && firstHeading.type === 'heading') {
      const t = firstHeading.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text).join('');
      if (t) title = t;
    }

    return {
      blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }],
      metadata: { title, sourceFormat: 'odt', sourceFileName: fileName, modifiedAt: new Date().toISOString() },
    };
  },
};

type NS = Record<string, string>;

function parseOdtChildren(
  parent: Element,
  ns: NS,
  styleMap: Map<string, TextMark[]>,
  images: Map<string, string>,
): Block[] {
  const blocks: Block[] = [];

  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes[i];
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    const localName = el.localName;

    if (localName === 'p') {
      const content = parseOdtInline(el, ns, styleMap, images);
      blocks.push({ type: 'paragraph', content });
    } else if (localName === 'h') {
      const level = parseInt(el.getAttributeNS(ns.text, 'outline-level') ?? '1');
      const content = parseOdtInline(el, ns, styleMap, images);
      blocks.push({ type: 'heading', level: Math.min(Math.max(level, 1), 6) as 1|2|3|4|5|6, content });
    } else if (localName === 'list') {
      blocks.push(parseOdtList(el, ns, styleMap, images));
    } else if (localName === 'table' && el.namespaceURI === ns.table) {
      blocks.push(parseOdtTable(el, ns, styleMap, images));
    }
  }

  return blocks;
}

function parseOdtInline(
  el: Element,
  ns: NS,
  styleMap: Map<string, TextMark[]>,
  images: Map<string, string>,
): InlineContent[] {
  const result: InlineContent[] = [];

  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text) result.push({ type: 'text', text });
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const child = node as Element;
    const localName = child.localName;

    if (localName === 'span') {
      const styleName = child.getAttributeNS(ns.text, 'style-name');
      const marks = styleName ? styleMap.get(styleName) : undefined;
      const children = parseOdtInline(child, ns, styleMap, images);
      if (marks && marks.length > 0) {
        for (const c of children) {
          if (c.type === 'text') {
            c.marks = [...(c.marks ?? []), ...marks];
          }
        }
      }
      result.push(...children);
    } else if (localName === 'a') {
      const href = child.getAttributeNS(ns.xlink, 'href') ?? '';
      result.push({
        type: 'link',
        href,
        content: parseOdtInline(child, ns, styleMap, images),
      });
    } else if (localName === 'line-break') {
      result.push({ type: 'break' });
    } else if (localName === 's') {
      // text:s = space
      const count = parseInt(child.getAttributeNS(ns.text, 'c') ?? '1');
      result.push({ type: 'text', text: ' '.repeat(count) });
    } else if (localName === 'tab') {
      result.push({ type: 'text', text: '\t' });
    } else if (localName === 'frame') {
      // Image frame: draw:frame > draw:image
      const drawImage = child.getElementsByTagNameNS(ns.draw, 'image')[0];
      if (drawImage) {
        const href = drawImage.getAttributeNS(ns.xlink, 'href') ?? '';
        const src = images.get(href) ?? href;
        result.push({ type: 'image', src });
      }
    } else {
      // Recurse for unknown inline elements
      result.push(...parseOdtInline(child, ns, styleMap, images));
    }
  }

  return result;
}

function parseOdtList(
  el: Element,
  ns: NS,
  styleMap: Map<string, TextMark[]>,
  images: Map<string, string>,
): Block {
  const items: ListItem[] = [];

  const listItems = el.children;
  for (let i = 0; i < listItems.length; i++) {
    const li = listItems[i];
    if (li.localName !== 'list-item') continue;

    let content: InlineContent[] = [];
    let children: Block | undefined;

    for (let j = 0; j < li.children.length; j++) {
      const child = li.children[j];
      if (child.localName === 'p') {
        content = parseOdtInline(child, ns, styleMap, images);
      } else if (child.localName === 'list') {
        children = parseOdtList(child, ns, styleMap, images);
      }
    }

    const item: ListItem = { content };
    if (children && children.type === 'list') {
      item.children = children;
    }
    items.push(item);
  }

  // ODT doesn't clearly distinguish ordered vs unordered in content.xml alone
  // (it's in styles.xml). Default to unordered.
  return { type: 'list', ordered: false, items };
}

function parseOdtTable(
  el: Element,
  ns: NS,
  styleMap: Map<string, TextMark[]>,
  images: Map<string, string>,
): Block {
  const headers: TableCell[] = [];
  const rows: TableCell[][] = [];

  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];

    if (child.localName === 'table-header-rows') {
      for (let r = 0; r < child.children.length; r++) {
        const row = child.children[r];
        if (row.localName === 'table-row') {
          headers.push(...parseOdtTableRow(row, ns, styleMap, images));
        }
      }
    } else if (child.localName === 'table-row') {
      rows.push(parseOdtTableRow(child, ns, styleMap, images));
    }
  }

  return { type: 'table', headers, rows };
}

function parseOdtTableRow(
  row: Element,
  ns: NS,
  styleMap: Map<string, TextMark[]>,
  images: Map<string, string>,
): TableCell[] {
  const cells: TableCell[] = [];

  for (let i = 0; i < row.children.length; i++) {
    const cell = row.children[i];
    if (cell.localName !== 'table-cell') continue;

    const content: InlineContent[] = [];
    for (let j = 0; j < cell.children.length; j++) {
      const p = cell.children[j];
      if (p.localName === 'p') {
        content.push(...parseOdtInline(p, ns, styleMap, images));
      }
    }

    const colspan = parseInt(cell.getAttributeNS(ns.table, 'number-columns-spanned') ?? '1');
    const rowspan = parseInt(cell.getAttributeNS(ns.table, 'number-rows-spanned') ?? '1');
    cells.push({
      content,
      colspan: colspan > 1 ? colspan : undefined,
      rowspan: rowspan > 1 ? rowspan : undefined,
    });
  }

  return cells;
}
