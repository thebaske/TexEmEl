# TexEmEl — Full Architecture Analysis & Refactor Roadmap

> **Document Purpose**: Deep technical analysis of TexEmEl's current state, identification of architectural problems, and a phased roadmap to make it a viable product.
>
> **What is TexEmEl**: An HTML editor with BSP (Binary Space Partition) cell layouting. The name comes from "Tex" (text editor) + "Em El" (from HTML). It opens any document format, provides rich WYSIWYG editing in a flexible cell-based layout, and exports clean HTML. The BSP layout system is the core differentiator — not the format codecs.

---

## Table of Contents

1. [Current Architecture Overview](#1-current-architecture-overview)
2. [What Works Well](#2-what-works-well)
3. [The Core Problem: Two-Authority Content Ownership](#3-the-core-problem-two-authority-content-ownership)
4. [Complete Gap Analysis](#4-complete-gap-analysis)
5. [The Content Stream Model](#5-the-content-stream-model)
6. [HTML as Native Format](#6-html-as-native-format)
7. [Refactor Roadmap](#7-refactor-roadmap)
8. [File-by-File Change Map](#8-file-by-file-change-map)
9. [Verification & Testing Strategy](#9-verification--testing-strategy)

---

## 1. Current Architecture Overview

### 1.1 The Layer Cake

```
┌─────────────────────────────────────────────────┐
│  UI Layer (React)                                │
│  App.tsx → MenuBar, Toolbar, BspEditor           │
│  Hooks: useFileOpen, useExport, useFileDrop      │
├─────────────────────────────────────────────────┤
│  Layout Engine                                   │
│  LayoutDirector (orchestrator, 1049 LOC)         │
│  LayoutTree (BSP model), PageModel (pages)       │
│  LayoutReconciler (DOM diffing)                  │
│  OverflowDetector → ContentSplitter →            │
│  OverflowResolver (content flow)                 │
│  CellPool → CellInstance (cell management)       │
│  EdgeSplitManager, SplitResizeManager            │
│  NavigationController (cross-cell keyboard)      │
├─────────────────────────────────────────────────┤
│  Text Editing                                    │
│  TextKernel (ProseMirror wrapper, 968 LOC)       │
│  One PM editor per cell                          │
│  Schema: paragraphs, headings, lists,            │
│  blockquotes, code, images, 11 mark types        │
├─────────────────────────────────────────────────┤
│  Document Model                                  │
│  DocumentTree (canonical IR, 251 LOC)            │
│  Block types: paragraph, heading, list, table,   │
│  image, codeBlock, blockquote, divider,          │
│  container                                       │
│  Inline: text, link, image, code, break          │
│  Marks: bold, italic, underline, strikethrough,  │
│  highlight, color, super/subscript, font         │
├─────────────────────────────────────────────────┤
│  Format I/O                                      │
│  Codecs: TXT, MD, HTML, DOCX, ODT, RTF, EPUB    │
│  Exporters: HTML, MD, RTF, TXT                   │
│  CodecRegistry (format detection)                │
├─────────────────────────────────────────────────┤
│  Platform (Tauri 2)                              │
│  Rust: fs plugin, dialog plugin (23 LOC total)   │
│  File associations for 9 formats                 │
│  Capabilities: fs read/write-all, dialog         │
└─────────────────────────────────────────────────┘
```

### 1.2 How the BSP Layout Works

The page layout uses a **binary space partition tree**. Every page contains a recursive binary tree where:

- **LeafNode** = a content cell (holds blocks, has a ProseMirror editor)
- **SplitNode** = a partition (horizontal or vertical, with a ratio and two children)

```
Page
└── SplitNode (horizontal, 60/40)
    ├── SplitNode (vertical, 50/50)
    │   ├── LeafNode [Cell A - content]
    │   └── LeafNode [Cell B - content]
    └── LeafNode [Cell C - content]
```

Visual result:
```
┌──────────┬──────────┐
│  Cell A  │  Cell B  │  60%
├──────────┴──────────┤
│       Cell C        │  40%
└─────────────────────┘
```

**Splitting**: Drag an edge of any cell → the leaf splits into a SplitNode with two children. The original leaf keeps its ID (and its PM editor). Only the new sibling gets a fresh ID. This means the DOM is reused, not destroyed.

**Resizing**: Drag the bar between cells → updates the split's `ratio` property → CSS flex recalculates.

**Merging**: Two cells merge back into one. Both cells' content is drained, one cell is released (PM destroyed), content inserted into the surviving cell.

### 1.3 How Content Flow Works Today

1. **Detection**: After any content or layout change, `checkLastCellOverflow()` measures each cell's `scrollHeight` vs `clientHeight`
2. **Break Point**: Walks block-by-block to find the last block that fits. If mid-paragraph, uses Range API for character-level measurement
3. **Splitting**: `ContentSplitter` partitions blocks into "fits" and "overflow". Split paragraphs get a `splitId` for potential rejoin
4. **Redistribution**: Overflow blocks are physically moved to the next cell in the BSP tree. If no sibling exists, flows to next page. If no next page, creates one
5. **Iteration**: Repeats until no overflow remains (max 20 iterations)

### 1.4 How Editing Works

- Each cell owns exactly ONE ProseMirror editor
- PM handles: typing, formatting, Enter key (new paragraph), selection, undo/redo
- Toolbar reads live state from PM via `engine.getActiveMarks()`, `engine.getActiveBlockType()`
- Cross-cell navigation: when PM cursor hits a boundary, `NavigationController` moves focus to the next cell in reading order
- State management: plain React hooks in App.tsx (no Redux/Zustand), LayoutDirector holds layout state, TextKernel holds PM state

### 1.5 Codebase Metrics

| Metric | Value |
|--------|-------|
| TypeScript LOC | ~12,800 across 58 files |
| Rust LOC | 23 (minimal Tauri shell) |
| Input Formats | 8 (TXT, MD, HTML, DOCX, ODT, RTF, EPUB, JSON) |
| Export Formats | 4 (HTML, MD, RTF, TXT) |
| Test Coverage | 0% — no test files exist |
| CI/CD | None |
| Version | 0.1.0 (Alpha) |

---

## 2. What Works Well

These systems are solid and should be preserved through the refactor:

### 2.1 BSP Tree Model (`LayoutTree.ts` — 312 LOC)
**Status: Solid, keep as-is**

Pure tree operations. Split, merge, resize, find — all correct. The tree is the right abstraction for flexible page layout. No bugs found. The reconciler (`LayoutReconciler.ts`) does efficient DOM diffing against this tree, reusing cells by ID.

### 2.2 Edge-Drag Splitting (`EdgeSplitManager.ts`)
**Status: Polished, keep as-is**

The interaction design is clever: 12px edge zones, cursor changes to hint direction, 16px minimum drag to confirm, split ratio from release position. No icons, no visual clutter. This is a differentiating UX.

### 2.3 Cell Persistence (`CellPool.ts` + `CellInstance.ts`)
**Status: Solid, will need adaptation for Content Stream**

Cells are pooled by ID. When the reconciler encounters a known ID, it reuses the cell. When a cell is split, the original keeps its ID (and PM editor). This means DOM is never destroyed during layout operations — only reparented via flexbox. Excellent design.

### 2.4 Format Codecs (7 codecs, all complete)
**Status: Production-ready, keep as-is**

| Codec | LOC | Quality | Notes |
|-------|-----|---------|-------|
| TxtCodec | 29 | Simple & correct | Splits on double newlines |
| MarkdownCodec | 247 | Good | Hand-rolled recursive descent, handles most CommonMark |
| HtmlCodec | 323 | Excellent | Handles real-world HTML from paste/DOCX/EPUB |
| DocxCodec | 45 | Excellent | Thin wrapper: mammoth→HtmlCodec (smart reuse) |
| OdtCodec | 305 | Good | Full ODF namespace handling, images as base64 |
| RtfCodec | 303 | Good | Hand-rolled state-machine parser, no dependencies |
| EpubCodec | 129 | Excellent | Respects spine order, delegates chapters to HtmlCodec |

**Codec composition**: DocxCodec and EpubCodec both delegate to HtmlCodec. No duplication. Format detection goes extension → magic bytes → content heuristics → fallback.

### 2.5 Exporters (4 formats)
**Status: Good, HTML exporter needs layout preservation (Phase 3)**

| Exporter | LOC | Quality | Notes |
|----------|-----|---------|-------|
| HtmlExporter | 254 | Excellent | Self-contained, inline CSS, base64 images, print-friendly |
| MarkdownExporter | 115 | Good | GFM output, some marks lost (underline, highlight) |
| RtfExporter | 180 | Good | Valid RTF, no image embedding |
| TxtExporter | 85 | Good | Plain text, formatting stripped |

### 2.6 DocumentTree Model (`DocumentTree.ts` — 251 LOC)
**Status: Excellent, keep as-is**

The canonical intermediate representation. 9 block types, 5 inline types, 11 mark types. `pmDocJson` field preserves lossless ProseMirror snapshots. `splitId` + `splitPart` track pagination splits. Well-documented, covers ~95% of common document structures.

### 2.7 UI/CSS
**Status: Clean, keep as-is**

CSS variables for theming, full dark mode support (`prefers-color-scheme`), print styles, responsive layout. Editor styles have proper typography hierarchy, consistent spacing. BSP styles handle page rendering, resize handles, edge zones, empty cell placeholders.

---

## 3. The Core Problem: Two-Authority Content Ownership

This is the single most important issue blocking TexEmEl from being a viable product. Everything else is secondary.

### 3.1 What Happens Today

Two systems claim to own the content:

```
Authority 1: ProseMirror (TextKernel)
- Holds the LIVE content (keystrokes, cursor, selection, undo history)
- Updated in real-time as the user types
- Authoritative for what the user sees RIGHT NOW

Authority 2: LayoutTree (OverflowResolver)
- Holds the SERIALIZED content (Block[] arrays on LeafNodes)
- Updated when overflow redistributes blocks between cells
- Authoritative for what SHOULD be in each cell
```

### 3.2 How They Conflict

**Scenario: User types near an overflow boundary**

```
T=0ms  User types "hello" in Cell A
T=1ms  PM has "hello" in its live document (not yet synced to LayoutTree)
T=5ms  Overflow check fires (200ms timer from previous edit)
T=6ms  OverflowResolver reads Cell A's blocks from LayoutTree (stale — doesn't have "hello")
T=7ms  Resolver decides Cell A overflows, splits blocks, moves some to Cell B
T=8ms  CellInstance.setContent() replaces Cell A's PM document with the resolver's version
T=8ms  ❌ "hello" is GONE — PM was overwritten with stale data
```

**Scenario: normalizeBlocks() after layout change**

```
T=0ms  User has cursor at line 3 of Cell A, with 5 items in undo history
T=1ms  User drags edge to split Cell A
T=2ms  normalizeBlocks() runs — destroys PM editor, recreates it with block data
T=2ms  ❌ Cursor position LOST, undo history LOST, selection LOST
```

**Scenario: Line-level splitting**

```
T=0ms  ContentSplitter uses Range API to find character offset for line break
T=1ms  Range API reports offset=47 in the DOM
T=2ms  Splitter tries to split InlineContent[] at offset 47
T=2ms  ❌ DOM offsets ≠ serialized InlineContent offsets (breaks, marks count differently)
T=2ms  Split happens at wrong position — text is cut mid-word or mid-mark
```

### 3.3 Why It's Fundamental

This isn't a bug to fix — it's an **architectural flaw**. The current design has two independent state machines (PM and LayoutTree) that both mutate the same data. Any synchronization scheme will have race conditions because:

- PM transactions are synchronous (keystroke → immediate state change)
- Overflow resolution is async (timer-based, multi-iteration)
- There's no locking mechanism between them
- `setContent()` is a blunt instrument that replaces ALL of PM's state

The fix requires rethinking who owns what. See Section 5.

---

## 4. Complete Gap Analysis

### 4.1 Critical — Blocks Basic Use

| # | Gap | Impact | Current State |
|---|-----|--------|---------------|
| 1 | **Two-Authority Problem** | Content loss during edit + layout | Architectural flaw, see Section 3 |
| 2 | **No Paragraph Rejoin** | Split text stays split even when cells have room | Stubbed at `OverflowResolver.ts` — `resolveUnderflow()` returns no changes |
| 3 | **No Layout Undo/Redo** | Accidental splits can't be undone | Only PM's per-cell undo works |
| 4 | **HTML Export Loses Layout** | BSP structure not preserved in exported HTML | Export is flat block sequence, no layout encoding |

### 4.2 Important — Expected in Any Real Editor

| # | Gap | Impact | Current State |
|---|-----|--------|---------------|
| 5 | **No Table Editing** | Tables render as tab-separated text, can't click cells | PM basic schema has no table nodes |
| 6 | **No Find & Replace** | No Ctrl+F across cells/pages | Not implemented |
| 7 | **No Spell Check** | No inline spelling corrections | Browser `spellcheck` attribute not enabled on PM editors |
| 8 | **No 2D Cell Navigation** | Can't arrow-key "right" into a side-by-side column | Navigation is flat reading-order sequence, not spatial |
| 9 | **OverflowWatcher Not Wired** | Overflow doesn't recheck on window resize | ResizeObserver exists but not connected to resolver |
| 10 | **No Code Highlighting** | Code blocks are plain monospace | `lowlight` package installed but not integrated |

### 4.3 Polish — Nice to Have

| # | Gap | Impact | Current State |
|---|-----|--------|---------------|
| 11 | **Link Editor UX** | Raw `prompt()` for URLs, no edit/unlink popover | Works but feels unfinished |
| 12 | **No Image Paste** | Can't Ctrl+V images from clipboard | Only toolbar file picker works |
| 13 | **No Image Resize** | Can't drag image corners to resize | Images are fixed-size |
| 14 | **No Document Outline** | No heading navigation sidebar | No sidebar exists at all |
| 15 | **No Page Margins/Headers** | Pages are fixed 816×1056px with no controls | Hardcoded dimensions |
| 16 | **No Tests** | Every refactor is high-risk | Zero test files in codebase |
| 17 | **No CI/CD** | Manual build process | No GitHub Actions or equivalent |

### 4.4 Dependency Notes

- `lowlight` (code highlighting) — installed, not integrated
- `turndown` (HTML→Markdown) — installed, not used anywhere in current code (dead dependency)
- `mammoth`, `jszip` — heavy but lazy-loaded via dynamic `import()` (good)
- All packages are current versions, no deprecated or EOL dependencies

---

## 5. The Content Stream Model

### 5.1 Core Concept

Replace the current "cells own blocks" model with "document owns blocks, cells view slices":

```
CURRENT (Two Authorities):
┌──────────┐     ┌──────────┐
│  Cell A   │     │  Cell B   │
│ blocks[]  │     │ blocks[]  │   ← Each cell owns its blocks independently
│ PM editor │     │ PM editor │   ← PM also owns content independently
└──────────┘     └──────────┘

PROPOSED (Content Stream):
┌─────────────────────────────────────────┐
│  Content Stream (single Block[] array)  │   ← One source of truth
│  [b0, b1, b2, b3, b4, b5, b6, b7, b8]  │
└─────────────────────────────────────────┘
       ▲              ▲              ▲
       │              │              │
  ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
  │ Cell A  │   │ Cell B  │   │ Cell C  │
  │ [0..3]  │   │ [3..6]  │   │ [6..9]  │  ← Views into slices
  │ PM view │   │ PM view │   │ PM view │  ← PM reads/writes to its slice
  └─────────┘   └─────────┘   └─────────┘
```

### 5.2 How It Eliminates the Two-Authority Problem

- **PM edits**: When user types in Cell B, PM's transaction writes back to the stream at offset 3. No other cell is affected.
- **Overflow**: Resolver reads the stream, computes new slice boundaries (e.g., Cell B now shows [3..5] instead of [3..6]). PM just re-renders its slice — no `setContent()`, no state replacement.
- **Rejoin**: When Cell B has space, its slice boundary extends (e.g., [3..7]). Content appears naturally.
- **No race condition**: PM owns the characters within its slice. Layout system owns the slice boundaries. They never touch each other's state.

### 5.3 What Needs to Change

| Component | Current | After Content Stream |
|-----------|---------|---------------------|
| Block ownership | Each LeafNode has `blocks[]` | Single `ContentStream` holds all blocks |
| Cell rendering | CellInstance reads own blocks | CellInstance reads slice from stream |
| PM sync | `setContent()` replaces all | PM syncs edits to stream offset |
| Overflow | Moves blocks between cells | Recomputes slice boundaries |
| Rejoin | Not implemented (stubbed) | Extends slice boundary naturally |
| Undo | PM-only, per cell | Stream-level undo for content + layout undo stack |

### 5.4 Design Considerations

**Stream ordering across BSP tree**: The stream must define a reading order for the BSP tree. For a horizontal split (top/bottom), top comes first. For vertical split (left/right), left comes first. This is a depth-first traversal of the tree.

**Block identity**: Each block needs a stable ID so that when slice boundaries shift, we can track which blocks moved where. The current `assignBlockIds()` system works for this.

**PM transaction interception**: When PM fires a transaction, we need to:
1. Extract the content change (insertions, deletions, replacements)
2. Map it to stream offsets
3. Apply it to the stream
4. NOT trigger a re-render of the originating cell (it already has the change)

**Pagination**: Pages are separate BSP trees. Content stream spans all pages. Page boundaries are just special slice boundaries.

---

## 6. HTML as Native Format

### 6.1 Why HTML IS the Native Format

TexEmEl is an HTML editor. The output IS HTML. Rather than inventing a proprietary `.texemel` format, the exported HTML should preserve everything — including BSP layout.

### 6.2 BSP Layout in HTML

A BSP tree maps naturally to nested CSS Flexbox:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="generator" content="TexEmEl">
  <style>
    .texemel-page {
      width: 816px; height: 1056px;
      display: flex; flex-direction: column;
      margin: 0 auto 24px auto;
      background: white;
    }
    .texemel-split-h { display: flex; flex-direction: column; }
    .texemel-split-v { display: flex; flex-direction: row; }
    .texemel-cell { padding: 24px; overflow: hidden; }
  </style>
</head>
<body>
  <!-- Page 1 -->
  <div class="texemel-page">
    <div class="texemel-split-h">
      <div class="texemel-split-v" style="flex: 0.6">
        <div class="texemel-cell" style="flex: 0.5">
          <h1>Title</h1>
          <p>Left column content...</p>
        </div>
        <div class="texemel-cell" style="flex: 0.5">
          <p>Right column content...</p>
        </div>
      </div>
      <div class="texemel-cell" style="flex: 0.4">
        <p>Bottom section content...</p>
      </div>
    </div>
  </div>

  <!-- Page 2 -->
  <div class="texemel-page">
    <div class="texemel-cell">
      <p>Page 2 content...</p>
    </div>
  </div>
</body>
</html>
```

### 6.3 Round-Trip Fidelity

**Export** (`HtmlExporter`): Walk the BSP tree, emit nested flex divs with `texemel-*` classes and flex ratios.

**Import** (`HtmlCodec`): Detect `texemel-page` structure → reconstruct BSP tree from the nesting. If no `texemel-*` classes found, fall back to current flat parsing (backwards compatible with non-TexEmEl HTML).

**Result**: Open an exported HTML in TexEmEl → same layout. Open it in a browser → looks correct. Open it in Word → content readable (flex containers degrade to block layout).

### 6.4 `.texemel` File Extension

Optionally register `.texemel` as a file association that maps to `text/html`. The file is still HTML — the extension just tells the OS to open it with TexEmEl. This gives:
- Double-click to open in TexEmEl
- Can still be renamed to `.html` and opened in any browser
- No proprietary format, no separate serialization

---

## 7. Refactor Roadmap

### Phase 1: Content Stream Foundation

**Goal**: Eliminate the two-authority problem. Make content flow trustworthy.

**Why this first**: Nothing else matters if the editor loses content. Users won't trust an editor that drops keystrokes.

| Step | Task | Files | Complexity |
|------|------|-------|-----------|
| 1.1 | Design `ContentStream` class — ordered block array with slice API | New: `src/core/layout/ContentStream.ts` | Medium |
| 1.2 | Add stable block IDs to stream (for tracking across slice changes) | `DocumentTree.ts`, `ContentStream.ts` | Low |
| 1.3 | Refactor `CellInstance` to read from stream slice instead of owning blocks | `CellInstance.ts`, `TextKernel.ts` | High |
| 1.4 | Refactor `OverflowResolver` to compute slice boundaries instead of moving blocks | `OverflowResolver.ts`, `ContentSplitter.ts` | High |
| 1.5 | Implement PM transaction → stream sync (edits write back at offset) | `TextKernel.ts`, `ContentStream.ts` | High |
| 1.6 | Wire `OverflowWatcher` (ResizeObserver) into the resolver loop | `OverflowWatcher.ts`, `LayoutDirector.ts` | Low |
| 1.7 | Implement paragraph rejoin (extend slice boundary when cells have space) | `OverflowResolver.ts` | Medium |

**Verification**: Type rapidly near overflow boundaries → no keystroke loss. Split/merge cells → no content loss. Resize window → overflow rechecks.

### Phase 2: Layout Operations

**Goal**: Make layout operations reversible and spatially aware.

**Why**: Accidental splits with no undo are frustrating. 2D navigation is expected in a cell-based layout.

| Step | Task | Files | Complexity |
|------|------|-------|-----------|
| 2.1 | Implement layout undo/redo stack (split, merge, resize as undoable operations) | New: `src/core/layout/LayoutHistory.ts`, `LayoutDirector.ts` | Medium |
| 2.2 | Implement 2D spatial navigation (arrow keys move to the visually correct neighbor) | `NavigationController.ts` | Medium |
| 2.3 | Wire Ctrl+Z to check: is this a layout op or a text op? Route to correct undo stack | `LayoutDirector.ts`, `TextKernel.ts` | Medium |

**Verification**: Split a cell → Ctrl+Z → cell un-splits. Arrow right from left column → cursor appears in right column.

### Phase 3: Core Editor Features

**Goal**: Meet baseline expectations for a text editor.

**Why**: Users won't adopt an editor that can't do Find & Replace or spell check, no matter how cool the layout system is.

| Step | Task | Files | Complexity |
|------|------|-------|-----------|
| 3.1 | Table editing — integrate `prosemirror-tables` extension | `TextKernel.ts` (schema), `Toolbar.tsx` | High |
| 3.2 | Find & Replace — search across all cells/pages, highlight matches | New: `src/core/editor/FindReplace.ts`, `Toolbar.tsx` or new component | Medium |
| 3.3 | Spell check — enable `spellcheck` attribute on PM contenteditable elements | `TextKernel.ts` | Low (1-2 lines) |
| 3.4 | Code block syntax highlighting — wire `lowlight` into PM's code block decoration | `TextKernel.ts` | Low-Medium |

**Verification**: Insert table → click cells, add rows/cols. Ctrl+F → type query → matches highlighted across pages. Misspelled word → red underline appears.

### Phase 4: HTML Layout Preservation

**Goal**: Make HTML the round-trip native format with full BSP layout fidelity.

**Why**: This is what makes TexEmEl self-sufficient. No proprietary format, no data lock-in, and the "save" operation just writes HTML.

| Step | Task | Files | Complexity |
|------|------|-------|-----------|
| 4.1 | Modify `HtmlExporter` to emit BSP layout as nested flex divs with `texemel-*` classes | `HtmlExporter.ts` | Medium |
| 4.2 | Modify `HtmlCodec` to detect and parse `texemel-*` layout structure back to BSP tree | `HtmlCodec.ts` | Medium |
| 4.3 | Implement "Save" (Ctrl+S) that writes current HTML with layout to disk | `useExport.ts`, `MenuBar.tsx` | Low |
| 4.4 | Auto-save on a timer (write to temp file, promote on explicit save) | New: `src/ui/hooks/useAutoSave.ts` | Low-Medium |
| 4.5 | Register `.texemel` file extension (HTML content, TexEmEl association) | `tauri.conf.json` | Low |

**Verification**: Create multi-cell layout → Save → Close → Open same file → identical layout. Open saved file in browser → looks correct. Rename to `.html` → opens in Word (content readable).

### Phase 5: Polish & Ship

**Goal**: Make it feel finished. Ship installers.

| Step | Task | Files | Complexity |
|------|------|-------|-----------|
| 5.1 | Image paste from clipboard | `TextKernel.ts` (paste handler) | Low-Medium |
| 5.2 | Image resize handles in editor | `TextKernel.ts` (node view) | Medium |
| 5.3 | Link editor popover (edit/unlink on click) | New component, `TextKernel.ts` | Medium |
| 5.4 | Document outline sidebar (heading navigation) | New: `src/ui/components/Sidebar.tsx` | Medium |
| 5.5 | Keyboard shortcuts panel | New component | Low |
| 5.6 | Page margin controls, headers/footers | `PageModel.ts`, `LayoutDirector.ts`, CSS | Medium |
| 5.7 | Unit tests for all codecs | New: `src/core/codecs/__tests__/` | Medium |
| 5.8 | Integration tests for content stream + overflow | New: `src/core/layout/__tests__/` | Medium |
| 5.9 | CI/CD pipeline (GitHub Actions: lint, typecheck, test, build) | New: `.github/workflows/` | Low |
| 5.10 | Auto-update via Tauri updater plugin | `src-tauri/`, `tauri.conf.json` | Medium |
| 5.11 | Platform installers (Windows .msi, macOS .dmg, Linux .AppImage) | Build config | Low |
| 5.12 | Remove dead dependencies (`turndown` — unused) | `package.json` | Trivial |

---

## 8. File-by-File Change Map

### New Files to Create

| File | Purpose | Phase |
|------|---------|-------|
| `src/core/layout/ContentStream.ts` | Single source of truth for document blocks | 1 |
| `src/core/layout/LayoutHistory.ts` | Undo/redo stack for layout operations | 2 |
| `src/core/editor/FindReplace.ts` | Cross-cell find & replace | 3 |
| `src/ui/hooks/useAutoSave.ts` | Timer-based auto-save | 4 |
| `src/ui/components/Sidebar.tsx` | Document outline navigation | 5 |

### Existing Files to Modify

| File | Current LOC | Change | Phase |
|------|------------|--------|-------|
| `src/core/layout/LayoutDirector.ts` | 1,049 | Refactor to use ContentStream; wire OverflowWatcher; integrate layout history | 1, 2 |
| `src/core/layout/OverflowResolver.ts` | ~200 | Replace block-moving with slice-boundary computation; implement rejoin | 1 |
| `src/core/layout/ContentSplitter.ts` | ~150 | Adapt to work with stream offsets instead of block arrays | 1 |
| `src/core/layout/CellInstance.ts` | 218 | Read from stream slice instead of owning blocks | 1 |
| `src/core/layout/TextKernel.ts` | 968 | PM transaction → stream sync; spellcheck attr; table schema; code highlighting | 1, 3 |
| `src/core/layout/OverflowWatcher.ts` | ~50 | Wire ResizeObserver into overflow resolution loop | 1 |
| `src/core/layout/NavigationController.ts` | ~100 | Add 2D spatial neighbor detection | 2 |
| `src/core/export/HtmlExporter.ts` | 254 | Emit BSP layout as nested flex divs | 4 |
| `src/core/codecs/HtmlCodec.ts` | 323 | Detect and parse `texemel-*` layout structure | 4 |
| `src/ui/components/Toolbar.tsx` | 612 | Table editing controls, find/replace trigger | 3 |
| `src/ui/components/MenuBar.tsx` | 155 | Save (Ctrl+S) that preserves layout | 4 |
| `src/ui/hooks/useExport.ts` | ~80 | Save-with-layout function | 4 |
| `src-tauri/tauri.conf.json` | — | Add `.texemel` file association | 4 |

### Files That Stay Unchanged

| File | Why |
|------|-----|
| `src/core/model/DocumentTree.ts` | Model is solid, no changes needed |
| `src/core/codecs/TxtCodec.ts` | Complete |
| `src/core/codecs/MarkdownCodec.ts` | Complete |
| `src/core/codecs/DocxCodec.ts` | Complete |
| `src/core/codecs/OdtCodec.ts` | Complete |
| `src/core/codecs/RtfCodec.ts` | Complete |
| `src/core/codecs/EpubCodec.ts` | Complete |
| `src/core/codecs/CodecRegistry.ts` | Complete |
| `src/core/export/MarkdownExporter.ts` | Complete |
| `src/core/export/RtfExporter.ts` | Complete |
| `src/core/export/TxtExporter.ts` | Complete |
| `src/core/layout/LayoutTree.ts` | BSP model is solid |
| `src/core/layout/LayoutReconciler.ts` | DOM diffing is solid |
| `src/core/layout/PageModel.ts` | Page model is solid |
| `src/core/layout/CellPool.ts` | Pool pattern is solid, minor adaptation only |
| `src/core/layout/EdgeSplitManager.ts` | Polished interaction |
| `src/core/layout/SplitResizeManager.ts` | Works correctly |
| All CSS files | Clean, well-structured |

---

## 9. Verification & Testing Strategy

### 9.1 Manual Verification After Each Phase

**Phase 1 (Content Stream)**:
- [ ] Open a 10-page DOCX → all content renders across pages
- [ ] Type rapidly at overflow boundary → no keystrokes lost
- [ ] Split a cell with content → content redistributes correctly
- [ ] Merge two cells → all content preserved
- [ ] Resize a cell smaller → overflow flows to next cell
- [ ] Resize a cell larger → content flows BACK (rejoin works)
- [ ] Resize browser window → overflow rechecks

**Phase 2 (Layout Operations)**:
- [ ] Split cell → Ctrl+Z → cell un-splits, content restored
- [ ] Resize cell → Ctrl+Z → ratio restored
- [ ] Arrow right from left column → cursor in right column at same vertical position
- [ ] Arrow down from top cell → cursor in bottom cell at same horizontal position

**Phase 3 (Editor Features)**:
- [ ] Insert 3×3 table → click any cell → type → works
- [ ] Add row/column to table → content preserved
- [ ] Ctrl+F → type query → matches highlighted across all cells/pages
- [ ] Replace all → works across cells
- [ ] Type misspelled word → red underline from browser spellcheck
- [ ] Paste code block with language → syntax highlighted

**Phase 4 (HTML Native Format)**:
- [ ] Create multi-cell layout with content → Save as HTML
- [ ] Open saved HTML in browser → layout renders correctly
- [ ] Open saved HTML in TexEmEl → identical layout restored
- [ ] Open saved HTML in Word → content readable (layout may degrade)
- [ ] Ctrl+S saves to disk, Ctrl+Shift+S for Save As

### 9.2 Automated Test Strategy (Phase 5)

**Codec Unit Tests** (parse known input → assert DocumentTree):
- One test file per codec with edge cases
- Test: empty input, large input, malformed input, format-specific quirks
- Test: images extracted as base64, tables parsed with correct structure

**Content Stream Tests**:
- Test: insert/delete/replace at various offsets
- Test: slice boundary computation after overflow
- Test: rejoin when space opens up
- Test: concurrent edit + overflow (the race condition)

**Layout Tests**:
- Test: split/merge/resize produce correct tree structure
- Test: undo/redo restores exact previous state
- Test: spatial navigation finds correct neighbors

**Export Round-Trip Tests**:
- Test: create layout → export HTML → re-import → assert same BSP structure
- Test: export without layout → re-import → single cell (backwards compatible)
