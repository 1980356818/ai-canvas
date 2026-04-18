export type SaveStatus = "saved" | "unsaved" | "saving" | "error";
export type AppView = "home" | "canvas" | "projects";

export interface CardGenSubProgress {
  percent: number;
  status: "pending" | "running" | "done" | "error";
}

export interface CardGenProgress {
  percent: number;
  label: string;
  subs?: CardGenSubProgress[];
}

export interface ToastItem {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration: number;
}
