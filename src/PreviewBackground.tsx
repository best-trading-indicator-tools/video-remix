import { useEffect, useRef, type RefObject } from "react";

/** Keep the blurred full-frame picture on the main player's clock. */
export default function PreviewBackground({ source, videoRef, filter }: {
  source: string; videoRef: RefObject<HTMLVideoElement | null>; filter: string;
}) {
  const backgroundRef = useRef<HTMLVideoElement>(null);
  const sync = () => {
    const player = videoRef.current, background = backgroundRef.current;
    if (!player || !background?.readyState) return;
    background.playbackRate = player.playbackRate;
    if (Math.abs(background.currentTime - player.currentTime) > 0.1) background.currentTime = player.currentTime;
    if (player.paused) background.pause();
    else void background.play().catch(() => {});
  };
  useEffect(() => {
    const player = videoRef.current;
    if (!player) return;
    const events = ["play", "pause", "seeking", "timeupdate", "ratechange", "loadedmetadata"];
    events.forEach(event => player.addEventListener(event, sync));
    sync();
    return () => events.forEach(event => player.removeEventListener(event, sync));
  }, [source, videoRef]);
  return <video ref={backgroundRef} className="preview-blur-background" src={source} muted playsInline
    aria-hidden="true" preload="metadata" onLoadedMetadata={sync} style={{ filter: `${filter === "none" ? "" : filter + " "}blur(20px)` }} />;
}
