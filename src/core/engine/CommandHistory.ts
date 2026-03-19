// ============================================================================
// CommandHistory — Undo/redo stack for block-level operations
//
// Tracks structural changes (reorder, delete, insert, resize, layout).
// Text-level undo is handled by ProseMirror's built-in history.
// ============================================================================

import type { EngineCommand } from './types';

export class CommandHistory {
  private undoStack: EngineCommand[] = [];
  private redoStack: EngineCommand[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  /** Execute a command and push it onto the undo stack */
  execute(command: EngineCommand): void {
    command.execute();
    this.undoStack.push(command);
    // New action invalidates redo history
    this.redoStack = [];
    // Cap stack size
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
  }

  /** Undo the most recent command */
  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    return true;
  }

  /** Redo the most recently undone command */
  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.execute();
    this.undoStack.push(cmd);
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
