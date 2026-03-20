// ============================================================================
// LayoutTree — Binary Space Partition layout model
//
// The page is a recursive binary tree:
//   - SplitNode: has a direction (horizontal/vertical), a ratio, and 2 children
//   - LeafNode: contains actual content (blocks from DocumentTree)
//
// This file has ZERO DOM dependencies. Pure data + pure functions.
// ============================================================================

import type { Block } from '../model/DocumentTree';
import { generateBlockId } from '../engine/BlockId';

// --- Node Types ---

export type LayoutNode = SplitNode | LeafNode;

export interface SplitNode {
  type: 'split';
  id: string;
  /** 'horizontal' = top/bottom stacking, 'vertical' = left/right side-by-side */
  direction: SplitDirection;
  /** 0..1 — fraction of space given to the first child */
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export interface LeafNode {
  type: 'leaf';
  id: string;
  /** Content blocks inside this cell */
  blocks: Block[];
}

export type SplitDirection = 'horizontal' | 'vertical';

// --- Factory Helpers ---

export function createLeaf(blocks: Block[] = [], id?: string): LeafNode {
  return { type: 'leaf', id: id ?? generateBlockId(), blocks };
}

export function createSplit(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
  id?: string,
): SplitNode {
  return { type: 'split', id: id ?? generateBlockId(), direction, ratio, first, second };
}

/** Create a default single-cell layout */
export function createDefaultLayout(blocks: Block[] = []): LeafNode {
  return createLeaf(blocks);
}

// --- Tree Operations (pure functions — return new trees) ---

/**
 * Split a leaf cell into two.
 * The original leaf KEEPS its ID (first child) — this is critical for
 * the reconciler to reuse the existing DOM/ProseMirror instances.
 * Only the new sibling cell gets a fresh ID.
 *
 * Returns { newTree, newCellId } so callers know the new cell's ID.
 */
export function splitCell(
  root: LayoutNode,
  cellId: string,
  direction: SplitDirection,
  ratio = 0.5,
): { tree: LayoutNode; newCellId: string } {
  const newCellId = generateBlockId();
  const tree = mapNode(root, cellId, (leaf) => {
    if (leaf.type !== 'leaf') return leaf;
    return createSplit(
      direction,
      leaf,                            // ← KEEPS original ID + content
      createLeaf([], newCellId),       // ← only new cell gets new ID
      ratio,
    );
  });
  return { tree, newCellId };
}

/**
 * Split a leaf cell into two with specified content for each half.
 * Used for content-aware splitting (e.g., overflow splits a cell).
 * The first child KEEPS the original cell ID.
 */
export function splitCellWithContent(
  root: LayoutNode,
  cellId: string,
  direction: SplitDirection,
  ratio: number,
  firstBlocks: Block[],
  secondBlocks: Block[],
): { tree: LayoutNode; newCellId: string } {
  const newCellId = generateBlockId();
  const tree = mapNode(root, cellId, (leaf) => {
    if (leaf.type !== 'leaf') return leaf;
    return createSplit(
      direction,
      { ...leaf, blocks: firstBlocks },   // ← KEEPS original ID
      createLeaf(secondBlocks, newCellId), // ← new ID for second half
      ratio,
    );
  });
  return { tree, newCellId };
}

/**
 * Merge two sibling cells (children of a split) back into one leaf.
 * Content from both children is concatenated (first, then second).
 */
export function mergeCells(root: LayoutNode, splitId: string): LayoutNode {
  return mapNode(root, splitId, (node) => {
    if (node.type !== 'split') return node;
    const blocks = [...collectBlocks(node.first), ...collectBlocks(node.second)];
    return createLeaf(blocks);
  });
}

/**
 * Update the ratio of a split node.
 */
export function resizeSplit(
  root: LayoutNode,
  splitId: string,
  newRatio: number,
): LayoutNode {
  const clamped = Math.max(0.1, Math.min(0.9, newRatio));
  return mapNode(root, splitId, (node) => {
    if (node.type !== 'split') return node;
    return { ...node, ratio: clamped };
  });
}

/**
 * Move all content from one leaf to another, leaving the source empty.
 * Optionally auto-merge the source if it becomes empty.
 */
export function moveContent(
  root: LayoutNode,
  fromCellId: string,
  toCellId: string,
  autoMerge = false,
): LayoutNode {
  // Collect blocks from source
  const sourceBlocks = findNode(root, fromCellId);
  if (!sourceBlocks || sourceBlocks.type !== 'leaf') return root;
  const blocks = [...sourceBlocks.blocks];

  // Clear source
  let result = updateLeafBlocks(root, fromCellId, []);

  // Append to target
  const targetNode = findNode(result, toCellId);
  if (!targetNode || targetNode.type !== 'leaf') return root;
  result = updateLeafBlocks(result, toCellId, [...targetNode.blocks, ...blocks]);

  // Auto-merge empty cell with its sibling
  if (autoMerge) {
    result = autoMergeEmpty(result);
  }

  return result;
}

/**
 * Update the blocks inside a leaf cell.
 */
export function updateLeafBlocks(
  root: LayoutNode,
  cellId: string,
  blocks: Block[],
): LayoutNode {
  return mapNode(root, cellId, (node) => {
    if (node.type !== 'leaf') return node;
    return { ...node, blocks };
  });
}

/**
 * Insert a block into a specific cell.
 */
export function insertBlockInCell(
  root: LayoutNode,
  cellId: string,
  block: Block,
  index?: number,
): LayoutNode {
  return mapNode(root, cellId, (node) => {
    if (node.type !== 'leaf') return node;
    const newBlocks = [...node.blocks];
    if (index !== undefined && index >= 0 && index <= newBlocks.length) {
      newBlocks.splice(index, 0, block);
    } else {
      newBlocks.push(block);
    }
    return { ...node, blocks: newBlocks };
  });
}

/**
 * Remove a block from a cell by block ID.
 */
export function removeBlockFromCell(
  root: LayoutNode,
  cellId: string,
  blockId: string,
): LayoutNode {
  return mapNode(root, cellId, (node) => {
    if (node.type !== 'leaf') return node;
    return { ...node, blocks: node.blocks.filter(b => b.id !== blockId) };
  });
}

// --- Tree Traversal Utilities ---

/** Find a node by ID anywhere in the tree */
export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === 'split') {
    return findNode(root.first, id) ?? findNode(root.second, id);
  }
  return null;
}

