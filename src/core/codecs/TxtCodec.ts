import type { FormatCodec } from './CodecRegistry';
import type { DocumentTree } from '../model/DocumentTree';
import { createParagraph } from '../model/DocumentTree';

export const txtCodec: FormatCodec = {
  id: 'txt',
  name: 'Plain Text',
  extensions: ['txt', 'text', 'log'],
  mimeTypes: ['text/plain'],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    const text = new TextDecoder('utf-8').decode(buffer);
    const paragraphs = text.split(/\n\n+/);

    return {
      blocks: paragraphs
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .map((p) => createParagraph(p)),
      metadata: {
        title: fileName?.replace(/\.[^.]+$/, '') ?? 'Untitled',
        sourceFormat: 'txt',
        sourceFileName: fileName,
        modifiedAt: new Date().toISOString(),
      },
    };
  },
};
