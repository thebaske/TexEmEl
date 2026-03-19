import { useState, useEffect, useRef, useCallback } from 'react';
import type { RecentFile } from '../hooks/useRecentFiles';

interface MenuBarProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExportHtml: () => void;
  onExportMarkdown: () => void;
  onExportText: () => void;
  onExportRtf: () => void;
  onPrint: () => void;
  recentFiles: RecentFile[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
}

export function MenuBar({
  onNew,
  onOpen,
  onSave,
  onExportHtml,
  onExportMarkdown,
  onExportText,
  onExportRtf,
  onPrint,
  recentFiles,
  onOpenRecent,
  onClearRecent,
}: MenuBarProps) {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!activeMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [activeMenu]);

  const toggle = useCallback((menu: string) => {
    setActiveMenu((prev) => (prev === menu ? null : menu));
  }, []);

  const closeAndRun = useCallback((fn: () => void) => {
    setActiveMenu(null);
    fn();
  }, []);

  return (
    <div className="menubar" ref={menuRef}>
      {/* New */}
      <button className="menubar-btn" title="New document" onClick={() => closeAndRun(onNew)}>
        New
      </button>

      {/* Open */}
      <div className="toolbar-dropdown-wrapper">
        <button
          className="menubar-btn"
          onClick={() => toggle('open')}
        >
          Open <span className="menubar-caret">&#9662;</span>
        </button>
        {activeMenu === 'open' && (
          <div className="toolbar-dropdown">
            <button
              className="toolbar-dropdown-item"
              onClick={() => closeAndRun(onOpen)}
            >
              Open file...
            </button>
            {recentFiles.length > 0 && (
              <>
                <div className="toolbar-dropdown-divider" />
                {recentFiles.map((f) => (
                  <button
                    key={f.path}
                    className="toolbar-dropdown-item"
                    onClick={() => closeAndRun(() => onOpenRecent(f.path))}
                    title={f.path}
                  >
                    {f.name}
                  </button>
                ))}
                <div className="toolbar-dropdown-divider" />
                <button
                  className="toolbar-dropdown-item"
                  onClick={() => closeAndRun(onClearRecent)}
                >
                  Clear recent
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Save */}
      <button className="menubar-btn" title="Save as HTML" onClick={() => closeAndRun(onSave)}>
        Save
      </button>

      {/* Export */}
      <div className="toolbar-dropdown-wrapper">
        <button
          className="menubar-btn"
          onClick={() => toggle('export')}
        >
          Export <span className="menubar-caret">&#9662;</span>
        </button>
        {activeMenu === 'export' && (
          <div className="toolbar-dropdown">
            <button
              className="toolbar-dropdown-item"
              onClick={() => closeAndRun(onExportHtml)}
            >
              HTML (.html)
            </button>
            <button
              className="toolbar-dropdown-item"
              onClick={() => closeAndRun(onExportMarkdown)}
            >
              Markdown (.md)
            </button>
            <button
              className="toolbar-dropdown-item"
              onClick={() => closeAndRun(onExportRtf)}
            >
              Rich Text (.rtf)
            </button>
            <button
              className="toolbar-dropdown-item"
              onClick={() => closeAndRun(onExportText)}
            >
              Plain Text (.txt)
            </button>
            <div className="toolbar-dropdown-divider" />
            <button
              className="toolbar-dropdown-item"
              onClick={() => closeAndRun(onPrint)}
            >
              Print
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
