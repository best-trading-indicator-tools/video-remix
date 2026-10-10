declare const __APP_REVISION__: string;
interface Window { remixDesktop?: {
  editTextHistory(direction: "undo" | "redo"): Promise<void>;
  onHistory(callback: (direction: "undo" | "redo") => void): () => void;
  notifyBatch(body: string): Promise<boolean>;
  onOpenExports(callback: () => void): () => void;
  openSetup(): Promise<void>;
  getUpdateState(): Promise<import("../shared/desktop-updates").DesktopUpdateState>;
  checkUpdates(): Promise<import("../shared/desktop-updates").DesktopUpdateState>;
  openUpdate(): Promise<void>;
  onUpdateState(callback: (state: import("../shared/desktop-updates").DesktopUpdateState) => void): () => void;
} }
