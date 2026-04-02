// ============================================================================
// DocumentTree — The canonical document model for TexSaur
//
// Every imported format is parsed into this structure.
// The editor operates on it. Exporters read from it.
// This file has ZERO external dependencies.
// ============================================================================

// --- Document Root ---

export interface DocumentTree {
  blocks: Block[];
  metadata: DocumentMetadata;
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  sourceFormat?: string;
  sourceFileName?: string;
  /** BSP layout data from TexElEm HTML import — used to restore page/cell structure */
  layoutPages?: LayoutPageData[];
}

/** Serialized page layout from TexElEm HTML round-trip */
export interface LayoutPageData {
  id: string;
  layout: LayoutNodeData;
}

/** Serialized BSP node */
export type LayoutNodeData =
  | { type: 'leaf'; id: string; blocks: Block[] }
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; ratio: number; first: LayoutNodeData; second: LayoutNodeData };

// --- Layout / Container ---

export interface ContainerStyle {
  padding?: BoxSpacing;
  margin?: BoxSpacing;
  width?: string;       // e.g. '100%', '300px', 'auto'
  height?: string;
  position?: 'static' | 'relative' | 'absolute';
  top?: string;
  left?: string;
  display?: 'block' | 'flex' | 'inline-block';
  flexDirection?: 'row' | 'column';
  flexWrap?: 'nowrap' | 'wrap';
  gap?: string;
  alignItems?: string;
  justifyContent?: string;
}

export interface BoxSpacing {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

// --- Block Types ---

export type Block =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | TableBlock
  | ImageBlock
  | CodeBlock
  | BlockquoteBlock
  | DividerBlock
  | ContainerBlock;

export type BlockType = Block['type'];

/** Base properties shared by all blocks */
export interface BlockBase {
  /** Stable unique ID — assigned by BlockEngine, persisted in .texsaur saves */
  id?: string;
  /** Optional layout/styling for the block's wrapper div */
  containerStyle?: ContainerStyle;
  /** Tracks split paragraphs for pagination — both halves share the same splitId */
  splitId?: string;
  /** Which half of a split paragraph this is */
  splitPart?: 'top' | 'bottom';
  /**
   * Lossless ProseMirror document JSON snapshot.
   * When present, TextKernel restores from this instead of the lossy InlineContent[].
   * Set by syncLiveContentToTree() before structural operations (split, merge).
   * Stripped on export to keep DocumentTree format-agnostic.
   */
  pmDocJson?: Record<string, unknown>;
}

export interface ParagraphBlock extends BlockBase {
  type: 'paragraph';
  content: InlineContent[];
  alignment?: TextAlignment;
}

export interface HeadingBlock extends BlockBase {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  content: InlineContent[];
  alignment?: TextAlignment;
}

export interface ListBlock extends BlockBase {
  type: 'list';
  ordered: boolean;
  items: ListItem[];
}

export interface ListItem {
  id?: string;
  content: InlineContent[];
  checked?: boolean;
  children?: ListBlock;
}

export interface TableBlock extends BlockBase {
  type: 'table';
  headers: TableCell[];
  rows: TableCell[][];
}

export interface TableCell {
  content: InlineContent[];
  colspan?: number;
  rowspan?: number;
}

export type ImageAlignment = 'inline' | 'center' | 'float-left' | 'float-right';

export interface ImageBlock extends BlockBase {
  type: 'image';
  src: string;
  alt?: string;
  title?: string;
  width?: number;
  height?: number;
  alignment?: ImageAlignment;
}

export interface CodeBlock extends BlockBase {
  type: 'codeBlock';
  language?: string;
  code: string;
}

export interface BlockquoteBlock extends BlockBase {
  type: 'blockquote';
  blocks: Block[];
}

export interface DividerBlock extends BlockBase {
  type: 'divider';
}

export interface ContainerBlock extends BlockBase {
  type: 'container';
  children: Block[];
  layout?: 'flow' | 'flex-row' | 'flex-column';
}

// --- Inline Content ---

export type InlineContent =
  | TextInline
  | LinkInline
  | ImageInline
  | CodeInline
  | BreakInline;

export type InlineType = InlineContent['type'];

export interface TextInline {
  type: 'text';
  text: string;
  marks?: TextMark[];
}

export interface LinkInline {
  type: 'link';
  href: string;
  title?: string;
  content: InlineContent[];
}

export interface ImageInline {
  type: 'image';
  src: string;
  alt?: string;
}

export interface CodeInline {
  type: 'code';
  text: string;
}

export interface BreakInline {
  type: 'break';
}

// --- Text Marks ---

export type TextMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'underline' }
  | { type: 'strikethrough' }
  | { type: 'code' }
  | { type: 'highlight'; color?: string }
  | { type: 'color'; color: string }
  | { type: 'superscript' }
  | { type: 'subscript' }
  | { type: 'fontFamily'; family: string }
  | { type: 'fontSize'; size: string }
  | { type: 'link'; href: string; title?: string };

export type TextMarkType = TextMark['type'];

// --- Enums ---

export type TextAlignment = 'left' | 'center' | 'right' | 'justify';

// --- Factory Helpers ---

export function createEmptyDocument(title?: string): DocumentTree {
  return {
    blocks: [
      {
        type: 'paragraph',
        content: [],
      },
    ],
    metadata: {
      title: title ?? 'Untitled',
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
    },
  };
}

export function createTextInline(text: string, marks?: TextMark[]): TextInline {
  return { type: 'text', text, marks };
}

export function createParagraph(text: string): ParagraphBlock {
  return {
    type: 'paragraph',
    content: text ? [createTextInline(text)] : [],
  };
}

export function createHeading(level: HeadingBlock['level'], text: string): HeadingBlock {
  return {
    type: 'heading',
    level,
    content: [createTextInline(text)],
  };
}
