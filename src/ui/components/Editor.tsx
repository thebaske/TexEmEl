// ============================================================================
// Editor.tsx — React wrapper for BlockEngine
//
// Mounts BlockEngine into a div ref. Passes DocumentTree in, receives
// changes via callback. No TipTap — BlockEngine owns the DOM.
// ============================================================================

import { useEffect, useRef } from 'react';
import type { DocumentTree } from '../../core/model/DocumentTree';
import { BlockEngine } from '../../core/engine/BlockEngine';
import { TextKernel } from '../../core/engine/TextKernel';
import type { BlockNode } from '../../core/engine/BlockNode';
import type { Block } from '../../core/model/DocumentTree';

interface EditorProps {
  document: DocumentTree;
  onDocumentChange: (doc: DocumentTree) => void;
  onEditorReady?: (engine: BlockEngine) => void;
}

export function Editor({ document, onDocumentChange, onEditorReady }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BlockEngine | null>(null);
  const readyFiredRef = useRef(false);
  const onChangeRef = useRef(onDocumentChange);
  onChangeRef.current = onDocumentChange;

  // Initialize engine once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const engine = new BlockEngine({ debounceMs: 150 });

    // Set up TextKernel factory — this is how ProseMirror gets mounted inside blocks
    engine.setKernelFactory((_node: BlockNode, contentEl: HTMLElement, block: Block) => {
      return new TextKernel(contentEl, [block]);
    });

    // Mount with initial document
    engine.mount(containerRef.current, document);

    // Listen for changes and forward to React
    engine.onChange((tree) => {
      onChangeRef.current(tree);
    });

    engineRef.current = engine;

    if (!readyFiredRef.current) {
      readyFiredRef.current = true;
      onEditorReady?.(engine);
    }

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Mount once only

  // Update engine when document changes externally (file open)
  useEffect(() => {
    if (!engineRef.current) return;
    engineRef.current.update(document);
  }, [document.metadata.sourceFileName, document.metadata.createdAt]);

  return (
    <div className="editor-container">
      <div ref={containerRef} className="editor-content" />
    </div>
  );
}
