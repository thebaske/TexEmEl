import React, { useState, useCallback } from 'react';
import type { DocumentTree } from './core/model/DocumentTree';
import { createEmptyDocument } from './core/model/DocumentTree';

// TODO: Import and wire up these components once implemented
// import { Editor } from './ui/components/Editor';
// import { Toolbar } from './ui/components/Toolbar';
// import { TitleBar } from './ui/components/TitleBar';
// import { StatusBar } from './ui/components/StatusBar';

function App() {
  const [document, setDocument] = useState<DocumentTree>(createEmptyDocument());
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  const handleDocumentChange = useCallback((updatedDoc: DocumentTree) => {
    setDocument(updatedDoc);
    setIsDirty(true);
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
        {/* Toolbar will be mounted here */}
        <span style={{ padding: '8px', color: '#888' }}>Toolbar — coming soon</span>
      </div>
      <div className="app-editor">
        {/* Editor will be mounted here */}
        <div style={{ padding: '40px', color: '#aaa', textAlign: 'center' }}>
          <h2>TexSaur Editor</h2>
          <p>Open anything. Edit beautifully. Export clean HTML.</p>
          <p style={{ marginTop: '16px', fontSize: '14px' }}>
            Document: {document.metadata.title} | Blocks: {document.blocks.length}
          </p>
        </div>
      </div>
      <div className="app-statusbar">
        <span>{document.metadata.sourceFormat ?? 'new'}</span>
      </div>
    </div>
  );
}

export default App;
