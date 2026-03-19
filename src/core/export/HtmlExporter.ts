import type {
  DocumentTree,
  Block,
  InlineContent,
  TextMark,
  ListItem,
  TableCell,
} from '../model/DocumentTree';

// ============================================================================
// HtmlExporter — Converts DocumentTree → self-contained HTML file
//
// Output: Single .html file with embedded base64 images and inline CSS.
// Opens correctly in: browsers, Word, Google Docs, LibreOffice.
// ============================================================================

export function exportToHtml(tree: DocumentTree): string {
  const title = escapeHtml(tree.metadata.title ?? 'Untitled');
  const bodyHtml = tree.blocks.map(renderBlock).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="generator" content="TexSaur">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      max-width: 8.5in;
      margin: 0 auto;
      padding: 0.75in 1in;
      line-height: 1.7;
      color: #1a1a1a;
      font-size: 11pt;
    }
    h1 { font-size: 24pt; margin: 0.8em 0 0.4em; color: #111; font-weight: 700; }
    h2 { font-size: 18pt; margin: 0.7em 0 0.35em; color: #222; font-weight: 600; }
    h3 { font-size: 14pt; margin: 0.6em 0 0.3em; color: #333; font-weight: 600; }
    h4 { font-size: 12pt; margin: 0.5em 0 0.25em; color: #333; font-weight: 600; }
    h5 { font-size: 11pt; margin: 0.5em 0 0.2em; color: #444; font-weight: 600; }
    h6 { font-size: 10pt; margin: 0.5em 0 0.2em; color: #555; font-weight: 600; }
    p { margin: 0.5em 0; }
    ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
    li { margin: 0.15em 0; }
    blockquote {
      border-left: 3px solid #ccc;
      padding-left: 1em;
      margin: 0.5em 0;
      color: #555;
    }
    pre {
      background: #f5f5f5;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 0.8em;
      margin: 0.5em 0;
      overflow-x: auto;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 9.5pt;
      line-height: 1.5;
    }
    code {
      background: #f0f0f0;
      padding: 0.15em 0.3em;
      border-radius: 3px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.9em;
    }
    pre code { background: none; padding: 0; border-radius: 0; }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.5em 0;
      font-size: 10pt;
    }
    th, td {
      border: 1px solid #ccc;
      padding: 0.4em 0.6em;
      text-align: left;
    }
    th { background: #f5f5f5; font-weight: 600; }
    img { max-width: 100%; height: auto; margin: 0.5em 0; }
    hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
    a { color: #2563eb; text-decoration: underline; }
    mark { background: #fef08a; padding: 0.1em 0.2em; }
    .task-item { list-style: none; margin-left: -1.2em; }
    .task-item input { margin-right: 0.4em; }
    @media print {
      body { margin: 0; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

function renderBlock(block: Block): string {
  switch (block.type) {
    case 'paragraph': {
      const align = block.alignment && block.alignment !== 'left'
        ? ` style="text-align:${block.alignment}"`
        : '';
      return `<p${align}>${renderInlines(block.content)}</p>`;
    }
    case 'heading': {
      const hAlign = block.alignment && block.alignment !== 'left'
        ? ` style="text-align:${block.alignment}"`
        : '';
      return `<h${block.level}${hAlign}>${renderInlines(block.content)}</h${block.level}>`;
    }
    case 'list':
      return renderList(block.ordered, block.items);
    case 'table':
      return renderTable(block.headers, block.rows);
    case 'image': {
      const alt = block.alt ? ` alt="${escapeHtml(block.alt)}"` : '';
      const title = block.title ? ` title="${escapeHtml(block.title)}"` : '';
      const dims = [
        block.width ? `width="${block.width}"` : '',
        block.height ? `height="${block.height}"` : '',
      ].filter(Boolean).join(' ');
      const styles: string[] = [];
      if (block.alignment === 'center') styles.push('display: block; margin-left: auto; margin-right: auto');
      if (block.alignment === 'float-left') styles.push('float: left; margin-right: 16px; margin-bottom: 8px');
      if (block.alignment === 'float-right') styles.push('float: right; margin-left: 16px; margin-bottom: 8px');
      const styleAttr = styles.length > 0 ? ` style="${styles.join('; ')}"` : '';
      return `<img src="${escapeHtml(block.src)}"${alt}${title}${dims ? ' ' + dims : ''}${styleAttr}>`;
    }
    case 'codeBlock': {
      const langClass = block.language ? ` class="language-${escapeHtml(block.language)}"` : '';
      return `<pre><code${langClass}>${escapeHtml(block.code)}</code></pre>`;
    }
    case 'blockquote':
      return `<blockquote>\n${block.blocks.map(renderBlock).join('\n')}\n</blockquote>`;
    case 'divider':
      return '<hr>';
    case 'container':
      return `<div>${block.children.map(renderBlock).join('\n')}</div>`;
  }
}

function renderList(ordered: boolean, items: ListItem[]): string {
  const tag = ordered ? 'ol' : 'ul';
  const lis = items.map((item) => {
    const isTask = item.checked !== undefined;
    const cls = isTask ? ' class="task-item"' : '';
    const checkbox = isTask
      ? `<input type="checkbox"${item.checked ? ' checked' : ''} disabled> `
      : '';
    const children = item.children
      ? '\n' + renderList(item.children.ordered, item.children.items)
      : '';
    return `<li${cls}>${checkbox}${renderInlines(item.content)}${children}</li>`;
  });
  return `<${tag}>\n${lis.join('\n')}\n</${tag}>`;
}

function renderTable(headers: TableCell[], rows: TableCell[][]): string {
  let html = '<table>\n';
  if (headers.length > 0) {
    html += '<thead><tr>';
    for (const cell of headers) {
      const attrs = cellAttrs(cell);
      html += `<th${attrs}>${renderInlines(cell.content)}</th>`;
    }
    html += '</tr></thead>\n';
  }
  if (rows.length > 0) {
    html += '<tbody>\n';
    for (const row of rows) {
      html += '<tr>';
      for (const cell of row) {
        const attrs = cellAttrs(cell);
        html += `<td${attrs}>${renderInlines(cell.content)}</td>`;
      }
      html += '</tr>\n';
    }
    html += '</tbody>\n';
  }
  html += '</table>';
  return html;
}

function cellAttrs(cell: TableCell): string {
  const parts: string[] = [];
  if (cell.colspan && cell.colspan > 1) parts.push(`colspan="${cell.colspan}"`);
  if (cell.rowspan && cell.rowspan > 1) parts.push(`rowspan="${cell.rowspan}"`);
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function renderInlines(inlines: InlineContent[]): string {
  return inlines.map(renderInline).join('');
}

function renderInline(inline: InlineContent): string {
  switch (inline.type) {
    case 'text': {
      let html = escapeHtml(inline.text);
      if (inline.marks) {
        for (const mark of inline.marks) {
          html = applyMark(html, mark);
        }
      }
      return html;
    }
    case 'link': {
      const title = inline.title ? ` title="${escapeHtml(inline.title)}"` : '';
      return `<a href="${escapeHtml(inline.href)}"${title}>${renderInlines(inline.content)}</a>`;
    }
    case 'image': {
      const alt = inline.alt ? ` alt="${escapeHtml(inline.alt)}"` : '';
      return `<img src="${escapeHtml(inline.src)}"${alt}>`;
    }
    case 'code':
      return `<code>${escapeHtml(inline.text)}</code>`;
    case 'break':
      return '<br>';
  }
}

function applyMark(html: string, mark: TextMark): string {
  switch (mark.type) {
    case 'bold': return `<strong>${html}</strong>`;
    case 'italic': return `<em>${html}</em>`;
    case 'underline': return `<u>${html}</u>`;
    case 'strikethrough': return `<s>${html}</s>`;
    case 'code': return `<code>${html}</code>`;
    case 'highlight': {
      const bg = mark.color ? ` style="background-color:${mark.color}"` : '';
      return `<mark${bg}>${html}</mark>`;
    }
    case 'color': return `<span style="color:${mark.color}">${html}</span>`;
    case 'fontFamily': return `<span style="font-family:${mark.family}">${html}</span>`;
    case 'fontSize': return `<span style="font-size:${mark.size}">${html}</span>`;
    case 'superscript': return `<sup>${html}</sup>`;
    case 'subscript': return `<sub>${html}</sub>`;
    case 'link': return `<a href="${escapeHtml(mark.href)}">${html}</a>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
