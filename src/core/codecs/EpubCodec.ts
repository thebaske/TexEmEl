import type { FormatCodec } from './CodecRegistry';
import type { DocumentTree, Block } from '../model/DocumentTree';

// EPUB Codec — parses EPUB files into DocumentTree
// EPUB is a ZIP archive containing XHTML chapters
// Uses JSZip to extract, parses spine order from content.opf,
// concatenates chapter HTML, then delegates to HtmlCodec

export const epubCodec: FormatCodec = {
  id: 'epub',
  name: 'EPUB eBook',
  extensions: ['epub'],
  mimeTypes: ['application/epub+zip'],

  async parse(buffer: ArrayBuffer, fileName?: string): Promise<DocumentTree> {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buffer);

    // 1. Find container.xml to locate the OPF file
    const containerXml = await zip.file('META-INF/container.xml')?.async('string');
    let opfPath = 'OEBPS/content.opf'; // default fallback

    if (containerXml) {
      const containerParser = new DOMParser();
      const containerDoc = containerParser.parseFromString(containerXml, 'application/xml');
      const rootfile = containerDoc.querySelector('rootfile');
      if (rootfile) {
        opfPath = rootfile.getAttribute('full-path') ?? opfPath;
      }
    }

    // 2. Parse the OPF file
    const opfContent = await zip.file(opfPath)?.async('string');
    if (!opfContent) {
      return emptyResult(fileName);
    }

    const opfParser = new DOMParser();
    const opfDoc = opfParser.parseFromString(opfContent, 'application/xml');
    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    // Extract title from metadata
    let title = fileName?.replace(/\.[^.]+$/, '') ?? 'Untitled';
    const titleEl = opfDoc.querySelector('metadata title') ??
      opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
    if (titleEl?.textContent) title = titleEl.textContent;

    // Build manifest map: id → href
    const manifest = new Map<string, string>();
    const manifestItems = opfDoc.querySelectorAll('manifest item');
    for (let i = 0; i < manifestItems.length; i++) {
      const item = manifestItems[i];
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id && href) manifest.set(id, href);
    }

    // Get spine order (list of manifest item IDs in reading order)
    const spineItems: string[] = [];
    const spineRefs = opfDoc.querySelectorAll('spine itemref');
    for (let i = 0; i < spineRefs.length; i++) {
      const idref = spineRefs[i].getAttribute('idref');
      if (idref) spineItems.push(idref);
    }

    // 3. Extract images for base64 embedding
    const images = new Map<string, string>();
    for (const [, href] of manifest) {
      const fullPath = opfDir + href;
      const ext = href.split('.').pop()?.toLowerCase() ?? '';
      if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
        const data = await zip.file(fullPath)?.async('base64');
        if (data) {
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'svg' ? 'image/svg+xml'
            : `image/${ext}`;
          images.set(href, `data:${mime};base64,${data}`);
          // Also store with full path
          images.set(fullPath, `data:${mime};base64,${data}`);
        }
      }
    }

    // 4. Read chapters in spine order, parse each as HTML
    const { htmlCodec } = await import('./HtmlCodec');
    const allBlocks: Block[] = [];

    for (const itemId of spineItems) {
      const href = manifest.get(itemId);
      if (!href) continue;

      const fullPath = opfDir + href;
      let chapterHtml = await zip.file(fullPath)?.async('string');
      if (!chapterHtml) continue;

      // Replace image src references with base64 data URIs
      chapterHtml = chapterHtml.replace(
        /src=["']([^"']+)["']/g,
        (_match, src: string) => {
          const resolved = images.get(src) ?? images.get(opfDir + src);
          return resolved ? `src="${resolved}"` : `src="${src}"`;
        },
      );

      const chapterBuffer = new TextEncoder().encode(chapterHtml).buffer as ArrayBuffer;
      const chapterTree = await htmlCodec.parse(chapterBuffer);

      // Add chapter divider between chapters (except first)
      if (allBlocks.length > 0 && chapterTree.blocks.length > 0) {
        allBlocks.push({ type: 'divider' });
      }

      allBlocks.push(...chapterTree.blocks);
    }

    return {
      blocks: allBlocks.length > 0 ? allBlocks : [{ type: 'paragraph', content: [] }],
      metadata: { title, sourceFormat: 'epub', sourceFileName: fileName, modifiedAt: new Date().toISOString() },
    };
  },
};

function emptyResult(fileName?: string): DocumentTree {
  return {
    blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Could not read EPUB content.' }] }],
    metadata: { title: fileName ?? 'Untitled', sourceFormat: 'epub', sourceFileName: fileName },
  };
}
