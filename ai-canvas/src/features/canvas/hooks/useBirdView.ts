import { useState, useRef } from "react";
import { BIRDVIEW_ENTER_ZOOM, BIRDVIEW_EXIT_ZOOM } from "@/shared/constants";

export function useBirdView(zoom: number) {
  const [birdView, setBirdView] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const transTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTarget = useRef<boolean | null>(null);

  const shouldBird = birdView
    ? zoom < BIRDVIEW_EXIT_ZOOM
    : zoom <= BIRDVIEW_ENTER_ZOOM;

  if (shouldBird !== birdView && !transitioning) {
    pendingTarget.current = shouldBird;
    setTransitioning(true);
    if (transTimer.current) clearTimeout(transTimer.current);
    transTimer.current = setTimeout(() => {
      transTimer.current = null;
      setBirdView(pendingTarget.current!);
      pendingTarget.current = null;
      setTimeout(() => setTransitioning(false), 50);
    }, 200);
  } else if (shouldBird === birdView && transitioning && pendingTarget.current !== null) {
    if (transTimer.current) clearTimeout(transTimer.current);
    transTimer.current = null;
    pendingTarget.current = null;
    setTransitioning(false);
  }

  return {
    isBirdView: birdView,
    showDom: !birdView || transitioning,
    showCanvas: birdView || transitioning,
    transitioning,
  };
}
