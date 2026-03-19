import type {
  DocumentTree,
  Block,
  InlineContent,
  ListItem,
  TableCell,
} from '../model/DocumentTree';

// ============================================================================
// TxtExporter — Converts DocumentTree → plain text string
// ============================================================================

export function exportToText(tree: DocumentTree): string {
  return tree.blocks.map(renderBlock).join('\n\n');
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case 'paragraph':
      return renderInlines(block.content);
    case 'heading':
      return renderInlines(block.content);
    case 'list':
      return renderList(block.ordered, block.items, 0);
    case 'table':
      return renderTable(block.headers, block.rows);
    case 'image':
      return block.alt ? `[Image: ${block.alt}]` : '[Image]';
    case 'codeBlock':
      return block.code;
    case 'blockquote':
      return block.blocks.map(renderBlock).join('\n');
    case 'divider':
      return '---';
    case 'container':
      return block.children.map(renderBlock).join('\n');
  }
}

function renderList(ordered: boolean, items: ListItem[], depth: number): string {
  const indent = '  '.repeat(depth);
  return items
    .map((item, i) => {
      const bullet = ordered ? `${i + 1}.` : '-';
      const checkbox =
        item.checked !== undefined ? (item.checked ? '[x] ' : '[ ] ') : '';
      const line = `${indent}${bullet} ${checkbox}${renderInlines(item.content)}`;
      const children = item.children
        ? '\n' + renderList(item.children.ordered, item.children.items, depth + 1)
        : '';
      return line + children;
    })
    .join('\n');
}

function renderTable(headers: TableCell[], rows: TableCell[][]): string {
  const allRows: string[][] = [];
  if (headers.length > 0) {
    allRows.push(headers.map((c) => renderInlines(c.content)));
  }
  for (const row of rows) {
    allRows.push(row.map((c) => renderInlines(c.content)));
  }
  return allRows.map((row) => row.join('\t')).join('\n');
}

function renderInlines(inlines: InlineContent[]): string {
  return inlines.map(renderInline).join('');
}

function renderInline(inline: InlineContent): string {
  switch (inline.type) {
    case 'text':
      return inline.text;
    case 'link':
      return renderInlines(inline.content);
    case 'image':
      return inline.alt ? `[Image: ${inline.alt}]` : '[Image]';
    case 'code':
      return inline.text;
    case 'break':
      return '\n';
  }
}
