// ============================================================================
// BlockId — Stable unique identity for every block in the editor
//
// IDs are assigned on first load (codecs don't produce them) and persist
// through all edits. They enable efficient diffing, undo/redo targeting,
// and DOM→model resolution.
// ============================================================================

import type { Block, ListItem } from '../model/DocumentTree';

export function generateBlockId(): string {
  return crypto.randomUUID();
}

/**
 * Walk a block tree and assign IDs to any block/item that lacks one.
 * Existing IDs are preserved — this is safe to call multiple times.
 */
export function assignBlockIds(blocks: Block[]): Block[] {
  return blocks.map(assignBlockId);
}

function assignBlockId(block: Block): Block {
  const id = block.id ?? generateBlockId();

  switch (block.type) {
    case 'blockquote':
      return { ...block, id, blocks: block.blocks.map(assignBlockId) };

    case 'container':
      return { ...block, id, children: block.children.map(assignBlockId) };

    case 'list':
      return { ...block, id, items: block.items.map(assignListItemId) };

    default:
      return { ...block, id };
  }
}

function assignListItemId(item: ListItem): ListItem {
  const id = item.id ?? generateBlockId();
  const children = item.children
    ? { ...item.children, id: item.children.id ?? generateBlockId(), items: item.children.items.map(assignListItemId) }
    : undefined;
  return { ...item, id, children };
}
