import type {
  DocumentTree,
  Block,
  InlineContent,
  TextMark,
  ListItem,
  TableCell,
} from '../model/DocumentTree';

// ============================================================================
// EditorBridge — Converts DocumentTree ↔ TipTap JSONContent
//
// TipTap uses ProseMirror's JSON format internally.
// These two functions bridge our canonical model and TipTap's model.
// ============================================================================

// TipTap JSON types (simplified — TipTap accepts this shape)
interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

// --- DocumentTree → TipTap JSON ---

export function documentTreeToTipTap(tree: DocumentTree): TipTapNode {
  return {
    type: 'doc',
    content: tree.blocks.map(blockToTipTap),
  };
}

function blockToTipTap(block: Block): TipTapNode {
  switch (block.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        attrs: block.alignment ? { textAlign: block.alignment } : undefined,
        content: inlinesToTipTap(block.content),
      };
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: block.level },
        content: inlinesToTipTap(block.content),
      };
    case 'list':
      return listToTipTap(block.ordered, block.items);
    case 'table':
      return tableToTipTap(block.headers, block.rows);
    case 'image':
      return {
        type: 'image',
        attrs: {
          src: block.src,
          alt: block.alt ?? null,
          title: block.title ?? null,
        },
      };
    case 'codeBlock':
      return {
        type: 'codeBlock',
        attrs: { language: block.language ?? null },
        content: [{ type: 'text', text: block.code }],
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        content: block.blocks.map(blockToTipTap),
      };
    case 'divider':
      return { type: 'horizontalRule' };
  }
}

function listToTipTap(ordered: boolean, items: ListItem[]): TipTapNode {
  const isTaskList = items.some((item) => item.checked !== undefined);
  const listType = isTaskList ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
  const itemType = isTaskList ? 'taskItem' : 'listItem';

  return {
    type: listType,
    content: items.map((item) => {
      const node: TipTapNode = {
        type: itemType,
        attrs: isTaskList ? { checked: item.checked ?? false } : undefined,
        content: [
          {
            type: 'paragraph',
            content: inlinesToTipTap(item.content),
          },
        ],
      };
      if (item.children) {
        node.content!.push(listToTipTap(item.children.ordered, item.children.items));
      }
      return node;
    }),
  };
}

function tableToTipTap(headers: TableCell[], rows: TableCell[][]): TipTapNode {
  const allRows: TipTapNode[] = [];

  if (headers.length > 0) {
    allRows.push({
      type: 'tableRow',
      content: headers.map((cell) => ({
        type: 'tableHeader',
        attrs: {
          colspan: cell.colspan ?? 1,
          rowspan: cell.rowspan ?? 1,
        },
        content: [{ type: 'paragraph', content: inlinesToTipTap(cell.content) }],
      })),
    });
  }

  for (const row of rows) {
    allRows.push({
      type: 'tableRow',
      content: row.map((cell) => ({
        type: 'tableCell',
        attrs: {
          colspan: cell.colspan ?? 1,
          rowspan: cell.rowspan ?? 1,
        },
        content: [{ type: 'paragraph', content: inlinesToTipTap(cell.content) }],
      })),
    });
  }

  return { type: 'table', content: allRows };
}

function inlinesToTipTap(inlines: InlineContent[]): TipTapNode[] {
  const result: TipTapNode[] = [];

  for (const inline of inlines) {
    switch (inline.type) {
      case 'text': {
        const marks = inline.marks?.map(markToTipTap).filter(Boolean) as TipTapNode['marks'];
        result.push({
          type: 'text',
          text: inline.text,
          marks: marks && marks.length > 0 ? marks : undefined,
        });
        break;
      }
      case 'link': {
        const children = inlinesToTipTap(inline.content);
        for (const child of children) {
          child.marks = [
            ...(child.marks ?? []),
            { type: 'link', attrs: { href: inline.href, target: '_blank' } },
          ];
        }
        result.push(...children);
        break;
      }
      case 'image':
        result.push({
          type: 'image',
          attrs: { src: inline.src, alt: inline.alt ?? null },
        });
        break;
      case 'code':
        result.push({
          type: 'text',
          text: inline.text,
          marks: [{ type: 'code' }],
        });
        break;
      case 'break':
        result.push({ type: 'hardBreak' });
        break;
    }
  }

  return result;
}

function markToTipTap(mark: TextMark): { type: string; attrs?: Record<string, unknown> } | null {
  switch (mark.type) {
    case 'bold': return { type: 'bold' };
    case 'italic': return { type: 'italic' };
    case 'underline': return { type: 'underline' };
    case 'strikethrough': return { type: 'strike' };
    case 'code': return { type: 'code' };
    case 'highlight': return { type: 'highlight', attrs: mark.color ? { color: mark.color } : undefined };
    case 'color': return { type: 'textStyle', attrs: { color: mark.color } };
    case 'superscript': return { type: 'superscript' };
    case 'subscript': return { type: 'subscript' };
  }
}

// --- TipTap JSON → DocumentTree ---

export function tipTapToDocumentTree(json: TipTapNode, metadata?: DocumentTree['metadata']): DocumentTree {
  const blocks: Block[] = [];

  for (const node of json.content ?? []) {
    const block = tipTapNodeToBlock(node);
    if (block) blocks.push(block);
  }

  return {
    blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }],
    metadata: metadata ?? {
      title: 'Untitled',
      modifiedAt: new Date().toISOString(),
    },
  };
}

