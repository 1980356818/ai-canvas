import { useEffect, useRef, useState } from "react";
import { BIRDVIEW_ENTER_ZOOM, BIRDVIEW_EXIT_ZOOM } from "@/shared/constants";

export function useBirdView(zoom: number) {
  const [birdView, setBirdView] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  // 同时跟踪外层（200ms 切换）与内层（50ms 收尾）两个 timer，
  // 组件卸载或快速切换时都能完整 clearTimeout，避免在已卸载组件上 setState。
  const outerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const innerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTarget = useRef<boolean | null>(null);

  const shouldBird = birdView
    ? zoom < BIRDVIEW_EXIT_ZOOM
    : zoom <= BIRDVIEW_ENTER_ZOOM;

  useEffect(() => {
    if (shouldBird !== birdView && !transitioning) {
      pendingTarget.current = shouldBird;
      setTransitioning(true);
      if (outerTimer.current) clearTimeout(outerTimer.current);
      outerTimer.current = setTimeout(() => {
        outerTimer.current = null;
        setBirdView(pendingTarget.current!);
        pendingTarget.current = null;
        if (innerTimer.current) clearTimeout(innerTimer.current);
        innerTimer.current = setTimeout(() => {
          innerTimer.current = null;
          setTransitioning(false);
        }, 50);
      }, 200);
    } else if (
      shouldBird === birdView &&
      transitioning &&
      pendingTarget.current !== null
    ) {
      if (outerTimer.current) clearTimeout(outerTimer.current);
      outerTimer.current = null;
      pendingTarget.current = null;
      setTransitioning(false);
    }
  }, [shouldBird, birdView, transitioning]);

  // 组件卸载时强制清掉所有未触发的 timer
  useEffect(() => {
    return () => {
      if (outerTimer.current) {
        clearTimeout(outerTimer.current);
        outerTimer.current = null;
      }
      if (innerTimer.current) {
        clearTimeout(innerTimer.current);
        innerTimer.current = null;
      }
    };
  }, []);

  return {
    isBirdView: birdView,
    showDom: !birdView || transitioning,
    showCanvas: birdView || transitioning,
    transitioning,
  };
}
