import { useCallback } from 'react';
import type { DocumentTree } from '../../core/model/DocumentTree';
import { exportToHtml } from '../../core/export/HtmlExporter';
import { exportToMarkdown } from '../../core/export/MarkdownExporter';

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

  return { exportHtml, exportMarkdown };
}
