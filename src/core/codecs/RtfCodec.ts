import type { FormatCodec } from './CodecRegistry';
import type {
  DocumentTree,
  Block,
  InlineContent,
  TextMark,
} from '../model/DocumentTree';

// RTF Codec — parses Rich Text Format into DocumentTree
// Handles: paragraphs, bold, italic, underline, strikethrough, font size, colors
// Uses a simple token-based parser for the {\rtf1 ...} structure

export const rtfCodec: FormatCodec = {
  id: 'rtf',
  name: 'Rich Text Format',
  extensions: ['rtf'],
  mimeTypes: ['application/rtf', 'text/rtf'],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    const text = new TextDecoder('latin1').decode(buffer);
    const blocks = parseRtf(text);

    let title = fileName?.replace(/\.[^.]+$/, '') ?? 'Untitled';
    const firstHeading = blocks.find((b) => b.type === 'heading');
    if (firstHeading && firstHeading.type === 'heading') {
      const t = firstHeading.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text).join('');
      if (t) title = t;
    }

    return {
      blocks: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [] }],
      metadata: { title, sourceFormat: 'rtf', sourceFileName: fileName, modifiedAt: new Date().toISOString() },
    };
  },
};

// --- RTF Tokenizer ---

interface RtfState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  fontSize: number;
  unicode: boolean;
}

function defaultState(): RtfState {
  return { bold: false, italic: false, underline: false, strike: false, fontSize: 24, unicode: false };
}

function stateToMarks(state: RtfState): TextMark[] | undefined {
  const marks: TextMark[] = [];
  if (state.bold) marks.push({ type: 'bold' });
  if (state.italic) marks.push({ type: 'italic' });
  if (state.underline) marks.push({ type: 'underline' });
  if (state.strike) marks.push({ type: 'strikethrough' });
  return marks.length > 0 ? marks : undefined;
}

function parseRtf(rtf: string): Block[] {
  const blocks: Block[] = [];
  let currentInlines: InlineContent[] = [];
  let currentText = '';
  const stateStack: RtfState[] = [];
  let state = defaultState();
  let i = 0;
  let skipDestination = 0;

  function flushText() {
    if (currentText) {
      currentInlines.push({ type: 'text', text: currentText, marks: stateToMarks(state) });
      currentText = '';
    }
  }

  function flushParagraph() {
    flushText();
    if (currentInlines.length > 0) {
      // Detect headings by large font size (>= 28 half-points = 14pt)
      const isLargeFont = state.fontSize >= 32;
      if (isLargeFont && currentInlines.length <= 5) {
        const level = state.fontSize >= 48 ? 1 : state.fontSize >= 36 ? 2 : 3;
        blocks.push({ type: 'heading', level: level as 1|2|3, content: currentInlines });
      } else {
        blocks.push({ type: 'paragraph', content: currentInlines });
      }
      currentInlines = [];
    }
  }

  while (i < rtf.length) {
    const ch = rtf[i];

    if (ch === '{') {
      if (skipDestination > 0) {
        skipDestination++;
        i++;
        continue;
      }
      stateStack.push({ ...state });
      i++;
      continue;
    }

    if (ch === '}') {
      if (skipDestination > 0) {
        skipDestination--;
        i++;
        continue;
      }
      flushText();
      if (stateStack.length > 0) {
        state = stateStack.pop()!;
      }
      i++;
      continue;
    }

    if (skipDestination > 0) {
      i++;
      continue;
    }

    if (ch === '\\') {
      i++;
      if (i >= rtf.length) break;

      const next = rtf[i];

      // Escaped characters
      if (next === '\\' || next === '{' || next === '}') {
        currentText += next;
        i++;
        continue;
      }

      // Unicode character: \uN
      if (next === 'u' && /\d/.test(rtf[i + 1] ?? '')) {
        i++;
        let numStr = '';
        while (i < rtf.length && /[\d-]/.test(rtf[i])) {
          numStr += rtf[i];
          i++;
        }
        const code = parseInt(numStr);
        if (!isNaN(code)) {
          currentText += code < 0 ? String.fromCharCode(code + 65536) : String.fromCharCode(code);
        }
        // Skip replacement character
        if (i < rtf.length && rtf[i] === '?') i++;
        continue;
      }

      // Hex character: \'XX
      if (next === "'") {
        i++;
        const hex = rtf.substring(i, i + 2);
        i += 2;
        const code = parseInt(hex, 16);
        if (!isNaN(code)) {
          currentText += String.fromCharCode(code);
        }
        continue;
      }

      // Newline shortcuts
      if (next === '\n' || next === '\r') {
        flushParagraph();
        i++;
        continue;
      }

      // Control word
      let word = '';
      while (i < rtf.length && /[a-zA-Z]/.test(rtf[i])) {
        word += rtf[i];
        i++;
      }

      // Optional numeric parameter
      let param = '';
      if (i < rtf.length && (rtf[i] === '-' || /\d/.test(rtf[i]))) {
        if (rtf[i] === '-') { param += '-'; i++; }
        while (i < rtf.length && /\d/.test(rtf[i])) {
          param += rtf[i];
          i++;
        }
      }

      // Skip trailing space after control word
      if (i < rtf.length && rtf[i] === ' ') i++;

      const paramNum = param ? parseInt(param) : undefined;

      // Process control word
      switch (word) {
        case 'par':
        case 'line':
          flushParagraph();
          break;
        case 'b':
          flushText();
          state.bold = paramNum !== 0;
          break;
        case 'i':
          flushText();
          state.italic = paramNum !== 0;
          break;
        case 'ul':
        case 'uld':
        case 'uldb':
          flushText();
          state.underline = true;
          break;
        case 'ulnone':
          flushText();
          state.underline = false;
          break;
        case 'strike':
          flushText();
          state.strike = paramNum !== 0;
          break;
        case 'fs':
          flushText();
          if (paramNum !== undefined) state.fontSize = paramNum;
          break;
        case 'tab':
          currentText += '\t';
          break;
        case 'emdash':
          currentText += '\u2014';
          break;
        case 'endash':
          currentText += '\u2013';
          break;
        case 'bullet':
          currentText += '\u2022';
          break;
        case 'lquote':
          currentText += '\u2018';
          break;
        case 'rquote':
          currentText += '\u2019';
          break;
        case 'ldblquote':
          currentText += '\u201C';
          break;
        case 'rdblquote':
          currentText += '\u201D';
          break;
        case 'pard':
          // Reset paragraph formatting
          flushText();
          state.bold = false;
          state.italic = false;
          state.underline = false;
          state.strike = false;
          state.fontSize = 24;
          break;
        // Skip destination groups we don't need
        case 'fonttbl':
        case 'colortbl':
        case 'stylesheet':
        case 'info':
        case 'pict':
        case 'object':
        case 'header':
        case 'footer':
        case 'headerl':
        case 'headerr':
        case 'footerl':
        case 'footerr':
        case 'footnote':
          skipDestination = 1;
          break;
        case 'rtf':
          // Document header — skip
          break;
        default:
          // Unknown control word — ignore
          break;
      }
      continue;
    }

    // Skip \r\n outside control words
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    // Plain text
    currentText += ch;
    i++;
  }

  flushParagraph();
  return blocks;
}
