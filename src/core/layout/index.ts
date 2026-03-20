// Layout module — BSP-based layout engine
export { LayoutEngine } from './LayoutEngine';
export type { OnLayoutChangeCallback, LayoutEngineConfig } from './LayoutEngine';
export { CellRenderer } from './CellRenderer';
export type { CellHandle, CellRendererCallbacks } from './CellRenderer';
export { SplitResizeManager } from './SplitResizeManager';
export type { SplitResizeCallbacks } from './SplitResizeManager';
export {
  type LayoutNode,
  type SplitNode,
  type LeafNode,
  type SplitDirection,
  createLeaf,
  createSplit,
  createDefaultLayout,
  splitCell,
  mergeCells,
  resizeSplit,
  moveContent,
  updateLeafBlocks,
  insertBlockInCell,
  removeBlockFromCell,
  findNode,
  findParent,
  getAllLeaves,
  getAllSplits,
  collectBlocks,
  countLeaves,
} from './LayoutTree';
