import { useEffect } from 'react';
import type { DocumentTree } from '../../core/model/DocumentTree';
import { codecRegistry } from '../../core/codecs/CodecRegistry';

// Handles file-open on launch via Tauri file association events.
// When the app is opened by double-clicking an associated file,
// Tauri v2 emits a 'tauri://file-drop' or passes args via the invoke handler.

export function useFileDrop(onFileLoaded: (tree: DocumentTree) => void) {
  useEffect(() => {
    let cancelled = false;

    async function loadFromPath(filePath: string) {
      try {
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const bytes = await readFile(filePath);
        const fileName = filePath.split(/[/\\]/).pop() ?? 'unknown';
        const buffer = bytes.buffer as ArrayBuffer;
        const codec = codecRegistry.detect(buffer, fileName);
        if (!codec) return;
        const tree = await codec.parse(buffer, fileName);
        if (!cancelled) onFileLoaded(tree);
      } catch {
        // Not in Tauri or file read failed
      }
    }

    async function listenForFileDrop() {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const webview = getCurrentWebviewWindow();
        const unlisten = await webview.onDragDropEvent(async (event) => {
          if (event.payload.type === 'drop' && event.payload.paths.length > 0) {
            await loadFromPath(event.payload.paths[0]);
          }
        });
        return unlisten;
      } catch {
        return undefined;
      }
    }

    const unlistenPromise = listenForFileDrop();

    return () => {
      cancelled = true;
      unlistenPromise.then((unlisten) => unlisten?.());
    };
  }, [onFileLoaded]);
}
