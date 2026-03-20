// ============================================================================
// BspEditor.tsx — React wrapper for LayoutEngine (BSP layout)
//
// Replaces Editor.tsx for the BSP-based editing experience.
// Mounts LayoutEngine into a div ref, passes DocumentTree in, receives
// changes via callback.
// ============================================================================

import { useEffect, useRef } from 'react';
import type { DocumentTree } from '../../core/model/DocumentTree';
import { LayoutEngine } from '../../core/layout/LayoutEngine';
import { TextKernel } from '../../core/engine/TextKernel';
import type { BlockNode } from '../../core/engine/BlockNode';
import type { Block } from '../../core/model/DocumentTree';

// Import BSP styles
import '../../core/layout/css/bsp.css';

interface BspEditorProps {
  document: DocumentTree;
  onDocumentChange: (doc: DocumentTree) => void;
  onEditorReady?: (engine: LayoutEngine) => void;
}

export function BspEditor({ document, onDocumentChange, onEditorReady }: BspEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<LayoutEngine | null>(null);
  const readyFiredRef = useRef(false);
  const onChangeRef = useRef(onDocumentChange);
  onChangeRef.current = onDocumentChange;

  // Initialize engine once on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const engine = new LayoutEngine({ debounceMs: 150 });

    // Set up TextKernel factory
    engine.setKernelFactory((_node: BlockNode, contentEl: HTMLElement, block: Block) => {
      return new TextKernel(contentEl, block);
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
      <div ref={containerRef} className="bsp-editor-content" />
    </div>
  );
}
