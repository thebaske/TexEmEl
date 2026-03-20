// ============================================================================
// Toolbar — Full formatting toolbar for LayoutDirector
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import type { LayoutDirector } from '../../core/layout/LayoutDirector';

interface ToolbarProps {
  engine: LayoutDirector | null;
  /** Incremented by App to force re-render when engine state changes */
  version?: number;
}

// --- Constants ---

const BLOCK_TYPES = [
  { label: 'Paragraph', value: 'paragraph' },
  { label: 'Heading 1', value: 'heading:1' },
  { label: 'Heading 2', value: 'heading:2' },
  { label: 'Heading 3', value: 'heading:3' },
  { label: 'Heading 4', value: 'heading:4' },
  { label: 'Heading 5', value: 'heading:5' },
  { label: 'Heading 6', value: 'heading:6' },
];

const FONT_FAMILIES = [
  { label: 'Default', value: '' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: 'Times New Roman, serif' },
  { label: 'Courier New', value: 'Courier New, monospace' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Trebuchet MS', value: 'Trebuchet MS, sans-serif' },
  { label: 'Impact', value: 'Impact, sans-serif' },
  { label: 'Comic Sans MS', value: 'Comic Sans MS, cursive' },
];

const FONT_SIZES = [
  { label: '10', value: '10px' },
  { label: '12', value: '12px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '20', value: '20px' },
  { label: '24', value: '24px' },
  { label: '28', value: '28px' },
  { label: '32', value: '32px' },
  { label: '36', value: '36px' },
  { label: '48', value: '48px' },
];

const TEXT_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc',
  '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb',
  '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#d97706',
];

const HIGHLIGHT_COLORS = [
  '', '#fef08a', '#bbf7d0', '#bfdbfe', '#e9d5ff',
  '#fecaca', '#fed7aa', '#d1fae5', '#dbeafe', '#fce7f3',
];

// --- Component ---

export function Toolbar({ engine, version: _version }: ToolbarProps) {
  const marks = engine?.getActiveMarks() ?? [];
  const hasMark = (type: string) => marks.some(m => m.type === type);
  const getMarkAttr = (type: string, attr: string): string | undefined => {
    const mark = marks.find(m => m.type === type);
    return mark ? (mark as any)[attr] : undefined;
  };

  const blockType = engine?.getActiveBlockType() ?? 'paragraph';

  return (
    <div className="toolbar">
      {/* Block Type Selector */}
      <ToolbarSelect
        title="Block Type"
        value={blockType}
        options={BLOCK_TYPES}
        onChange={(v) => engine?.setBlockType(v)}
        disabled={!engine}
        width={120}
      />
      <Divider />

      {/* Undo / Redo */}
      <ToolbarIconButton
        icon={<SvgUndo />}
        title="Undo (Ctrl+Z)"
        onClick={() => engine?.undo()}
        disabled={!engine}
      />
      <ToolbarIconButton
        icon={<SvgRedo />}
        title="Redo (Ctrl+Y)"
        onClick={() => engine?.redo()}
        disabled={!engine}
      />
      <Divider />

      {/* Font Family */}
      <ToolbarSelect
        title="Font Family"
        value={getMarkAttr('fontFamily', 'family') ?? ''}
        options={FONT_FAMILIES}
        onChange={(v) => engine?.setFontFamily(v)}
        disabled={!engine}
        width={120}
      />

      {/* Font Size */}
      <ToolbarSelect
        title="Font Size"
        value={getMarkAttr('fontSize', 'size') ?? ''}
        options={FONT_SIZES}
        onChange={(v) => engine?.setFontSize(v)}
        disabled={!engine}
        width={60}
      />
      <Divider />

      {/* Basic Formatting */}
      <ToolbarButton label="B" title="Bold (Ctrl+B)" active={hasMark('bold')}
        onClick={() => engine?.applyMark('bold')} disabled={!engine}
        style={{ fontWeight: 700 }} />
      <ToolbarButton label="I" title="Italic (Ctrl+I)" active={hasMark('italic')}
        onClick={() => engine?.applyMark('italic')} disabled={!engine}
        style={{ fontStyle: 'italic' }} />
      <ToolbarButton label="U" title="Underline (Ctrl+U)" active={hasMark('underline')}
        onClick={() => engine?.applyMark('underline')} disabled={!engine}
        style={{ textDecoration: 'underline' }} />
      <ToolbarButton label="S" title="Strikethrough" active={hasMark('strikethrough')}
        onClick={() => engine?.applyMark('strikethrough')} disabled={!engine}
        style={{ textDecoration: 'line-through' }} />
      <Divider />

      {/* Super/Subscript */}
      <ToolbarIconButton
        icon={<span>X<sup style={{fontSize:'0.6em',verticalAlign:'super'}}>2</sup></span>}
        title="Superscript" active={hasMark('superscript')}
        onClick={() => engine?.applyMark('superscript')} disabled={!engine} />
      <ToolbarIconButton
        icon={<span>X<sub style={{fontSize:'0.6em',verticalAlign:'sub'}}>2</sub></span>}
        title="Subscript" active={hasMark('subscript')}
        onClick={() => engine?.applyMark('subscript')} disabled={!engine} />
      <Divider />

      {/* Text Color */}
      <ColorPicker
        label="A"
        title="Text Color"
        colors={TEXT_COLORS}
        currentColor={getMarkAttr('color', 'color') ?? '#000000'}
        onChange={(c) => engine?.applyMark('color', { color: c })}
        disabled={!engine}
        type="text"
      />

      {/* Highlight Color */}
      <ColorPicker
        label="H"
        title="Highlight"
        colors={HIGHLIGHT_COLORS}
        currentColor={getMarkAttr('highlight', 'color') ?? ''}
        onChange={(c) => engine?.applyMark('highlight', { color: c || null })}
        disabled={!engine}
        type="highlight"
      />
      <Divider />

      {/* Alignment */}
      <AlignmentGroup engine={engine} />
      <Divider />

      {/* Link */}
      <LinkButton engine={engine} hasLink={hasMark('link')} />
      <Divider />

      {/* Table Insert */}
      <TableGridPicker engine={engine} />

      {/* Image Insert */}
      <ImageInsertButton engine={engine} />

      {/* Horizontal Rule */}
      <ToolbarIconButton icon={<SvgHorizontalRule />} title="Horizontal Rule"
        onClick={() => engine?.insertBlock({ type: 'divider' })} disabled={!engine} />
    </div>
  );
}

// --- Sub-Components ---

function Divider() {
  return <span className="toolbar-divider" />;
}

interface ToolbarButtonProps {
  label: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}

function ToolbarButton({ label, title, active, disabled, onClick, style }: ToolbarButtonProps) {
  return (
    <button
      className={`toolbar-btn${active ? ' active' : ''}`}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      style={style}
    >
      {label}
    </button>
  );
}

interface ToolbarIconButtonProps {
  icon: React.ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

function ToolbarIconButton({ icon, title, active, disabled, onClick }: ToolbarIconButtonProps) {
  return (
    <button
      className={`toolbar-btn${active ? ' active' : ''}`}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}

// --- SVG Icons ---

function SvgUndo() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h7a4 4 0 0 1 0 8H8" />
      <path d="M6 4L3 7l3 3" />
    </svg>
  );
}

function SvgRedo() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 7H6a4 4 0 0 0 0 8h2" />
      <path d="M10 4l3 3-3 3" />
    </svg>
  );
}

