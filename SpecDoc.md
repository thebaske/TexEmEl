# TexSaur — Specification Document

## 1. Vision

TexSaur is an open-source, lightweight, cross-platform desktop document editor. Users install it on their machine and use it as their default "Open With" application for documents. It absorbs any common document format, presents a clean WYSIWYG editor, and exports a single self-contained HTML file that every word processor on earth can open.

**One-liner**: Open anything. Edit beautifully. Export one clean HTML file that works everywhere.

## 2. Non-Goals (Equally Important)

- NOT a Word replacement — no page layout, no mail merge, no macros
- NOT round-trip — we don't write back to .docx/.odt. Import is one-way.
- NOT cloud-based — no accounts, no sync, no servers
- NOT a PDF editor — PDF is a print format, out of scope for v1
- NOT a collaborative editor — single user, local files
- NOT a page layout tool — no page breaks, headers/footers, or print margins in the editor (the HTML export can include print CSS)

## 3. Target Users

- Anyone who receives documents in formats they can't easily edit
- Writers who want a distraction-free editor that opens anything
- Developers who need to quickly edit a .docx without installing Office
- Students working across platforms who need a universal tool
- Anyone frustrated by format lock-in

## 4. Platform & Distribution

- **Runtime**: Tauri 2 (Rust + system webview)
- **Platforms**: Windows, macOS, Linux
- **Install size target**: < 15MB (Tauri advantage over Electron's 150MB+)
- **Distribution**: GitHub releases (.msi, .dmg, .AppImage, .deb)
- **License**: MIT
- **File associations**: Registers as handler for .docx, .odt, .rtf, .md, .txt, .html, .epub, .json on install

## 5. Architecture

### 5.1 High-Level Flow

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌─────────────┐
│  File Input  │────▶│ Codec Parse  │────▶│ DocumentTree │────▶│  TipTap     │
│  (any format)│     │ (one-way)    │     │ (canonical)  │     │  Editor     │
└─────────────┘     └──────────────┘     └──────┬───────┘     └──────┬──────┘
                                                │                     │
                                                │  ◀── edits ────────┘
                                                │
                                         ┌──────▼───────┐
                                         │   Exporter   │
                                         │  .html / .md │
                                         └──────────────┘
```

### 5.2 Layer Separation

```
┌─────────────────────────────────────────────────────────┐
│  UI Layer (src/ui/)                                     │
│  React components, TipTap editor, toolbar, file dialogs │
│  MAY import from @tauri-apps/*                          │
├─────────────────────────────────────────────────────────┤
│  Core Layer (src/core/)                                 │
│  DocumentTree, codecs, exporters, editor state          │
│  MUST NOT import from @tauri-apps/* or react            │
│  Pure TypeScript, zero platform dependencies            │
├─────────────────────────────────────────────────────────┤
│  Tauri Layer (src-tauri/)                               │
│  Rust backend, file I/O, native dialogs, OS integration │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Core Must Be Platform-Agnostic

The `src/core/` directory is the heart of TexSaur and must remain portable:
- No Tauri imports
- No React imports
- No DOM APIs (except in codecs that explicitly use DOMParser for HTML parsing)
- Pure TypeScript with zero runtime dependencies beyond npm packages
- This enables future web version, CLI tools, or other frontends

## 6. DocumentTree — The Canonical Model

Every imported format is parsed into this structure. The editor operates on it. Exporters read from it.

### 6.1 Tree Structure

```typescript
interface DocumentTree {
  blocks: Block[];
  metadata: DocumentMetadata;
}

interface DocumentMetadata {
  title?: string;
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  sourceFormat?: string;      // e.g. "docx", "markdown", "odt"
  sourceFileName?: string;    // original file name
}
```

### 6.2 Block Types

```typescript
type Block =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | TableBlock
  | ImageBlock
  | CodeBlock
  | BlockquoteBlock
  | DividerBlock;

interface ParagraphBlock {
  type: 'paragraph';
  content: InlineContent[];
  alignment?: 'left' | 'center' | 'right' | 'justify';
}

interface HeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: InlineContent[];
}

interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: ListItem[];
}

interface ListItem {
  content: InlineContent[];
  checked?: boolean;          // for task lists
  children?: ListBlock;       // nested lists
}

interface TableBlock {
  type: 'table';
  headers: TableCell[];
  rows: TableCell[][];
}

interface TableCell {
  content: InlineContent[];
  colspan?: number;
  rowspan?: number;
}

interface ImageBlock {
  type: 'image';
  src: string;                // base64 data URI or URL
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
}

interface CodeBlock {
  type: 'codeBlock';
  language?: string;
  code: string;
}

interface BlockquoteBlock {
  type: 'blockquote';
  blocks: Block[];            // blockquotes contain other blocks
}

interface DividerBlock {
  type: 'divider';
}
```

### 6.3 Inline Content

```typescript
type InlineContent =
  | TextInline
  | LinkInline
  | ImageInline
  | CodeInline
  | BreakInline;

interface TextInline {
  type: 'text';
  text: string;
  marks?: TextMark[];
}

type TextMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'underline' }
  | { type: 'strikethrough' }
  | { type: 'code' }
  | { type: 'highlight'; color?: string }
  | { type: 'color'; color: string }
  | { type: 'superscript' }
  | { type: 'subscript' };

interface LinkInline {
  type: 'link';
  href: string;
  title?: string;
  content: InlineContent[];
}

interface ImageInline {
  type: 'image';
  src: string;
  alt?: string;
}

interface CodeInline {
  type: 'code';
  text: string;
}

interface BreakInline {
  type: 'break';
}
```

## 7. Codec System

### 7.1 Interface

```typescript
interface FormatCodec {
  /** Unique identifier, e.g. "docx" */
  id: string;

  /** Display name, e.g. "Microsoft Word Document" */
  name: string;

  /** File extensions without dot, e.g. ["docx", "docm"] */
  extensions: string[];

  /** MIME types for format detection */
  mimeTypes: string[];

  /** Parse raw file bytes into a DocumentTree */
  parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree>;
}
```

### 7.2 Codec Registry

```typescript
class CodecRegistry {
  private codecs: Map<string, FormatCodec> = new Map();

