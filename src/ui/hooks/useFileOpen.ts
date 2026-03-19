import { useCallback } from 'react';
import type { DocumentTree } from '../../core/model/DocumentTree';
import { codecRegistry } from '../../core/codecs/CodecRegistry';

// Tauri APIs — these are only available in the Tauri desktop context
// In web-only dev mode, we fall back to the browser File API
async function openWithTauri(): Promise<{ buffer: ArrayBuffer; fileName: string } | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');

    const extensions = codecRegistry.getSupportedExtensions();
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: 'Documents',
          extensions,
        },
      ],
    });

    if (!selected) return null;

    const filePath = typeof selected === 'string' ? selected : (selected as unknown as { path: string }).path;
    const bytes = await readFile(filePath);
    const fileName = filePath.split(/[/\\]/).pop() ?? 'unknown';
    return { buffer: bytes.buffer as ArrayBuffer, fileName };
  } catch {
    // Tauri not available — fall through to browser fallback
    return null;
  }
}

function openWithBrowser(): Promise<{ buffer: ArrayBuffer; fileName: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = codecRegistry
      .getSupportedExtensions()
      .map((ext) => `.${ext}`)
      .join(',');
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const buffer = await file.arrayBuffer();
      resolve({ buffer, fileName: file.name });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function readFilePath(filePath: string): Promise<{ buffer: ArrayBuffer; fileName: string } | null> {
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const bytes = await readFile(filePath);
    const fileName = filePath.split(/[/\\]/).pop() ?? 'unknown';
    return { buffer: bytes.buffer as ArrayBuffer, fileName };
  } catch {
    return null;
  }
}

async function parseResult(result: { buffer: ArrayBuffer; fileName: string }): Promise<DocumentTree | null> {
  const codec = codecRegistry.detect(result.buffer, result.fileName);
  if (!codec) return null;
  return codec.parse(result.buffer, result.fileName);
}

export function useFileOpen() {
  const openFile = useCallback(async (): Promise<DocumentTree | null> => {
    // Try Tauri first, fall back to browser File API
    let result = await openWithTauri();
    if (!result) {
      result = await openWithBrowser();
    }
    if (!result) return null;
    return parseResult(result);
  }, []);

  const openFilePath = useCallback(async (filePath: string): Promise<DocumentTree | null> => {
    const result = await readFilePath(filePath);
    if (!result) return null;
    return parseResult(result);
  }, []);

  return { openFile, openFilePath };
}
