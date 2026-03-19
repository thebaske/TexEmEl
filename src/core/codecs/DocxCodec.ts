import type { FormatCodec } from './CodecRegistry';
import type { DocumentTree } from '../model/DocumentTree';

// DOCX Codec — uses mammoth.js to convert DOCX → HTML, then parses HTML into DocumentTree
// mammoth handles: paragraphs, headings, bold, italic, lists, tables, images, links
// Depends on: mammoth (npm), HtmlCodec for HTML → DocumentTree conversion

export const docxCodec: FormatCodec = {
  id: 'docx',
  name: 'Microsoft Word Document',
  extensions: ['docx', 'docm'],
  mimeTypes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    // Dynamic import to keep mammoth out of initial bundle
    const mammoth = await import('mammoth');

    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      {
        convertImage: mammoth.images.imgElement((image) => {
          // Convert images to base64 data URIs
          return image.read('base64').then((imageBuffer) => {
            const mimeType = image.contentType || 'image/png';
            return { src: `data:${mimeType};base64,${imageBuffer}` };
          });
        }),
      },
    );

    // Parse the HTML output into DocumentTree using HtmlCodec's parser
    // This avoids duplicating HTML → DocumentTree logic
    const { htmlCodec } = await import('./HtmlCodec');
    const htmlBuffer = new TextEncoder().encode(result.value);
    const tree = await htmlCodec.parse(htmlBuffer.buffer, fileName);

    // Override metadata for DOCX source
    tree.metadata.sourceFormat = 'docx';
    tree.metadata.sourceFileName = fileName;

    return tree;
  },
};