/** Find the parent split of a node by child ID */
export function findParent(root: LayoutNode, childId: string): SplitNode | null {
  if (root.type !== 'split') return null;
  if (root.first.id === childId || root.second.id === childId) return root;
  return findParent(root.first, childId) ?? findParent(root.second, childId);
}

/** Get all leaf nodes in the tree */
export function getAllLeaves(root: LayoutNode): LeafNode[] {
  if (root.type === 'leaf') return [root];
  return [...getAllLeaves(root.first), ...getAllLeaves(root.second)];
}

/** Get all split nodes in the tree */
export function getAllSplits(root: LayoutNode): SplitNode[] {
  if (root.type === 'leaf') return [];
  return [root, ...getAllSplits(root.first), ...getAllSplits(root.second)];
}

/** Collect all blocks from all leaves under a node */
export function collectBlocks(node: LayoutNode): Block[] {
  if (node.type === 'leaf') return node.blocks;
  return [...collectBlocks(node.first), ...collectBlocks(node.second)];
}

/** Count total leaf cells */
export function countLeaves(root: LayoutNode): number {
  if (root.type === 'leaf') return 1;
  return countLeaves(root.first) + countLeaves(root.second);
}

// --- Internal Helpers ---

/**
 * Map over a tree, replacing the node with the given ID using the transform function.
 * Returns a new tree (immutable).
 */
function mapNode(
  root: LayoutNode,
  targetId: string,
  transform: (node: LayoutNode) => LayoutNode,
): LayoutNode {
  if (root.id === targetId) return transform(root);
  if (root.type === 'split') {
    const newFirst = mapNode(root.first, targetId, transform);
    const newSecond = mapNode(root.second, targetId, transform);
    if (newFirst === root.first && newSecond === root.second) return root;
    return { ...root, first: newFirst, second: newSecond };
  }
  return root;
}

/**
 * Auto-merge: if a split has an empty leaf child, replace the split with the other child.
 * Runs bottom-up to handle nested empty cells.
 */
function autoMergeEmpty(root: LayoutNode): LayoutNode {
  if (root.type === 'leaf') return root;

  // Process children first (bottom-up)
  const first = autoMergeEmpty(root.first);
  const second = autoMergeEmpty(root.second);

  // If first is empty leaf, collapse to second
  if (first.type === 'leaf' && first.blocks.length === 0) return second;
  // If second is empty leaf, collapse to first
  if (second.type === 'leaf' && second.blocks.length === 0) return first;

  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}
