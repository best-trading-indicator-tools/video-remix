/** Accept desktop files without intercepting text, links, or in-app clip drags. */
export function bindFileDrop(target: HTMLElement, options: {
  canDrop: () => boolean;
  onFiles: (files: File[]) => void;
  onDragging: (dragging: boolean) => void;
}): () => void {
  let depth = 0;
  let dragging = false;
  const show = (next: boolean) => {
    if (dragging !== next) { dragging = next; options.onDragging(next); }
  };
  const reset = () => { depth = 0; show(false); };
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const enter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    show(options.canDrop());
  };
  const over = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const allowed = options.canDrop();
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
    show(allowed);
  };
  const leave = () => { depth = Math.max(0, depth - 1); if (!depth) show(false); };
  const drop = (event: DragEvent) => {
    reset();
    if (!hasFiles(event)) return;
    // Prevent the browser navigating to a dropped video, even while disconnected.
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length && options.canDrop()) options.onFiles(files);
  };
  const window = target.ownerDocument.defaultView;
  target.addEventListener('dragenter', enter);
  target.addEventListener('dragover', over);
  target.addEventListener('dragleave', leave);
  target.addEventListener('drop', drop);
  window?.addEventListener('drop', reset);
  window?.addEventListener('dragend', reset);
  window?.addEventListener('blur', reset);
  return () => {
    target.removeEventListener('dragenter', enter);
    target.removeEventListener('dragover', over);
    target.removeEventListener('dragleave', leave);
    target.removeEventListener('drop', drop);
    window?.removeEventListener('drop', reset);
    window?.removeEventListener('dragend', reset);
    window?.removeEventListener('blur', reset);
    reset();
  };
}
