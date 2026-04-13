import RBush from "rbush";

export interface SpatialItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
}

export class SpatialIndex {
  private tree = new RBush<SpatialItem>();
  private items = new Map<string, SpatialItem>();

  upsert(id: string, x: number, y: number, w: number, h: number) {
    const prev = this.items.get(id);
    if (prev) this.tree.remove(prev);
    const item: SpatialItem = {
      minX: x,
      minY: y,
      maxX: x + w,
      maxY: y + h,
      id,
    };
    this.tree.insert(item);
    this.items.set(id, item);
  }

  remove(id: string) {
    const item = this.items.get(id);
    if (item) {
      this.tree.remove(item);
      this.items.delete(id);
    }
  }

  query(left: number, top: number, right: number, bottom: number): string[] {
    return this.tree
      .search({ minX: left, minY: top, maxX: right, maxY: bottom })
      .map((item) => item.id);
  }

  hitTest(worldX: number, worldY: number): string | null {
    const hits = this.tree.search({
      minX: worldX,
      minY: worldY,
      maxX: worldX,
      maxY: worldY,
    });
    if (hits.length === 0) return null;
    return hits[hits.length - 1]!.id;
  }

  clear() {
    this.tree.clear();
    this.items.clear();
  }

  get size() {
    return this.items.size;
  }
}

export const spatialIndex = new SpatialIndex();
