import type { FormatCodec } from './CodecRegistry';
import type { DocumentTree, Block, InlineContent, TextMark, ListItem } from '../model/DocumentTree';

// Markdown codec — parses Markdown into DocumentTree
// Uses a simple recursive descent parser (no external dependencies)
// Supports: headings, paragraphs, bold, italic, code, links, images,
//           ordered/unordered lists, task lists, blockquotes, code blocks, dividers

export const markdownCodec: FormatCodec = {
  id: 'markdown',
  name: 'Markdown',
  extensions: ['md', 'markdown', 'mdown', 'mkd'],
  mimeTypes: ['text/markdown', 'text/x-markdown'],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    const text = new TextDecoder('utf-8').decode(buffer);
    const blocks = parseMarkdownBlocks(text);

    // Extract title from first heading if present
    let title = fileName?.replace(/\.[^.]+$/, '') ?? 'Untitled';
    const firstHeading = blocks.find((b) => b.type === 'heading');
    if (firstHeading && firstHeading.type === 'heading') {
      const textContent = firstHeading.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('');
      if (textContent) title = textContent;
    }

    return {
      blocks,
      metadata: {
        title,
        sourceFormat: 'markdown',
        sourceFileName: fileName,
        modifiedAt: new Date().toISOString(),
      },
    };
  },
};

// --- Block-level parsing ---

function parseMarkdownBlocks(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Divider: ---, ***, ___
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'divider' });
      i++;
      continue;
    }

    // Heading: # ... ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        content: parseInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Fenced code block: ```
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'codeBlock', language, code: codeLines.join('\n') });
      i++; // skip closing ```
      continue;
    }

    // Blockquote: >
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith('>') || (lines[i].trim() !== '' && quoteLines.length > 0))) {
        if (lines[i].startsWith('>')) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
        } else {
          break;
        }
        i++;
      }
      blocks.push({
        type: 'blockquote',
        blocks: parseMarkdownBlocks(quoteLines.join('\n')),
      });
      continue;
    }

    // List: - item, * item, + item, 1. item, - [ ] item
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s/);
    if (listMatch) {
      const ordered = /^\d+\./.test(listMatch[2]);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+]|\d+\.)\s(.*)$/);
        if (!itemMatch) break;

        const itemText = itemMatch[3];
        const taskMatch = itemText.match(/^\[([ xX])\]\s?(.*)/);
        if (taskMatch) {
          items.push({
            content: parseInline(taskMatch[2]),
            checked: taskMatch[1] !== ' ',
          });
        } else {
          items.push({ content: parseInline(itemText) });
        }
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Image block (standalone): ![alt](src)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgMatch) {
      blocks.push({
        type: 'image',
        alt: imgMatch[1] || undefined,
        src: imgMatch[2],
      });
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(#{1,6}\s|```|>\s|(\s*)([-*+]|\d+\.)\s|(\*{3,}|-{3,}|_{3,})\s*$)/)) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        content: parseInline(paraLines.join(' ')),
      });
    }
  }

  return blocks;
}

// --- Inline-level parsing ---

function parseInline(text: string): InlineContent[] {
  const result: InlineContent[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    let match = remaining.match(/^\*\*(.+?)\*\*/);
    if (!match) match = remaining.match(/^__(.+?)__/);
    if (match) {
      result.push({ type: 'text', text: match[1], marks: [{ type: 'bold' }] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic: *text* or _text_
    match = remaining.match(/^\*(.+?)\*/);
    if (!match) match = remaining.match(/^_(.+?)_/);
    if (match) {
      result.push({ type: 'text', text: match[1], marks: [{ type: 'italic' }] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Strikethrough: ~~text~~
    match = remaining.match(/^~~(.+?)~~/);
    if (match) {
      result.push({ type: 'text', text: match[1], marks: [{ type: 'strikethrough' }] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code: `text`
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      result.push({ type: 'code', text: match[1] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Link: [text](url)
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      result.push({
        type: 'link',
        href: match[2],
        content: [{ type: 'text', text: match[1] }],
      });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline image: ![alt](src)
    match = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (match) {
      result.push({ type: 'image', alt: match[1] || undefined, src: match[2] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Line break: two trailing spaces or \
    match = remaining.match(/^(\\|\s{2,})\n/);
    if (match) {
      result.push({ type: 'break' });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Plain text: consume until next special character
    match = remaining.match(/^[^*_`~\[!\\\n]+/);
    if (match) {
      result.push({ type: 'text', text: match[0] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Single special char that didn't match a pattern — consume it
    result.push({ type: 'text', text: remaining[0] });
    remaining = remaining.slice(1);
  }

  return result;
}
