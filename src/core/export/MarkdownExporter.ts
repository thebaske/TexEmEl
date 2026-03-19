import type {
  DocumentTree,
  Block,
  InlineContent,
  ListItem,
  TableCell,
} from '../model/DocumentTree';

// ============================================================================
// MarkdownExporter — Converts DocumentTree → GFM Markdown string
// ============================================================================

export function exportToMarkdown(tree: DocumentTree): string {
  return tree.blocks.map(renderBlock).join('\n\n');
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case 'paragraph':
      return renderInlines(block.content);
    case 'heading':
      return '#'.repeat(block.level) + ' ' + renderInlines(block.content);
    case 'list':
      return renderList(block.ordered, block.items, 0);
    case 'table':
      return renderTable(block.headers, block.rows);
    case 'image': {
      const alt = block.alt ?? '';
      return `![${alt}](${block.src})`;
    }
    case 'codeBlock': {
      const lang = block.language ?? '';
      return '```' + lang + '\n' + block.code + '\n```';
    }
    case 'blockquote':
      return block.blocks
        .map(renderBlock)
        .join('\n\n')
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n');
    case 'divider':
      return '---';
    case 'container':
      return block.children.map(renderBlock).join('\n\n');
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
  if (headers.length === 0 && rows.length === 0) return '';

  const headerCells = headers.map((c) => renderInlines(c.content));
  const separator = headers.map(() => '---');
  const bodyRows = rows.map((row) => row.map((c) => renderInlines(c.content)));

  const lines: string[] = [];
  if (headerCells.length > 0) {
    lines.push('| ' + headerCells.join(' | ') + ' |');
    lines.push('| ' + separator.join(' | ') + ' |');
  }
  for (const row of bodyRows) {
    lines.push('| ' + row.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function renderInlines(inlines: InlineContent[]): string {
  return inlines.map(renderInline).join('');
}

function renderInline(inline: InlineContent): string {
  switch (inline.type) {
    case 'text': {
      let text = inline.text;
      if (inline.marks) {
        for (const mark of inline.marks) {
          switch (mark.type) {
            case 'bold': text = `**${text}**`; break;
            case 'italic': text = `*${text}*`; break;
            case 'strikethrough': text = `~~${text}~~`; break;
            case 'code': text = `\`${text}\``; break;
            // underline, highlight, color, super/subscript have no MD equivalent
            default: break;
          }
        }
      }
      return text;
    }
    case 'link':
      return `[${renderInlines(inline.content)}](${inline.href})`;
    case 'image':
      return `![${inline.alt ?? ''}](${inline.src})`;
    case 'code':
      return `\`${inline.text}\``;
    case 'break':
      return '  \n';
  }
}
