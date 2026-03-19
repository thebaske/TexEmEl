import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'texsaur-recent-files';
const MAX_RECENT = 10;

export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}

function loadRecent(): RecentFile[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as RecentFile[];
  } catch {
    return [];
  }
}

function saveRecent(files: RecentFile[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
}

export function useRecentFiles() {
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(loadRecent);

  // Sync from localStorage on mount
  useEffect(() => {
    setRecentFiles(loadRecent());
  }, []);

  const addRecentFile = useCallback((path: string, name: string) => {
    setRecentFiles((prev) => {
      const filtered = prev.filter((f) => f.path !== path);
      const updated = [{ path, name, openedAt: new Date().toISOString() }, ...filtered].slice(0, MAX_RECENT);
      saveRecent(updated);
      return updated;
    });
  }, []);

  const clearRecentFiles = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setRecentFiles([]);
  }, []);

  return { recentFiles, addRecentFile, clearRecentFiles };
}
