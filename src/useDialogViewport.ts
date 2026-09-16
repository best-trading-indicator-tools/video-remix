import { useEffect } from "react";

// Mobile keyboards resize the visual viewport even when 100dvh stays unchanged.
// Keep dialogs inside the part of the screen the user can actually see.
export function useDialogViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--dialog-height", `${viewport.height}px`);
      root.style.setProperty("--dialog-top", `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--dialog-height");
      root.style.removeProperty("--dialog-top");
    };
  }, []);
}
