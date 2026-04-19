import { useEffect } from "react";
import { useUIStore } from "@/stores/uiStore";
import { autoSave } from "@/lib/autoSave";

export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        autoSave.forceSave().then(() => {
          useUIStore.getState().addToast({
            type: "success",
            title: "项目已保存",
            duration: 2000,
          });
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
