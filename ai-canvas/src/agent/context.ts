import type {
  AgentContext,
  CardCreateInput,
  CardSnapshot,
  ProviderCapability,
} from "./types";
import type { ProviderManager } from "./providers/manager";
import { useCardStore, type CanvasCard } from "@/stores/cardStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { autoSave } from "@/lib/autoSave";
import type { CardType } from "@/shared/types";

function findOpenPosition(
  cards: CanvasCard[],
  viewport: { x: number; y: number; zoom: number; width: number; height: number },
  cardWidth: number,
  cardHeight: number,
): { x: number; y: number } {
  const worldCenterX = -viewport.x / viewport.zoom + viewport.width / 2 / viewport.zoom;
  const worldCenterY = -viewport.y / viewport.zoom + viewport.height / 2 / viewport.zoom;

  const candidateX = worldCenterX + 50;
  const candidateY = worldCenterY + 50;

  const overlaps = (cx: number, cy: number) =>
    cards.some(
      (c) =>
        cx < c.x + c.width &&
        cx + cardWidth > c.x &&
        cy < c.y + c.height &&
        cy + cardHeight > c.y,
    );

  let x = candidateX;
  let y = candidateY;
  let attempt = 0;
  while (overlaps(x, y) && attempt < 20) {
    x += 40;
    y += 30;
    attempt++;
  }

  return { x: Math.round(x), y: Math.round(y) };
}

export function createAgentContext(
  projectId: string,
  sessionId: string,
  model: string,
  providerManager: ProviderManager,
): AgentContext {
  return {
    projectId,
    sessionId,
    model,

    createCard(input: CardCreateInput): string {
      const cardStore = useCardStore.getState();
      const canvasStore = useCanvasStore.getState();
      const viewport = canvasStore.viewport;
      const allCards = cardStore.getCardsByProject(projectId);

      const width = input.width ?? 360;
      const height = input.height ?? 300;
      const pos =
        input.x != null && input.y != null
          ? { x: input.x, y: input.y }
          : findOpenPosition(allCards, viewport, width, height);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const card: CanvasCard = {
        id,
        projectId,
        type: (input.type ?? "text") as CardType,
        x: pos.x,
        y: pos.y,
        width,
        height,
        zIndex: cardStore.maxZIndex + 1,
        locked: false,
        collapsed: false,
        title: input.title,
        data: input.data ?? {},
        createdAt: now,
        updatedAt: now,
      };

      cardStore.addCard(card);
      autoSave.markDirty(id);
      return id;
    },

    updateCard(id: string, patch: Record<string, unknown>) {
      const cardStore = useCardStore.getState();
      cardStore.updateCard(id, patch as Partial<CanvasCard>);
      autoSave.markDirty(id);
    },

    readCard(id: string): CardSnapshot | undefined {
      const card = useCardStore.getState().getCard(id);
      if (!card) return undefined;
      return {
        id: card.id,
        type: card.type,
        title: card.title,
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
        data: card.data,
      };
    },

    listCards(): CardSnapshot[] {
      return useCardStore
        .getState()
        .getCardsByProject(projectId)
        .map((c) => ({
          id: c.id,
          type: c.type,
          title: c.title,
          x: c.x,
          y: c.y,
          width: c.width,
          height: c.height,
          data: c.data,
        }));
    },

    async callProvider(
      capability: ProviderCapability,
      request: unknown,
    ): Promise<unknown> {
      const provider = providerManager.resolve([capability]);
      if (capability === "chat") {
        return provider.chat(request as Parameters<typeof provider.chat>[0]);
      }
      if (capability === "image_gen" && provider.generateImage) {
        return provider.generateImage(
          request as Parameters<typeof provider.generateImage>[0],
        );
      }
      throw new Error(`Unsupported capability dispatch: ${capability}`);
    },
  };
}
