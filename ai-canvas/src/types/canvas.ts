export interface Viewport {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface PickModeState {
  active: boolean;
  targetCardId: string;
  slotKey: string;
  onPick: (sourceCardId: string, imageUrl: string) => void;
}

export interface DragOffset {
  dx: number;
  dy: number;
}

export type FileDropCallback = (paths: string[], x: number, y: number) => void;
