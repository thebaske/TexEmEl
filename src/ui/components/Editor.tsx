import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor as TipTapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import type { DocumentTree } from '../../core/model/DocumentTree';
import { documentTreeToTipTap, tipTapToDocumentTree } from '../../core/editor/EditorBridge';

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = [];
  for (let i = 0; i < dataTransfer.files.length; i++) {
    if (dataTransfer.files[i].type.startsWith('image/')) {
      files.push(dataTransfer.files[i]);
    }
  }
  return files;
}

interface EditorProps {
  document: DocumentTree;
  onDocumentChange: (doc: DocumentTree) => void;
  onEditorReady?: (editor: TipTapEditor) => void;
}

export function Editor({ document, onDocumentChange, onEditorReady }: EditorProps) {
  const isLoadingRef = useRef(false);
  const readyFiredRef = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: 'Start typing...' }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Underline,
    ],
    content: documentTreeToTipTap(document),
    editorProps: {
      handlePaste(_view, event) {
        const dt = event.clipboardData;
        if (!dt) return false;
        const images = getImageFiles(dt);
        if (images.length === 0) return false;
        event.preventDefault();
        for (const file of images) {
          fileToBase64(file).then((src) => {
            editor?.chain().focus().setImage({ src }).run();
          });
        }
        return true;
      },
      handleDrop(_view, event) {
        const dt = event.dataTransfer;
        if (!dt) return false;
        const images = getImageFiles(dt);
        if (images.length === 0) return false;
        event.preventDefault();
        for (const file of images) {
          fileToBase64(file).then((src) => {
            editor?.chain().focus().setImage({ src }).run();
          });
        }
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      if (isLoadingRef.current) return;
      const json = editor.getJSON();
      const tree = tipTapToDocumentTree(json as any, document.metadata);
      tree.metadata.modifiedAt = new Date().toISOString();
      onDocumentChange(tree);
    },
  });

  // Notify parent when editor is ready
  useEffect(() => {
    if (editor && !readyFiredRef.current) {
      readyFiredRef.current = true;
      onEditorReady?.(editor);
    }
  }, [editor, onEditorReady]);

  // Load new document content when document prop changes externally (file open)
  useEffect(() => {
    if (!editor) return;
    isLoadingRef.current = true;
    const tipTapContent = documentTreeToTipTap(document);
    editor.commands.setContent(tipTapContent);
    isLoadingRef.current = false;
  }, [editor, document.metadata.sourceFileName, document.metadata.createdAt]);

  return (
    <div className="editor-container">
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}
