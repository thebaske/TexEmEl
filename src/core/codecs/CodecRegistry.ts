import type { DocumentTree } from '../model/DocumentTree';

// ============================================================================
// FormatCodec — Interface that every format parser implements
// ============================================================================

export interface FormatCodec {
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

// ============================================================================
// Magic byte signatures for format detection
// ============================================================================

const MAGIC_BYTES: Array<{ signature: number[]; offset: number; format: string }> = [
  // ZIP-based formats (DOCX, ODT, EPUB) — PK\x03\x04
  { signature: [0x50, 0x4b, 0x03, 0x04], offset: 0, format: 'zip' },
  // RTF — {\rtf
  { signature: [0x7b, 0x5c, 0x72, 0x74, 0x66], offset: 0, format: 'rtf' },
];

function detectMagicBytes(buffer: ArrayBuffer): string | undefined {
  const view = new Uint8Array(buffer);
  for (const { signature, offset, format } of MAGIC_BYTES) {
    if (view.length < offset + signature.length) continue;
    const match = signature.every((byte, i) => view[offset + i] === byte);
    if (match) return format;
  }
  return undefined;
}

// ============================================================================
// CodecRegistry — Central registry for all format codecs
// ============================================================================

export class CodecRegistry {
  private codecs: Map<string, FormatCodec> = new Map();
  private extensionMap: Map<string, string> = new Map();
  private mimeMap: Map<string, string> = new Map();

  register(codec: FormatCodec): void {
    this.codecs.set(codec.id, codec);
    for (const ext of codec.extensions) {
      this.extensionMap.set(ext.toLowerCase(), codec.id);
    }
    for (const mime of codec.mimeTypes) {
      this.mimeMap.set(mime.toLowerCase(), codec.id);
    }
  }

  getById(id: string): FormatCodec | undefined {
    return this.codecs.get(id);
  }

  getByExtension(ext: string): FormatCodec | undefined {
    const normalized = ext.toLowerCase().replace(/^\./, '');
    const id = this.extensionMap.get(normalized);
    return id ? this.codecs.get(id) : undefined;
  }

  getByMimeType(mime: string): FormatCodec | undefined {
    const id = this.mimeMap.get(mime.toLowerCase());
    return id ? this.codecs.get(id) : undefined;
  }

  detect(buffer: ArrayBuffer, fileName?: string): FormatCodec | undefined {
    // 1. Try file extension
    if (fileName) {
      const ext = fileName.split('.').pop();
      if (ext) {
        const codec = this.getByExtension(ext);
        if (codec) return codec;
      }
    }

    // 2. Try magic bytes
    const magic = detectMagicBytes(buffer);
    if (magic === 'zip') {
      // ZIP-based: try docx first, then odt, then epub
      for (const id of ['docx', 'odt', 'epub']) {
        const codec = this.codecs.get(id);
        if (codec) return codec;
      }
    }
    if (magic === 'rtf') {
      return this.codecs.get('rtf');
    }

    // 3. Try as text (HTML or plain text)
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.slice(0, 1000));
      if (text.trimStart().startsWith('<') || text.trimStart().startsWith('<!')) {
        return this.codecs.get('html');
      }
      if (text.startsWith('{') || text.startsWith('[')) {
        return this.codecs.get('json');
      }
      // Check for markdown indicators
      if (/^#{1,6}\s/m.test(text) || /^\s*[-*+]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)) {
        return this.codecs.get('markdown');
      }
    } catch {
      // Not valid UTF-8
    }

    // 4. Fallback to plain text
    return this.codecs.get('txt');
  }

  getSupportedExtensions(): string[] {
    return Array.from(this.extensionMap.keys()).sort();
  }

  getAll(): FormatCodec[] {
    return Array.from(this.codecs.values());
  }
}

// Singleton registry
export const codecRegistry = new CodecRegistry();
