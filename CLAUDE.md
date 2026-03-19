# TexSaur — Universal Document Editor

## What Is This Project

TexSaur is a lightweight, cross-platform desktop document editor built with Tauri 2 + React + TypeScript. It opens any common document format (DOCX, ODT, RTF, Markdown, TXT, HTML, EPUB), provides a rich WYSIWYG editing experience, and exports clean single-file HTML that any word processor can open.

**Core philosophy**: Absorb the chaos of many formats. Emit one universal output.

## Tech Stack

- **Desktop shell**: Tauri 2 (Rust backend, webview frontend)
- **Frontend**: React 18 + TypeScript + Vite
- **Editor**: TipTap (ProseMirror-based) with rich extensions
- **Import parsers**: mammoth.js (DOCX), jszip (zip-based formats), turndown (HTML→MD)
- **Export**: Clean self-contained HTML with embedded base64 images

## Project Structure

```
src/
├── core/                    # Framework-agnostic business logic
│   ├── model/               # DocumentTree types, Block/Inline definitions
│   ├── codecs/              # Format parsers (one file per format)
│   │   ├── CodecRegistry.ts # Central codec registration
│   │   ├── TxtCodec.ts      # Plain text parser
│   │   ├── MarkdownCodec.ts # Markdown parser
│   │   ├── DocxCodec.ts     # DOCX parser (mammoth.js)
│   │   ├── HtmlCodec.ts     # HTML parser (DOM-based)
│   │   ├── OdtCodec.ts      # OpenDocument parser
│   │   ├── RtfCodec.ts      # Rich Text Format parser
│   │   └── EpubCodec.ts     # EPUB parser
│   ├── editor/              # Editor state management, commands
│   └── export/              # HTML exporter, MD exporter
├── ui/                      # React components
│   ├── components/          # Editor, Toolbar, Sidebar, FileOpen
│   ├── hooks/               # useDocument, useEditor, useFileOpen
│   ├── styles/              # CSS files
│   └── assets/              # Static assets
├── utils/                   # Shared utilities
├── main.tsx                 # App entry point
└── App.tsx                  # Root component
src-tauri/                   # Tauri Rust backend
├── src/
│   ├── main.rs              # Entry point
│   └── lib.rs               # Plugin setup, commands
├── Cargo.toml
├── tauri.conf.json          # Window config, file associations, bundle
└── capabilities/            # Permission scopes
```

## Architecture Rules

1. **Codecs are pure functions**: Each codec implements `FormatCodec` interface — `parse(buffer) → DocumentTree`. No side effects, no DOM access, no framework imports. This makes them testable and portable.

2. **DocumentTree is the canonical model**: Every format gets parsed into the same `DocumentTree` structure. The editor operates on DocumentTree. Export reads from DocumentTree. No format-specific logic leaks into the editor.

3. **One-way import**: We parse formats to extract content. We do NOT write back to the original format. Import is lossy by design — we extract what we can represent and discard the rest.

4. **Export only HTML/MD**: The only export formats are self-contained HTML and Markdown. HTML is the primary output — it's the universal format every word processor opens.

5. **Images are embedded**: On import, images are extracted and converted to base64 data URIs. On export, they're embedded in the HTML as base64. No external file references.

6. **No server dependencies**: Everything runs locally. No cloud services, no accounts, no network calls.

7. **Tauri for desktop, but core is web-compatible**: The `src/core/` directory must never import from `@tauri-apps/*`. Tauri APIs are only used in `src/ui/` for file dialogs and native integration. This keeps the core portable for a potential future web version.

## Commands

```bash
npm run dev          # Start Vite dev server (web-only, no Tauri)
npm run build        # Build frontend
npm run tauri:dev    # Start Tauri dev mode (desktop app)
npm run tauri:build  # Build desktop installer
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
```

## Key Interfaces

```typescript
// Every codec implements this
interface FormatCodec {
  id: string;
  name: string;
  extensions: string[];
  mimeTypes: string[];
  parse(buffer: ArrayBuffer): Promise<DocumentTree>;
}

// The universal document model
interface DocumentTree {
  blocks: Block[];
  metadata: DocumentMetadata;
}

// Block types: paragraph, heading, list, table, image, codeBlock, blockquote, divider
// Inline types: text, bold, italic, underline, strikethrough, code, link, image
```

See `src/core/model/DocumentTree.ts` for full type definitions.

## Implementation Order

Phase 1 (MVP):
1. DocumentTree model types
2. TxtCodec + MarkdownCodec (simplest parsers)
3. TipTap editor wired to DocumentTree
4. HTML exporter
5. Basic UI (file open, editor, toolbar)
6. Tauri file dialog integration

Phase 2:
7. DocxCodec (mammoth.js)
8. HtmlCodec
9. Markdown exporter
10. Image handling (paste, drag, embed as base64)

Phase 3:
11. OdtCodec, RtfCodec, EpubCodec
12. File associations (double-click to open)
13. Recent files list
14. Print / export polish
15. Packaging and installers

## TypeScript Notes

- `skipLibCheck: true` is intentional — some TipTap type defs conflict
- Path aliases: `@core/*`, `@ui/*`, `@utils/*` → mapped in tsconfig + vite config
- Strict mode enabled — no `any` unless absolutely necessary