  register(codec: FormatCodec): void;
  getByExtension(ext: string): FormatCodec | undefined;
  getByMimeType(mime: string): FormatCodec | undefined;
  detect(buffer: ArrayBuffer, fileName?: string): FormatCodec | undefined;
  getSupportedExtensions(): string[];
}
```

Format detection priority:
1. File extension (fastest)
2. MIME type (if available)
3. Magic bytes (fallback — check zip signature for docx/odt/epub, check `{\rtf` for RTF, etc.)

### 7.3 Planned Codecs

| Priority | Codec | Parser Strategy | Dependencies |
|----------|-------|----------------|--------------|
| P0 | TxtCodec | Direct string read, split on `\n\n` for paragraphs | None |
| P0 | MarkdownCodec | Markdown → AST → DocumentTree | remark + remark-gfm |
| P0 | DocxCodec | mammoth.js → HTML → DOM parse → DocumentTree | mammoth, jszip |
| P1 | HtmlCodec | DOMParser → walk tree → DocumentTree | None (browser API) |
| P1 | OdtCodec | jszip → content.xml → SAX/DOM parse → DocumentTree | jszip |
| P2 | RtfCodec | RTF token stream → DocumentTree | rtf-parser or custom |
| P2 | EpubCodec | jszip → spine order → XHTML chapters → DocumentTree | jszip |

### 7.4 DOCX Codec Detail (Most Complex Parser)

mammoth.js converts DOCX → semantic HTML. We then parse that HTML into DocumentTree:

```
.docx (zip) → mammoth.convertToHtml() → HTML string → DOMParser → walk DOM → DocumentTree
```

mammoth handles:
- Paragraphs, headings (mapped from Word styles)
- Bold, italic, underline, strikethrough
- Ordered and unordered lists
- Tables
- Images (extracted as base64 from the zip)
- Hyperlinks
- Footnotes/endnotes (converted to inline text)

mammoth does NOT handle (accepted losses):
- Page layout, margins, page breaks
- Headers and footers
- Track changes (accepts current state)
- Custom fonts (falls back to system fonts)
- Complex nested tables
- Embedded OLE objects (Excel charts, etc.)
- Form fields, macros

This is fine. We're extracting content, not layout.

## 8. Editor

### 8.1 Technology: TipTap

TipTap is chosen over raw ProseMirror because:
- Higher-level API, faster to build with
- Rich extension ecosystem (tables, task lists, images, code blocks all pre-built)
- React integration via `@tiptap/react`
- Active maintenance and community
- Same ProseMirror engine underneath — no performance penalty

### 8.2 Required Extensions

| Extension | Purpose |
|-----------|---------|
| StarterKit | Paragraphs, headings, bold, italic, strike, code, blockquote, lists, divider |
| Image | Block and inline images |
| Table + TableRow + TableCell + TableHeader | Table editing |
| TaskList + TaskItem | Checkbox lists |
| Placeholder | Empty document placeholder text |
| TextAlign | Paragraph alignment |
| Underline | Underline mark |
| Color + TextStyle | Text colors |
| Highlight | Background highlight |
| CodeBlockLowlight | Syntax-highlighted code blocks |

### 8.3 DocumentTree ↔ TipTap Bridge

TipTap uses its own ProseMirror-based document model internally. We need bidirectional conversion:

```
Import:  DocumentTree → TipTap JSON → editor.setContent()
Export:  editor.getJSON() → DocumentTree → HTML exporter
```

Two converter functions:
- `documentTreeToTipTap(tree: DocumentTree): JSONContent` — maps Block/Inline types to TipTap node/mark types
- `tipTapToDocumentTree(json: JSONContent): DocumentTree` — reverse mapping

This is straightforward because both models are tree-shaped with similar node types. The mapping is mostly 1:1.

### 8.4 Toolbar

Floating toolbar with buttons for:
- Text style: Bold, Italic, Underline, Strikethrough, Code
- Block type: Paragraph, H1-H4, Blockquote, Code Block
- Lists: Bullet, Ordered, Task
- Alignment: Left, Center, Right
- Insert: Image, Table, Horizontal Rule, Link
- Undo / Redo

Design: Clean, minimal, inspired by Notion/Bear. No ribbon UI. No tabs. Just the essentials.

### 8.5 Image Handling

**Paste/Drop**: Intercept paste and drop events. Extract image file. Convert to base64 data URI. Insert as ImageBlock.

**Display**: Render as `<img>` with max-width constraint. Click to select. Drag handles for resize.

**Storage**: Always base64 data URIs in the DocumentTree. No external file references. This keeps documents self-contained.

**Size limit**: Warn if single image > 5MB. Compress to WebP/AVIF if browser supports it. Hard reject > 20MB.

## 9. Export

### 9.1 HTML Exporter (Primary)

Generates a single self-contained `.html` file:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="generator" content="TexSaur">
  <title>{document title}</title>
  <style>
    /* Clean, print-friendly styles */
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      max-width: 8.5in;
      margin: 1in auto;
      padding: 0 0.5in;
      line-height: 1.6;
      color: #1a1a1a;
    }
    /* Heading styles, table styles, code block styles, image styles */
    /* Print media query for clean printing */
    @media print {
      body { margin: 0; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <!-- Document content as semantic HTML -->
  <!-- Images embedded as base64 -->
</body>
</html>
```

**Requirements**:
- Single file, no external references
- Opens correctly in: Chrome, Firefox, Safari, Edge, Word, Google Docs, LibreOffice
- Images embedded as base64 `<img src="data:image/...">`
- Tables use `<table>` with basic CSS borders
- Code blocks use `<pre><code>` with optional syntax class
- Print CSS included for clean printing
- UTF-8 encoding declared

### 9.2 Markdown Exporter (Secondary)

Generates a `.md` file using CommonMark + GFM extensions:
- Headings: `#` syntax
- Bold/italic: `**` and `*`
- Lists: `-` and `1.`
- Task lists: `- [ ]` / `- [x]`
- Tables: GFM pipe tables
- Code blocks: fenced with language
- Images: `![alt](data:...)` or referenced if too large
- Links: `[text](url)`

Lossy by nature — some formatting (colors, alignment, underline) cannot be represented in Markdown. This is documented and accepted.

## 10. UI Design

### 10.1 Layout

```
┌──────────────────────────────────────────────────┐
│  TexSaur                              [_][□][X]  │
├──────────────────────────────────────────────────┤
│  [Open] [Save HTML] [Save MD]  │  {file name}   │
├──────────────────────────────────────────────────┤
│  B  I  U  S  │  ¶ H1 H2 H3  │  • 1. ☐  │ img  │
├──────────────────────────────────────────────────┤
│                                                  │
│                                                  │
│            Editor Area (TipTap)                   │
│                                                  │
│            - WYSIWYG editing                     │
│            - Clean typography                    │
│            - Embedded images                     │
│            - Tables, lists, code blocks          │
│                                                  │
│                                                  │
│                                                  │
└──────────────────────────────────────────────────┘
```

### 10.2 Design Principles

- **Minimal chrome**: The document is the focus, not the UI
- **Fast launch**: < 1 second to editable state
- **Responsive**: Adapts to window size, no horizontal scroll
- **Dark/light mode**: Follow system preference via `prefers-color-scheme`
- **Typography-first**: Good defaults for font, line height, spacing
- **No modals on launch**: Open → edit → save. No wizard, no onboarding.

### 10.3 File Open Flow

1. User double-clicks a .docx (or any registered format) in file explorer
2. TexSaur launches, receives file path as CLI argument
3. Reads file bytes via Tauri fs plugin
4. CodecRegistry detects format from extension
5. Codec parses buffer → DocumentTree
6. DocumentTree converted to TipTap JSON
7. Editor renders with content
8. Total time target: < 2 seconds for a 50-page document

Alternative: User clicks "Open" button → Tauri native file dialog → same flow from step 3.

### 10.4 Save/Export Flow

1. User clicks "Save as HTML" (or Ctrl+S)
2. If no save path set → Tauri native save dialog (default .html extension)
3. Editor state → TipTap JSON → DocumentTree
4. DocumentTree → HTML exporter → HTML string
5. Write to file via Tauri fs plugin
6. Show brief "Saved" notification

## 11. Performance Targets

| Metric | Target |
|--------|--------|
| App launch (cold) | < 2 seconds |
| Open 10-page DOCX | < 1 second |
| Open 100-page DOCX | < 5 seconds |
| Typing latency | < 16ms (60fps) |
| HTML export 50 pages | < 500ms |
| Memory (idle) | < 100MB |
| Memory (100-page doc) | < 300MB |
| Installer size | < 15MB |

## 12. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+O | Open file |
| Ctrl+S | Save as HTML |
| Ctrl+Shift+S | Save as (choose format) |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+B | Bold |
| Ctrl+I | Italic |
| Ctrl+U | Underline |
| Ctrl+Shift+X | Strikethrough |
| Ctrl+E | Center align |
| Ctrl+J | Justify |
| Ctrl+Shift+1-4 | Heading 1-4 |
| Ctrl+Shift+8 | Bullet list |
| Ctrl+Shift+9 | Ordered list |
| Tab / Shift+Tab | Indent / outdent in lists |

## 13. Error Handling

### 13.1 Import Errors

If a codec fails to parse:
- Show a non-blocking notification: "Could not fully parse this file. Some content may be missing."
- Load whatever was successfully parsed
- Never crash — partial content is better than nothing
- Log the error to console for debugging

### 13.2 Unsupported Format

If no codec matches the file:
- Try to read as plain text (UTF-8, then Latin-1 fallback)
- Show notification: "Unknown format — opened as plain text"

### 13.3 Corrupt Files

- mammoth.js handles corrupt DOCX gracefully (partial extraction)
- jszip handles corrupt zips with clear error messages
- Fallback: show empty editor with error notification

## 14. Future Considerations (Not In Scope for v1)

These are explicitly NOT being built now, but the architecture should not prevent them:

- **PDF import**: Could add pdf.js-based codec later
- **Collaborative editing**: Yjs could be layered on TipTap
- **Cloud sync**: Could add Supabase/S3 backend later
- **Plugin system**: Codecs are already plugin-shaped
- **CLI mode**: Core is platform-agnostic, could power a `texsaur convert` CLI
- **Web version**: Core has no Tauri deps, could run in browser
- **Additional export formats**: DOCX export, EPUB export
- **Themes**: Custom editor themes beyond light/dark
- **Spell check**: System spell checker via Tauri or a JS library
- **Find & replace**: TipTap has search extension

## 15. File Structure Reference

```
F:/_PROJECTS/TexSaur/
├── .gitignore
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── CLAUDE.md                        # Agent instructions
├── SpecDoc.md                       # This file
├── index.html                       # Vite entry HTML
│
├── src/
│   ├── main.tsx                     # React entry point
│   ├── App.tsx                      # Root component, routing
│   │
│   ├── core/
│   │   ├── model/
│   │   │   └── DocumentTree.ts      # All type definitions from §6
│   │   │
│   │   ├── codecs/
│   │   │   ├── CodecRegistry.ts     # Registry + format detection
│   │   │   ├── TxtCodec.ts          # Plain text parser
│   │   │   ├── MarkdownCodec.ts     # Markdown parser
│   │   │   ├── DocxCodec.ts         # DOCX → HTML → DocumentTree
│   │   │   ├── HtmlCodec.ts         # HTML DOM → DocumentTree
│   │   │   ├── OdtCodec.ts          # ODT XML → DocumentTree
│   │   │   ├── RtfCodec.ts          # RTF tokens → DocumentTree
│   │   │   └── EpubCodec.ts         # EPUB XHTML → DocumentTree
│   │   │
│   │   ├── editor/
│   │   │   └── EditorBridge.ts      # DocumentTree ↔ TipTap JSON conversion
│   │   │
│   │   └── export/
│   │       ├── HtmlExporter.ts      # DocumentTree → self-contained HTML
│   │       └── MarkdownExporter.ts  # DocumentTree → GFM Markdown
│   │
│   ├── ui/
│   │   ├── components/
│   │   │   ├── Editor.tsx           # TipTap editor wrapper
│   │   │   ├── Toolbar.tsx          # Formatting toolbar
│   │   │   ├── TitleBar.tsx         # App title bar with file name
│   │   │   └── StatusBar.tsx        # Bottom bar (word count, format info)
│   │   │
│   │   ├── hooks/
│   │   │   ├── useDocument.ts       # Document state management
│   │   │   ├── useFileOperations.ts # Open/save via Tauri
│   │   │   └── useTheme.ts          # Light/dark mode
│   │   │
│   │   └── styles/
│   │       ├── global.css           # Reset, typography, variables
│   │       ├── editor.css           # TipTap editor styles
│   │       └── toolbar.css          # Toolbar styles
│   │
│   └── utils/
│       ├── base64.ts                # Image → base64 conversion
│       ├── fileDetect.ts            # Magic byte detection
│       └── sanitize.ts              # HTML sanitization
│
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json
│   └── src/
│       ├── main.rs
│       └── lib.rs
│
└── public/
    └── (empty — no static assets needed)
```
