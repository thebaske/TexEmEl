import { useState, useCallback } from 'react';
import type { Editor as TipTapEditor } from '@tiptap/react';
import type { DocumentTree } from './core/model/DocumentTree';
import { createEmptyDocument } from './core/model/DocumentTree';
import { Editor } from './ui/components/Editor';
import { Toolbar } from './ui/components/Toolbar';
import { useFileOpen } from './ui/hooks/useFileOpen';
import { useExport } from './ui/hooks/useExport';
import { useFileDrop } from './ui/hooks/useFileDrop';
import { useRecentFiles } from './ui/hooks/useRecentFiles';

// Register all codecs on startup
import './core/codecs/setup';

function App() {
  const [document, setDocument] = useState<DocumentTree>(createEmptyDocument());
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [editor, setEditor] = useState<TipTapEditor | null>(null);
  const [showRecent, setShowRecent] = useState(false);

  const { openFile, openFilePath } = useFileOpen();
  const { exportHtml, exportMarkdown } = useExport();
  const { recentFiles, addRecentFile, clearRecentFiles } = useRecentFiles();

  const loadDocument = useCallback((tree: DocumentTree) => {
    setDocument(tree);
    setFileName(tree.metadata.sourceFileName ?? null);
    setIsDirty(false);
    if (tree.metadata.sourceFileName) {
      addRecentFile(tree.metadata.sourceFileName, tree.metadata.sourceFileName);
    }
  }, [addRecentFile]);

  // Handle file-open on launch (Tauri file associations)
  useFileDrop(loadDocument);

  const handleDocumentChange = useCallback((updatedDoc: DocumentTree) => {
    setDocument(updatedDoc);
    setIsDirty(true);
  }, []);

  const handleOpenFile = useCallback(async () => {
    const tree = await openFile();
    if (tree) loadDocument(tree);
  }, [openFile, loadDocument]);

  const handleOpenRecent = useCallback(async (path: string) => {
    setShowRecent(false);
    const tree = await openFilePath(path);
    if (tree) loadDocument(tree);
  }, [openFilePath, loadDocument]);

  const handleExportHtml = useCallback(async () => {
    await exportHtml(document);
  }, [exportHtml, document]);

  const handleExportMarkdown = useCallback(async () => {
    await exportMarkdown(document);
  }, [exportMarkdown, document]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const handleEditorReady = useCallback((ed: TipTapEditor) => {
    setEditor(ed);
  }, []);

  return (
    <div className="app">
      <div className="app-titlebar">
        <span className="app-title">TexSaur</span>
        <span className="app-filename">
          {fileName ?? 'Untitled'}{isDirty ? ' •' : ''}
        </span>
      </div>
      <div className="app-toolbar">
        <Toolbar
          editor={editor}
          onOpenFile={handleOpenFile}
          onExportHtml={handleExportHtml}
          onExportMarkdown={handleExportMarkdown}
          onPrint={handlePrint}
          recentFiles={recentFiles}
          showRecent={showRecent}
          onToggleRecent={() => setShowRecent((v) => !v)}
          onOpenRecent={handleOpenRecent}
          onClearRecent={clearRecentFiles}
        />
      </div>
      <div className="app-editor">
        <Editor
          document={document}
          onDocumentChange={handleDocumentChange}
          onEditorReady={handleEditorReady}
        />
      </div>
      <div className="app-statusbar">
        <span>{document.metadata.sourceFormat ?? 'new'}</span>
        <span style={{ marginLeft: 'auto' }}>
          {document.blocks.length} block{document.blocks.length !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

export default App;
