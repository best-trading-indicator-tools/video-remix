import { useEffect, useState, type RefObject } from 'react';
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import './preview-transport.css';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Controls live outside the picture so flipping, cropping and zooming cannot transform them. */
export default function PreviewTransport({ videoRef, fullscreenRef, mediaKey, interval, speed, onError }: {
  videoRef: RefObject<HTMLVideoElement | null>;
  fullscreenRef: RefObject<HTMLDivElement | null>;
  mediaKey: string;
  interval?: { start: number; end: number } | null;
  speed: number;
  onError: (message: string) => void;
}) {
  const [media, setMedia] = useState({ time: 0, duration: 0, playing: false, muted: false, volume: 1 });
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => setMedia({ time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0,
      playing: !video.paused && !video.ended, muted: video.muted, volume: video.volume });
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ended', 'volumechange', 'emptied'];
    events.forEach(event => video.addEventListener(event, sync));
    sync();
    return () => events.forEach(event => video.removeEventListener(event, sync));
  }, [mediaKey, videoRef]);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [fullscreenRef]);
  const start = Math.min(interval?.start ?? 0, media.duration);
  const end = Math.max(start, Math.min(interval?.end ?? media.duration, media.duration));
  const duration = (end - start) / speed;
  const time = Math.max(0, Math.min(duration, (media.time - start) / speed));
  const silent = media.muted || media.volume === 0;
  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) { video.pause(); return; }
    if (video.currentTime < start || video.currentTime >= end - .04) video.currentTime = start;
    try { await video.play(); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) onError('The preview could not play. Try again or render a sample.'); }
  };
  return <div className="main-preview-transport" role="group" aria-label="Preview playback controls">
    <button type="button" aria-label={media.playing ? 'Pause preview' : 'Play preview'} disabled={!duration} onClick={() => void togglePlay()}>
      {media.playing ? <Pause size={18} /> : <Play size={18} />}
    </button>
    <span>{clock(time)}</span>
    <input type="range" aria-label="Preview position" aria-valuetext={`${clock(time)} of ${clock(duration)}`} min={0} max={duration || 1} step={.01} value={time} disabled={!duration}
      onChange={event => { if (videoRef.current) videoRef.current.currentTime = start + Number(event.target.value) * speed; }} />
    <span>{clock(duration)}</span>
    <button type="button" aria-label={silent ? 'Unmute preview' : 'Mute preview'} onClick={() => {
      const video = videoRef.current;
      if (video) { video.muted = !silent; if (silent && video.volume === 0) video.volume = 1; }
    }}>{silent ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
    <button type="button" aria-label={fullscreen ? 'Exit full screen preview' : 'Full screen preview'} disabled={!document.fullscreenEnabled} onClick={() => {
      const action = fullscreen ? document.exitFullscreen() : fullscreenRef.current?.requestFullscreen();
      void action?.catch(() => onError('Full screen is unavailable in this browser.'));
    }}>{fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}</button>
  </div>;
}
