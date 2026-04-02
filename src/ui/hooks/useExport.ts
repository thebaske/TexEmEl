import { useCallback } from 'react';
import type { DocumentTree } from '../../core/model/DocumentTree';
import type { LayoutDirector } from '../../core/layout/LayoutDirector';
import { exportToHtml, exportToHtmlWithLayout } from '../../core/export/HtmlExporter';
import { exportToMarkdown } from '../../core/export/MarkdownExporter';
import { exportToText } from '../../core/export/TxtExporter';
import { exportToRtf } from '../../core/export/RtfExporter';
import { getAllLeaves } from '../../core/layout/LayoutTree';

async function saveTextWithTauri(
  content: string,
  suggestedName: string,
  filterName: string,
  extensions: string[],
): Promise<boolean> {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');

    const filePath = await save({
      defaultPath: suggestedName,
      filters: [{ name: filterName, extensions }],
    });

    if (!filePath) return false;
    await writeTextFile(filePath, content);
    return true;
  } catch {
    return false;
  }
}

function saveWithBrowser(content: string, suggestedName: string, mimeType: string): boolean {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

function baseName(doc: DocumentTree): string {
  return (doc.metadata.title ?? 'document').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function useExport() {
  const exportHtml = useCallback(async (doc: DocumentTree): Promise<boolean> => {
    const html = exportToHtml(doc);
    const name = baseName(doc) + '.html';
    const saved = await saveTextWithTauri(html, name, 'HTML', ['html']);
    if (!saved) return saveWithBrowser(html, name, 'text/html');
    return true;
  }, []);

  const exportMarkdown = useCallback(async (doc: DocumentTree): Promise<boolean> => {
    const md = exportToMarkdown(doc);
    const name = baseName(doc) + '.md';
    const saved = await saveTextWithTauri(md, name, 'Markdown', ['md']);
    if (!saved) return saveWithBrowser(md, name, 'text/markdown');
    return true;
  }, []);

  const exportText = useCallback(async (doc: DocumentTree): Promise<boolean> => {
    const txt = exportToText(doc);
    const name = baseName(doc) + '.txt';
    const saved = await saveTextWithTauri(txt, name, 'Plain Text', ['txt']);
    if (!saved) return saveWithBrowser(txt, name, 'text/plain');
    return true;
  }, []);

  const exportRtf = useCallback(async (doc: DocumentTree): Promise<boolean> => {
    const rtf = exportToRtf(doc);
    const name = baseName(doc) + '.rtf';
    const saved = await saveTextWithTauri(rtf, name, 'Rich Text Format', ['rtf']);
    if (!saved) return saveWithBrowser(rtf, name, 'application/rtf');
    return true;
  }, []);

  /**
   * Save HTML with BSP layout preserved (for TexElEm round-trip).
   * Falls back to flat export if no engine is provided.
   */
  const saveHtmlWithLayout = useCallback(async (doc: DocumentTree, engine: LayoutDirector | null): Promise<boolean> => {
    let html: string;

    if (engine) {
      const pages = engine.getPages();
      const getCellContent = (cellId: string) => {
        // Read live content from the cell pool
        const cell = (engine as any).cellPool?.get(cellId);
        if (cell) return cell.getContent();
        // Fallback to leaf blocks from the tree
        for (const page of pages) {
          for (const leaf of getAllLeaves(page.layout)) {
            if (leaf.id === cellId) return leaf.blocks;
          }
        }
        return [];
      };
      html = exportToHtmlWithLayout(doc, pages, getCellContent);
    } else {
      html = exportToHtml(doc);
    }

    const name = baseName(doc) + '.html';
    const saved = await saveTextWithTauri(html, name, 'HTML', ['html']);
    if (!saved) return saveWithBrowser(html, name, 'text/html');
    return true;
  }, []);

  return { exportHtml, exportMarkdown, exportText, exportRtf, saveHtmlWithLayout };
}