function tipTapNodeToBlock(node: TipTapNode): Block | null {
  switch (node.type) {
    case 'paragraph':
      return {
        type: 'paragraph',
        content: tipTapToInlines(node.content ?? []),
        alignment: node.attrs?.textAlign as Block extends { alignment?: infer A } ? A : undefined,
      };
    case 'heading':
      return {
        type: 'heading',
        level: (node.attrs?.level ?? 1) as 1 | 2 | 3 | 4 | 5 | 6,
        content: tipTapToInlines(node.content ?? []),
      };
    case 'bulletList':
    case 'orderedList':
      return {
        type: 'list',
        ordered: node.type === 'orderedList',
        items: (node.content ?? []).map(tipTapListItemToListItem),
      };
    case 'taskList':
      return {
        type: 'list',
        ordered: false,
        items: (node.content ?? []).map(tipTapTaskItemToListItem),
      };
    case 'table':
      return tipTapTableToBlock(node);
    case 'image':
      return {
        type: 'image',
        src: (node.attrs?.src as string) ?? '',
        alt: (node.attrs?.alt as string) ?? undefined,
        title: (node.attrs?.title as string) ?? undefined,
      };
    case 'codeBlock':
      return {
        type: 'codeBlock',
        language: (node.attrs?.language as string) ?? undefined,
        code: node.content?.map((n) => n.text ?? '').join('') ?? '',
      };
    case 'blockquote':
      return {
        type: 'blockquote',
        blocks: (node.content ?? []).map(tipTapNodeToBlock).filter(Boolean) as Block[],
      };
    case 'horizontalRule':
      return { type: 'divider' };
    default:
      return null;
  }
}

function tipTapListItemToListItem(node: TipTapNode): ListItem {
  const paragraphs = (node.content ?? []).filter((n) => n.type === 'paragraph');
  const nestedList = (node.content ?? []).find(
    (n) => n.type === 'bulletList' || n.type === 'orderedList',
  );

  const content = paragraphs.length > 0
    ? tipTapToInlines(paragraphs[0].content ?? [])
    : [];

  const item: ListItem = { content };
  if (nestedList) {
    const block = tipTapNodeToBlock(nestedList);
    if (block && block.type === 'list') {
      item.children = block;
    }
  }
  return item;
}

function tipTapTaskItemToListItem(node: TipTapNode): ListItem {
  const item = tipTapListItemToListItem(node);
  item.checked = (node.attrs?.checked as boolean) ?? false;
  return item;
}

function tipTapTableToBlock(node: TipTapNode): Block {
  const headers: TableCell[] = [];
  const rows: TableCell[][] = [];

  for (const rowNode of node.content ?? []) {
    const cells: TableCell[] = [];
    let isHeader = false;

    for (const cellNode of rowNode.content ?? []) {
      if (cellNode.type === 'tableHeader') isHeader = true;
      const paras = (cellNode.content ?? []).filter((n) => n.type === 'paragraph');
      cells.push({
        content: paras.length > 0 ? tipTapToInlines(paras[0].content ?? []) : [],
        colspan: (cellNode.attrs?.colspan as number) ?? undefined,
        rowspan: (cellNode.attrs?.rowspan as number) ?? undefined,
      });
    }

    if (isHeader && headers.length === 0) {
      headers.push(...cells);
    } else {
      rows.push(cells);
    }
  }

  return { type: 'table', headers, rows };
}

function tipTapToInlines(nodes: TipTapNode[]): InlineContent[] {
  const result: InlineContent[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const linkMark = node.marks?.find((m) => m.type === 'link');
        if (linkMark) {
          result.push({
            type: 'link',
            href: (linkMark.attrs?.href as string) ?? '',
            content: [{
              type: 'text',
              text: node.text ?? '',
              marks: tipTapMarksToMarks(node.marks?.filter((m) => m.type !== 'link') ?? []),
            }],
          });
        } else {
          result.push({
            type: 'text',
            text: node.text ?? '',
            marks: tipTapMarksToMarks(node.marks ?? []),
          });
        }
        break;
      }
      case 'image':
        result.push({
          type: 'image',
          src: (node.attrs?.src as string) ?? '',
          alt: (node.attrs?.alt as string) ?? undefined,
        });
        break;
      case 'hardBreak':
        result.push({ type: 'break' });
        break;
    }
  }

  return result;
}

function tipTapMarksToMarks(
  marks: Array<{ type: string; attrs?: Record<string, unknown> }>,
): TextMark[] | undefined {
  if (marks.length === 0) return undefined;

  const result: TextMark[] = [];
  for (const mark of marks) {
    switch (mark.type) {
      case 'bold': result.push({ type: 'bold' }); break;
      case 'italic': result.push({ type: 'italic' }); break;
      case 'underline': result.push({ type: 'underline' }); break;
      case 'strike': result.push({ type: 'strikethrough' }); break;
      case 'code': result.push({ type: 'code' }); break;
      case 'highlight': result.push({ type: 'highlight', color: mark.attrs?.color as string }); break;
      case 'textStyle': {
        if (mark.attrs?.color) result.push({ type: 'color', color: mark.attrs.color as string });
        break;
      }
      case 'superscript': result.push({ type: 'superscript' }); break;
      case 'subscript': result.push({ type: 'subscript' }); break;
    }
  }

  return result.length > 0 ? result : undefined;
}