function SvgLink() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M6.5 9.5a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-1 1" />
      <path d="M9.5 6.5a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l1-1" />
    </svg>
  );
}

function SvgImage() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle cx="5" cy="6" r="1.5" />
      <path d="M14.5 10.5l-3.5-3.5-5 5" />
    </svg>
  );
}

function SvgHorizontalRule() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="7" width="14" height="2" rx="1" />
    </svg>
  );
}

interface ToolbarSelectProps {
  title: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  width?: number;
}

function ToolbarSelect({ title, value, options, onChange, disabled, width }: ToolbarSelectProps) {
  return (
    <select
      className="toolbar-select"
      title={title}
      value={value}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        onChange(e.target.value);
        // Re-focus the editor after select interaction
        // (select steals focus, but the change is already dispatched)
      }}
      disabled={disabled}
      style={{ width: width ? `${width}px` : undefined }}
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

interface ColorPickerProps {
  label: string;
  title: string;
  colors: string[];
  currentColor: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  type: 'text' | 'highlight';
}

function ColorPicker({ label, title, colors, currentColor, onChange, disabled, type }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const indicatorColor = type === 'text' ? (currentColor || '#000') : (currentColor || 'transparent');

  return (
    <div ref={ref} className="toolbar-dropdown-wrapper" style={{ display: 'inline-flex' }}>
      <button
        className="toolbar-btn"
        title={title}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
        style={{ position: 'relative' }}
      >
        {label}
        <span
          className="toolbar-color-indicator"
          style={{
            position: 'absolute',
            bottom: 2,
            left: 4,
            right: 4,
            height: 3,
            backgroundColor: indicatorColor,
            borderRadius: 1,
          }}
        />
      </button>
      {open && (
        <div className="toolbar-dropdown" style={{ padding: 8, display: 'flex', flexWrap: 'wrap', gap: 4, width: 160 }}>
          {colors.map((c, i) => (
            <button
              key={i}
              className="toolbar-color-swatch"
              style={{
                width: 24,
                height: 24,
                border: c === currentColor ? '2px solid #3b82f6' : '1px solid #ccc',
                borderRadius: 3,
                backgroundColor: c || '#fff',
                cursor: 'pointer',
                padding: 0,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(c); setOpen(false); }}
              title={c || 'None'}
            >
              {!c && <span style={{ fontSize: 12, color: '#999' }}>\u2715</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface AlignmentGroupProps {
  engine: LayoutDirector | null;
}

function AlignmentGroup({ engine }: AlignmentGroupProps) {
  const align = engine?.getTextAlign() ?? 'left';

  const aligns: { value: string; label: string; title: string }[] = [
    { value: 'left', label: '\u2261', title: 'Align Left' },
    { value: 'center', label: '\u2261', title: 'Align Center' },
    { value: 'right', label: '\u2261', title: 'Align Right' },
    { value: 'justify', label: '\u2261', title: 'Justify' },
  ];

  return (
    <>
      {aligns.map(a => (
        <button
          key={a.value}
          className={`toolbar-btn toolbar-align-${a.value}${align === a.value ? ' active' : ''}`}
          title={a.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => engine?.setTextAlign(a.value)}
          disabled={!engine}
        >
          <AlignIcon align={a.value} />
        </button>
      ))}
    </>
  );
}

function AlignIcon({ align }: { align: string }) {
  // Simple SVG alignment icons
  const lines: [number, number][] = (() => {
    switch (align) {
      case 'left':    return [[2, 14], [2, 10], [2, 14], [2, 8]];
      case 'center':  return [[3, 13], [1, 15], [3, 13], [2, 14]];
      case 'right':   return [[4, 14], [6, 14], [2, 14], [8, 14]];
      case 'justify': return [[2, 14], [2, 14], [2, 14], [2, 14]];
      default:        return [[2, 14], [2, 10], [2, 14], [2, 8]];
    }
  })();

  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <rect x={lines[0][0]} y="2" width={lines[0][1] - lines[0][0]} height="2" rx="0.5" />
      <rect x={lines[1][0]} y="6" width={lines[1][1] - lines[1][0]} height="2" rx="0.5" />
      <rect x={lines[2][0]} y="10" width={lines[2][1] - lines[2][0]} height="2" rx="0.5" />
      <rect x={lines[3][0]} y="14" width={lines[3][1] - lines[3][0]} height="2" rx="0.5" />
    </svg>
  );
}

interface LinkButtonProps {
  engine: LayoutDirector | null;
  hasLink: boolean;
}

function LinkButton({ engine, hasLink }: LinkButtonProps) {
  const handleClick = useCallback(() => {
    if (!engine) return;

    if (hasLink) {
      engine.removeLink();
      return;
    }

    const href = prompt('Enter URL:');
    if (href) {
      engine.insertLink(href);
    }
  }, [engine, hasLink]);

  return (
    <ToolbarIconButton
      icon={<SvgLink />}
      title={hasLink ? 'Remove Link' : 'Insert Link'}
      active={hasLink}
      onClick={handleClick}
      disabled={!engine}
    />
  );
}

// --- Table Grid Picker ---

interface TableGridPickerProps {
  engine: LayoutDirector | null;
}

function TableGridPicker({ engine }: TableGridPickerProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const MAX_ROWS = 6;
  const MAX_COLS = 6;

  return (
    <div ref={ref} className="toolbar-dropdown-wrapper" style={{ display: 'inline-flex' }}>
      <button
        className="toolbar-btn"
        title="Insert Table"
        disabled={!engine}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <rect x="1" y="1" width="14" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line x1="1" y1="5.5" x2="15" y2="5.5" stroke="currentColor" strokeWidth="1" />
          <line x1="1" y1="10.5" x2="15" y2="10.5" stroke="currentColor" strokeWidth="1" />
          <line x1="5.5" y1="1" x2="5.5" y2="15" stroke="currentColor" strokeWidth="1" />
          <line x1="10.5" y1="1" x2="10.5" y2="15" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      {open && (
        <div className="toolbar-dropdown" style={{ padding: 8 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4, textAlign: 'center' }}>
            {hover ? `${hover.r} \u00D7 ${hover.c}` : 'Select size'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${MAX_COLS}, 20px)`, gap: 2 }}>
            {Array.from({ length: MAX_ROWS * MAX_COLS }, (_, i) => {
              const r = Math.floor(i / MAX_COLS) + 1;
              const c = (i % MAX_COLS) + 1;
              const highlighted = hover ? r <= hover.r && c <= hover.c : false;
              return (
                <div
                  key={i}
                  style={{
                    width: 20,
                    height: 20,
                    border: `1px solid ${highlighted ? '#3b82f6' : '#ccc'}`,
                    background: highlighted ? 'rgba(59,130,246,0.15)' : 'transparent',
                    borderRadius: 2,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={() => setHover({ r, c })}
                  onMouseLeave={() => setHover(null)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    engine?.insertTable(r, c);
                    setOpen(false);
                    setHover(null);
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Image Insert Button ---

interface ImageInsertButtonProps {
  engine: LayoutDirector | null;
}

function ImageInsertButton({ engine }: ImageInsertButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!engine) return;
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      engine.insertImage(src, file.name);
    };
    reader.readAsDataURL(file);

    // Reset input so same file can be selected again
    e.target.value = '';
  }, [engine]);

  return (
    <>
      <ToolbarIconButton
        icon={<SvgImage />}
        title="Insert Image"
        onClick={handleClick}
        disabled={!engine}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </>
  );
}
