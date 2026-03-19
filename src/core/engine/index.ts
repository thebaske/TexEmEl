// Public API for the BlockEngine
export { BlockEngine } from './BlockEngine';
export { BlockNode } from './BlockNode';
export { BlockRegistry } from './BlockRegistry';
export { BlockRenderer } from './BlockRenderer';
export { EventRouter } from './EventRouter';
export { SelectionManager } from './SelectionManager';
export { CommandHistory } from './CommandHistory';
export { DragManager } from './DragManager';
export { ResizeManager } from './ResizeManager';
export { EdgeDragManager } from './EdgeDragManager';
export { generateBlockId, assignBlockIds } from './BlockId';
export {
  BlockStatus,
  EngineEvent,
  DEFAULT_ENGINE_CONFIG,
  type EngineConfig,
  type EngineCommand,
  type ITextKernel,
  type OnChangeCallback,
  type OnSelectionCallback,
} from './types';
