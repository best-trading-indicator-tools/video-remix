declare const __APP_REVISION__: string;
interface Window { remixDesktop?: {
  openSetup(): Promise<void>;
  getUpdateState(): Promise<import("../shared/desktop-updates").DesktopUpdateState>;
  checkUpdates(): Promise<import("../shared/desktop-updates").DesktopUpdateState>;
  openUpdate(): Promise<void>;
  onUpdateState(callback: (state: import("../shared/desktop-updates").DesktopUpdateState) => void): () => void;
} }
