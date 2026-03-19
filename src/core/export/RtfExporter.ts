import type {
  DocumentTree,
  Block,
  InlineContent,
  ListItem,
  TableCell,
} from '../model/DocumentTree';

// ============================================================================
// RtfExporter — Converts DocumentTree → RTF string
//
// Produces a valid RTF document with:
// - Paragraphs, headings (via font size)
// - Bold, italic, underline, strikethrough
// - Ordered and unordered lists
// - Tables
// - Blockquotes (indented)
// - Code blocks (monospace font)
// - Horizontal rules
// ============================================================================

export function exportToRtf(tree: DocumentTree): string {
  const title = tree.metadata.title ?? 'Untitled';
  const body = tree.blocks.map(renderBlock).join('');

  return (
    '{\\rtf1\\ansi\\deff0\n' +
    // Font table: 0 = sans-serif, 1 = monospace
    '{\\fonttbl{\\f0\\fswiss Helvetica;}{\\f1\\fmodern Courier New;}}\n' +
    // Info group
    `{\\info{\\title ${escapeRtf(title)}}}\n` +
    // Default font size 24 half-points = 12pt
    '\\f0\\fs24\n' +
    body +
    '}'
  );
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case 'paragraph':
      return `\\pard ${renderInlines(block.content)}\\par\n`;
    case 'heading': {
      const size = block.level === 1 ? 48 : block.level === 2 ? 36 : block.level === 3 ? 32 : 28;
      return `\\pard {\\b\\fs${size} ${renderInlines(block.content)}}\\par\n`;
    }
    case 'list':
      return renderList(block.ordered, block.items, 0);
    case 'table':
      return renderTable(block.headers, block.rows);
    case 'image':
      // RTF image embedding is complex (requires hex-encoded bitmap data).
      // For now, output alt text as a placeholder.
      return `\\pard {\\i [Image: ${escapeRtf(block.alt ?? 'image')}]}\\par\n`;
    case 'codeBlock':
      return `\\pard\\li360\\ri360 {\\f1\\fs20 ${escapeRtf(block.code)}}\\par\n`;
    case 'blockquote':
      return `\\pard\\li720 ${block.blocks.map(renderBlockInline).join('')}\\par\n`;
    case 'divider':
      return '\\pard\\brdrb\\brdrs\\brdrw10\\brsp40 \\par\n';
    case 'container':
      return block.children.map(renderBlock).join('');
  }
}

function renderBlockInline(block: Block): string {
  if (block.type === 'paragraph') return renderInlines(block.content) + '\\line ';
  if (block.type === 'heading') return `{\\b ${renderInlines(block.content)}}\\line `;
  return '';
}

function renderList(ordered: boolean, items: ListItem[], depth: number): string {
  const indent = 360 + depth * 360;
  return items
    .map((item, i) => {
      const bullet = ordered ? `${i + 1}. ` : '\\bullet  ';
      const checkbox =
        item.checked !== undefined
          ? item.checked ? '[x] ' : '[ ] '
          : '';
      let result = `\\pard\\li${indent}\\fi-360 ${bullet}${checkbox}${renderInlines(item.content)}\\par\n`;
      if (item.children) {
        result += renderList(item.children.ordered, item.children.items, depth + 1);
      }
      return result;
    })
    .join('');
}

function renderTable(headers: TableCell[], rows: TableCell[][]): string {
  const allRows: TableCell[][] = [];
  if (headers.length > 0) allRows.push(headers);
  allRows.push(...rows);

  if (allRows.length === 0) return '';

  const colCount = Math.max(...allRows.map((r) => r.length));
  const colWidth = Math.floor(9000 / colCount); // ~6.25 inches total

  let result = '';
  for (let r = 0; r < allRows.length; r++) {
    const row = allRows[r];
    const isHeader = r === 0 && headers.length > 0;

    // Row definition: cell boundaries
    result += '\\trowd';
    for (let c = 0; c < colCount; c++) {
      result += `\\cellx${(c + 1) * colWidth}`;
    }
    result += '\n';

    // Cell contents
    for (let c = 0; c < colCount; c++) {
      const cell = row[c];
      const content = cell ? renderInlines(cell.content) : '';
      if (isHeader) {
        result += `\\pard\\intbl {\\b ${content}}\\cell\n`;
      } else {
        result += `\\pard\\intbl ${content}\\cell\n`;
      }
    }
    result += '\\row\n';
  }

  return result;
}

function renderInlines(inlines: InlineContent[]): string {
  return inlines.map(renderInline).join('');
}

function renderInline(inline: InlineContent): string {
  switch (inline.type) {
    case 'text': {
      let text = escapeRtf(inline.text);
      if (!inline.marks || inline.marks.length === 0) return text;

      const open: string[] = [];
      const close: string[] = [];
      for (const mark of inline.marks) {
        switch (mark.type) {
          case 'bold': open.push('\\b '); close.push('\\b0 '); break;
          case 'italic': open.push('\\i '); close.push('\\i0 '); break;
          case 'underline': open.push('\\ul '); close.push('\\ulnone '); break;
          case 'strikethrough': open.push('\\strike '); close.push('\\strike0 '); break;
          case 'code':
            open.push('{\\f1 ');
            close.push('}');
            break;
          default:
            break;
        }
      }
      return `{${open.join('')}${text}${close.join('')}}`;
    }
    case 'link':
      return renderInlines(inline.content);
    case 'image':
      return `{\\i [${escapeRtf(inline.alt ?? 'image')}]}`;
    case 'code':
      return `{\\f1 ${escapeRtf(inline.text)}}`;
    case 'break':
      return '\\line ';
  }
}

function escapeRtf(text: string): string {
  let result = '';
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char === '\\') result += '\\\\';
    else if (char === '{') result += '\\{';
    else if (char === '}') result += '\\}';
    else if (char === '\n') result += '\\line ';
    else if (code > 127) result += `\\u${code}?`;
    else result += char;
  }
  return result;
}
