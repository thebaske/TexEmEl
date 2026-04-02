// ============================================================================
// ContentSplitter — Split content at block or line boundaries
//
// Used for:
// 1. Overflow resolution — split content that exceeds cell/page boundaries
// 2. User-initiated splits — partition content above/below a split point
//
// Handles mid-paragraph splitting by partitioning InlineContent[] arrays
// and tracking split halves via splitId for later rejoin.
// ============================================================================

import type { Block, InlineContent, TextInline, ParagraphBlock, HeadingBlock } from '../model/DocumentTree';
import type { OverflowInfo, LineBreakInfo } from './OverflowDetector';
import { generateBlockId } from '../model/BlockId';

// --- Types ---

export interface SplitResult {
  /** Blocks that stay in the current cell */
  fitting: Block[];
  /** Blocks that overflow to the next cell/page */
  overflow: Block[];
}

// --- Content Splitter ---

export class ContentSplitter {
  /**
   * Split blocks based on overflow detection results.
   * Handles both block-level and mid-paragraph splits.
   */
  splitOnOverflow(blocks: Block[], overflowInfo: OverflowInfo): SplitResult {
    if (!overflowInfo.hasOverflow) {
      return { fitting: [...blocks], overflow: [] };
    }

    const { lastFittingBlockIndex, lineBreak } = overflowInfo;

    if (lineBreak) {
      return this.splitWithLineBreak(blocks, lastFittingBlockIndex, lineBreak);
    }

    // Block-level split
    return this.splitAtBlockIndex(blocks, lastFittingBlockIndex);
  }

  /**
   * Split blocks at a block boundary.
   * Blocks 0..lastFitting stay; blocks (lastFitting+1).. overflow.
   */
  splitAtBlockIndex(blocks: Block[], lastFittingIndex: number): SplitResult {
    if (lastFittingIndex < 0) {
      // Nothing fits — all blocks overflow (except we keep one to prevent empty cell)
      // Guard: if the first block alone is too big, clip it (keep it, overflow the rest)
      return {
        fitting: blocks.length > 0 ? [blocks[0]] : [],
        overflow: blocks.slice(1),
      };
    }

    return {
      fitting: blocks.slice(0, lastFittingIndex + 1),
      overflow: blocks.slice(lastFittingIndex + 1),
    };
  }

  /**
   * Split with a mid-paragraph break.
   * The paragraph at lineBreak.blockIndex is split at the character offset.
   */
  private splitWithLineBreak(
    blocks: Block[],
    lastFittingBlockIndex: number,
    lineBreak: LineBreakInfo,
  ): SplitResult {
    const { blockIndex, charOffset } = lineBreak;
    const block = blocks[blockIndex];

    // Only split paragraph and heading blocks
    if (block.type !== 'paragraph' && block.type !== 'heading') {
      return this.splitAtBlockIndex(blocks, lastFittingBlockIndex);
    }

    const { topHalf, bottomHalf } = this.splitParagraph(block, charOffset);

    const fitting = [
      ...blocks.slice(0, blockIndex),
      topHalf,
    ];

    const overflow = [
      bottomHalf,
      ...blocks.slice(blockIndex + 1),
    ];

    return { fitting, overflow };
  }

  /**
   * Split a paragraph or heading block at a character offset.
   * Both halves share a splitId for potential rejoin later.
   */
  splitParagraph(
    block: ParagraphBlock | HeadingBlock,
    charOffset: number,
  ): { topHalf: Block; bottomHalf: Block } {
    const splitId = block.splitId ?? generateBlockId();
    const content = block.content;

    const { before, after } = splitInlineContent(content, charOffset);

    if (block.type === 'paragraph') {
      return {
        topHalf: {
          ...block,
          id: block.id,
          content: before,
          splitId,
          splitPart: 'top',
        } as ParagraphBlock,
        bottomHalf: {
          ...block,
          id: generateBlockId(),
          content: after,
          splitId,
          splitPart: 'bottom',
        } as ParagraphBlock,
      };
    }

    // Heading: top half keeps heading type, bottom becomes paragraph
    return {
      topHalf: {
        ...block,
        id: block.id,
        content: before,
        splitId,
        splitPart: 'top',
      } as HeadingBlock,
      bottomHalf: {
        type: 'paragraph',
        id: generateBlockId(),
        content: after,
        alignment: block.alignment,
        splitId,
        splitPart: 'bottom',
        containerStyle: block.containerStyle,
      } as ParagraphBlock,
    };
  }

