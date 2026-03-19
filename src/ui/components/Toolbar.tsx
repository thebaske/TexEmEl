import type { Editor } from '@tiptap/react';
import type { RecentFile } from '../hooks/useRecentFiles';

interface ToolbarProps {
  editor: Editor | null;
  onOpenFile?: () => void;
  onExportHtml?: () => void;
  onExportMarkdown?: () => void;
  onPrint?: () => void;
  recentFiles?: RecentFile[];
  showRecent?: boolean;
  onToggleRecent?: () => void;
  onOpenRecent?: (path: string) => void;
  onClearRecent?: () => void;
}

interface ToolbarButton {
  label: string;
  title: string;
  action: (editor: Editor) => void;
  isActive?: (editor: Editor) => boolean;
}

const DIVIDER = 'divider';

type ToolbarItem = ToolbarButton | typeof DIVIDER;

const toolbarItems: ToolbarItem[] = [
  {
    label: 'B',
    title: 'Bold (Ctrl+B)',
    action: (e) => e.chain().focus().toggleBold().run(),
    isActive: (e) => e.isActive('bold'),
  },
  {
    label: 'I',
    title: 'Italic (Ctrl+I)',
    action: (e) => e.chain().focus().toggleItalic().run(),
    isActive: (e) => e.isActive('italic'),
  },
  {
    label: 'U',
    title: 'Underline (Ctrl+U)',
    action: (e) => e.chain().focus().toggleUnderline().run(),
    isActive: (e) => e.isActive('underline'),
  },
  {
    label: 'S',
    title: 'Strikethrough',
    action: (e) => e.chain().focus().toggleStrike().run(),
    isActive: (e) => e.isActive('strike'),
  },
  DIVIDER,
  {
    label: 'H1',
    title: 'Heading 1',
    action: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    isActive: (e) => e.isActive('heading', { level: 1 }),
  },
  {
    label: 'H2',
    title: 'Heading 2',
    action: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    isActive: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    label: 'H3',
    title: 'Heading 3',
    action: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
    isActive: (e) => e.isActive('heading', { level: 3 }),
  },
  DIVIDER,
  {
    label: '\u2022',
    title: 'Bullet List',
    action: (e) => e.chain().focus().toggleBulletList().run(),
    isActive: (e) => e.isActive('bulletList'),
  },
  {
    label: '1.',
    title: 'Ordered List',
    action: (e) => e.chain().focus().toggleOrderedList().run(),
    isActive: (e) => e.isActive('orderedList'),
  },
  {
    label: '\u2610',
    title: 'Task List',
    action: (e) => e.chain().focus().toggleTaskList().run(),
    isActive: (e) => e.isActive('taskList'),
  },
  DIVIDER,
  {
    label: '\u275D',
    title: 'Blockquote',
    action: (e) => e.chain().focus().toggleBlockquote().run(),
    isActive: (e) => e.isActive('blockquote'),
  },
  {
    label: '<>',
    title: 'Code Block',
    action: (e) => e.chain().focus().toggleCodeBlock().run(),
    isActive: (e) => e.isActive('codeBlock'),
  },
  {
    label: '\u2014',
    title: 'Horizontal Rule',
    action: (e) => e.chain().focus().setHorizontalRule().run(),
  },
];

export function Toolbar({
  editor,
  onOpenFile,
  onExportHtml,
  onExportMarkdown,
  onPrint,
  recentFiles,
  showRecent,
  onToggleRecent,
  onOpenRecent,
  onClearRecent,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      {onOpenFile && (
        <button className="toolbar-btn" title="Open File (Ctrl+O)" onClick={onOpenFile}>
          Open
        </button>
      )}
      {recentFiles && recentFiles.length > 0 && onToggleRecent && (
        <div className="toolbar-dropdown-wrapper">
          <button className="toolbar-btn" title="Recent Files" onClick={onToggleRecent}>
            Recent
          </button>
          {showRecent && (
            <div className="toolbar-dropdown">
              {recentFiles.map((f) => (
                <button
                  key={f.path}
                  className="toolbar-dropdown-item"
                  onClick={() => onOpenRecent?.(f.path)}
                  title={f.path}
                >
                  {f.name}
                </button>
              ))}
              {onClearRecent && (
                <>
                  <div className="toolbar-dropdown-divider" />
                  <button className="toolbar-dropdown-item" onClick={onClearRecent}>
                    Clear recent
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      <span className="toolbar-divider" />
      {onExportHtml && (
        <button className="toolbar-btn" title="Export as HTML" onClick={onExportHtml}>
          HTML
        </button>
      )}
      {onExportMarkdown && (
        <button className="toolbar-btn" title="Export as Markdown" onClick={onExportMarkdown}>
          MD
        </button>
      )}
      {onPrint && (
        <button className="toolbar-btn" title="Print (Ctrl+P)" onClick={onPrint}>
          Print
        </button>
      )}
      <span className="toolbar-divider" />
      {toolbarItems.map((item, i) => {
        if (item === DIVIDER) {
          return <span key={`div-${i}`} className="toolbar-divider" />;
        }
        const active = editor && item.isActive?.(editor);
        return (
          <button
            key={item.label}
            className={`toolbar-btn${active ? ' active' : ''}`}
            title={item.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor && item.action(editor)}
            disabled={!editor}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
