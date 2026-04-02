// Layout module — BSP-based layout engine (V3 architecture)
export { LayoutDirector } from './LayoutDirector';
export type { OnLayoutChangeCallback, LayoutDirectorConfig } from './LayoutDirector';
export { CellPool } from './CellPool';
export { CellInstance } from './CellInstance';
export { TextKernel } from './TextKernel';
export { SplitResizeManager } from './SplitResizeManager';
export type { SplitResizeCallbacks } from './SplitResizeManager';
export { OverflowResolver } from './OverflowResolver';
export { OverflowDetector } from './OverflowDetector';
export { OverflowWatcher } from './OverflowWatcher';
export { NavigationController } from './NavigationController';
export type { ITextKernel, NavigationHandler } from './types';
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