  /**
   * Rejoin two blocks that were previously split.
   * Returns the merged block, or null if they can't be rejoined.
   */
  rejoinParagraphs(top: Block, bottom: Block): Block | null {
    if (!top.splitId || !bottom.splitId) return null;
    if (top.splitId !== bottom.splitId) return null;
    if (top.splitPart !== 'top' || bottom.splitPart !== 'bottom') return null;

    // Both must be text blocks
    if ((top.type !== 'paragraph' && top.type !== 'heading') ||
        (bottom.type !== 'paragraph' && bottom.type !== 'heading')) {
      return null;
    }

    const topBlock = top as ParagraphBlock | HeadingBlock;
    const bottomBlock = bottom as ParagraphBlock | HeadingBlock;

    // Merge content, keep original block type
    const merged = {
      ...topBlock,
      content: [...topBlock.content, ...bottomBlock.content],
      splitId: undefined,
      splitPart: undefined,
    };

    return merged as Block;
  }

}

// --- Inline Content Splitting Utilities ---

/**
 * Split an InlineContent[] array at a character offset.
 * Preserves formatting marks across the split.
 */
function splitInlineContent(
  content: InlineContent[],
  charOffset: number,
): { before: InlineContent[]; after: InlineContent[] } {
  const before: InlineContent[] = [];
  const after: InlineContent[] = [];
  let consumed = 0;
  let splitDone = false;

  for (const inline of content) {
    if (splitDone) {
      after.push(inline);
      continue;
    }

    if (inline.type === 'text') {
      const textLen = inline.text.length;

      if (consumed + textLen <= charOffset) {
        // Entire text inline is before the split
        before.push(inline);
        consumed += textLen;
      } else if (consumed >= charOffset) {
        // Entire text inline is after the split
        after.push(inline);
        splitDone = true;
      } else {
        // Split falls within this text inline
        const splitAt = charOffset - consumed;
        const beforeText = inline.text.slice(0, splitAt);
        const afterText = inline.text.slice(splitAt);

        if (beforeText) {
          before.push({ ...inline, text: beforeText } as TextInline);
        }
        if (afterText) {
          after.push({ ...inline, text: afterText } as TextInline);
        }

        consumed += textLen;
        splitDone = true;
      }
    } else if (inline.type === 'break') {
      if (consumed >= charOffset) {
        after.push(inline);
        splitDone = true;
      } else {
        before.push(inline);
        consumed += 1; // breaks count as 1 character
      }
    } else {
      // Links, images, code — treat as atomic
      // Approximate character count for offset purposes
      const approxLen = inline.type === 'link'
        ? (inline.content?.reduce((sum: number, c: InlineContent) =>
            sum + (c.type === 'text' ? c.text.length : 1), 0) ?? 1)
        : inline.type === 'code' ? inline.text.length : 1;

      if (consumed + approxLen <= charOffset) {
        before.push(inline);
        consumed += approxLen;
      } else {
        after.push(inline);
        splitDone = true;
      }
    }
  }

  // Ensure we always have content in before (prevent empty cells)
  if (before.length === 0 && content.length > 0) {
    before.push(content[0]);
    after.splice(0, after.length, ...content.slice(1).filter(c => !after.includes(c)));
  }

  return { before, after };
}
