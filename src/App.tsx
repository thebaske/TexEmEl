import { useState, useCallback, useEffect } from 'react';
import type { DocumentTree } from './core/model/DocumentTree';
import { createEmptyDocument } from './core/model/DocumentTree';
import type { LayoutDirector } from './core/layout/LayoutDirector';
import { BspEditor } from './ui/components/BspEditor';
import { Toolbar } from './ui/components/Toolbar';
import { MenuBar } from './ui/components/MenuBar';
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
  const [engine, setEngine] = useState<LayoutDirector | null>(null);
  const [toolbarVersion, setToolbarVersion] = useState(0);

  const { openFile, openFilePath } = useFileOpen();
  const { exportHtml, exportMarkdown, exportText, exportRtf, saveHtmlWithLayout } = useExport();
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

  const handleNew = useCallback(() => {
    setDocument(createEmptyDocument());
    setFileName(null);
    setIsDirty(false);
  }, []);

  const handleDocumentChange = useCallback((updatedDoc: DocumentTree) => {
    setDocument(updatedDoc);
    setIsDirty(true);
  }, []);

  const handleOpenFile = useCallback(async () => {
    const tree = await openFile();
    if (tree) loadDocument(tree);
  }, [openFile, loadDocument]);

  const handleOpenRecent = useCallback(async (path: string) => {
    const tree = await openFilePath(path);
    if (tree) loadDocument(tree);
  }, [openFilePath, loadDocument]);

  const handleSave = useCallback(async () => {
    await saveHtmlWithLayout(document, engine);
  }, [saveHtmlWithLayout, document, engine]);

  const handleExportHtml = useCallback(async () => {
    await exportHtml(document);
  }, [exportHtml, document]);

  const handleExportMarkdown = useCallback(async () => {
    await exportMarkdown(document);
  }, [exportMarkdown, document]);

  const handleExportText = useCallback(async () => {
    await exportText(document);
  }, [exportText, document]);

  const handleExportRtf = useCallback(async () => {
    await exportRtf(document);
  }, [exportRtf, document]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  const handleEditorReady = useCallback((eng: LayoutDirector) => {
    setEngine(eng);
    eng.onToolbarUpdate(() => {
      setToolbarVersion(v => v + 1);
    });
  }, []);

  // Ctrl+S keyboard shortcut for save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  return (
    <div className="app">
      <div className="app-titlebar">
        <span className="app-title">TexSaur</span>
        <span className="app-filename">
          {fileName ?? 'Untitled'}{isDirty ? ' \u2022' : ''}
        </span>
      </div>
      <div className="app-toolbar">
        <MenuBar
          onNew={handleNew}
          onOpen={handleOpenFile}
          onSave={handleSave}
          onExportHtml={handleExportHtml}
          onExportMarkdown={handleExportMarkdown}
          onExportText={handleExportText}
          onExportRtf={handleExportRtf}
          onPrint={handlePrint}
          recentFiles={recentFiles}
          onOpenRecent={handleOpenRecent}
          onClearRecent={clearRecentFiles}
        />
        <span className="toolbar-divider" />
        <Toolbar engine={engine} version={toolbarVersion} />
      </div>
      <div className="app-editor">
        <BspEditor
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
