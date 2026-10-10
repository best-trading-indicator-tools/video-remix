export type DesktopUpdateState = {
  currentVersion: string;
  status: "idle" | "checking" | "current" | "available" | "error";
  release: { version: string; url: string; prerelease: boolean } | null;
  checkedAt: string | null;
  error: string;
};
