import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import type { EditPlan, RenderJob } from '../shared/types';
import { clamp, storyClips, storyTiming, timecode } from '../shared/edit-timeline';
import { focusPointAt } from '../shared/focus';
import { BlackBandsOverlay, bandEditorialStyle, bandVideoStyle } from './BlackBandsEditor';
import { CaptionOverlay, activeCaptionWord } from './CaptionStyleEditor';
import { DEFAULT_CAPTION_STYLE } from '../shared/caption-style';

/** Supporting picture/audio follows the primary transport without driving its clock. */
function SyncedMedia({ url, time, rate, audio = false, fit = 'cover' }: { url: string; time: number; rate: number; audio?: boolean; fit?: 'cover' | 'contain' }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const sync = () => { const media = ref.current; if (!media?.readyState) return; if (Math.abs(media.currentTime - time) > .12 || !rate) media.currentTime = Math.max(0, time); if (rate > 0) { media.playbackRate = rate; void media.play().catch(() => {}); } else media.pause(); };
  useEffect(sync, [url, time, rate]);
  return audio ? <audio ref={ref} src={url} onLoadedMetadata={sync} /> : <video ref={ref} className="draft-supporting-picture" src={url} muted playsInline onLoadedMetadata={sync} style={{ objectFit: fit }} />;
}

export default function TimelinePreview({ plan, job, time, seekToken, rate, onRate, onTime, onSeek, height, fps, onAspect, guide, guideBottom, guideRight }: {
  plan: EditPlan; job: RenderJob; time: number; seekToken: number; rate: number; onRate: (rate: number) => void;
  onTime: (time: number) => void; onSeek: (time: number) => void; height: number; fps: number; onAspect: (aspect: number) => void;
  guide: 'off' | 'instagram' | 'tiktok'; guideBottom: number; guideRight: number;
}) {
  const clips = storyTiming(storyClips(plan, fps), plan.settings.speed), duration = clips.at(-1)?.outputEnd ?? 0;
  const clip = clips.find(item => time < item.outputEnd - 1e-7) ?? clips.at(-1)!;
  const primary = clip.kind === 'cut', start = primary ? clip.cut.start : clip.footage.start;
  const speed = primary ? plan.settings.speed : 1;
  const mainTime = clip.mainStart + (primary ? time - clip.outputStart : 0);
  const url = primary ? `/api/sources/${plan.sourceId}/video` : (job.footageAssets?.find(item => item.id === clip.footage.assetId)?.url ?? `/api/broll/${clip.footage.assetId}/video`);
  const player = useRef<HTMLVideoElement>(null), frame = useRef<HTMLDivElement>(null);
  const [muted, setMuted] = useState(false), [size, setSize] = useState({ width: 16, height: 9 }), [frameHeight, setFrameHeight] = useState(height), [error, setError] = useState('');
  const latest = useRef({ clip, start, time, speed, rate, duration, onTime, onRate }); latest.current = { clip, start, time, speed, rate, duration, onTime, onRate };
  const aspect = plan.settings.aspect === 'original' ? size.width / size.height : Number(plan.settings.aspect.split(':')[0]) / Number(plan.settings.aspect.split(':')[1]);
  const bands = primary ? plan.settings.blackBands : undefined;
  const fit = primary ? (bands?.enabled ? bands.fit : plan.settings.fit) : clip.footage.fit;
  const point = primary ? focusPointAt(clip.cut.focusTrack, start + (time - clip.outputStart) * speed, clip.cut.focalPoint || plan.settings.focalPoint || { x: .5, y: .5 }) : { x: .5, y: .5 };
  const cropRatio = aspect / (bands?.enabled ? 1 - (bands.topPercent + bands.bottomPercent) / 100 : 1);
  const position = (dimension: number, retained: number, focal: number) => dimension - retained < .01 ? 50 : clamp((dimension * focal - retained / 2) / (dimension - retained), 0, 1) * 100;
  const objectPosition = `${position(size.width, Math.min(size.width, size.height * cropRatio), point.x)}% ${position(size.height, Math.min(size.height, size.width / cropRatio), point.y)}%`;
  const sync = () => {
    const video = player.current, current = latest.current;
    if (!video?.readyState) return;
    video.currentTime = current.start + clamp(current.time - current.clip.outputStart, 0, current.clip.outputEnd - current.clip.outputStart) * current.speed;
    video.playbackRate = Math.max(.0625, Math.min(16, Math.abs(current.rate || 1) * current.speed));
    if (current.rate > 0) void video.play().catch(() => current.onRate(0)); else video.pause();
  };
  useEffect(() => { sync(); setError(''); }, [clip.id, url, start, seekToken]);
  useEffect(() => { const video = player.current; if (!video) return; if (rate > 0) { video.playbackRate = Math.min(16, rate * speed); void video.play().catch(() => onRate(0)); } else video.pause(); }, [rate, speed]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => { if (entry) setFrameHeight(entry.contentRect.height); });
    if (frame.current) observer.observe(frame.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let frameId = 0, previous = performance.now();
    const tick = (now: number) => {
      const current = latest.current, video = player.current;
      if (current.rate < 0) {
        const next = clamp(current.time + (now - previous) / 1000 * current.rate, 0, current.duration);
        current.onTime(next);
        if (video?.readyState) video.currentTime = current.start + clamp(next - current.clip.outputStart, 0, current.clip.outputEnd - current.clip.outputStart) * current.speed;
        if (next === 0) current.onRate(0);
      } else if (current.rate > 0 && video?.readyState && !video.seeking) {
        const next = current.clip.outputStart + (video.currentTime - current.start) / current.speed;
        if (next >= current.clip.outputEnd - .015 || video.ended) {
          current.onTime(current.clip.outputEnd);
          if (current.clip.outputEnd >= current.duration - .001) current.onRate(0);
        } else if (next >= current.clip.outputStart) current.onTime(next);
      }
      previous = now; frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick); return () => cancelAnimationFrame(frameId);
  }, []);
  const caption = primary ? plan.captions.find(cue => mainTime >= cue.start && mainTime < cue.end) : undefined;
  const cover = primary ? plan.settings.ownFootage?.find(item => item.mode === 'cover' && mainTime >= item.at && mainTime < item.at + item.end - item.start) : undefined;
  const visual = primary && !cover ? plan.visuals.find(item => item.enabled && mainTime >= item.start && mainTime < item.end) : undefined;
  const supporting = visual ? plan.media.find(item => item.id === visual.mediaId) : undefined;
  const narration = primary ? plan.media.find(item => item.id === plan.audioMediaId) : undefined;
  return <div className="draft-viewer">
    <div className="draft-viewer-stage">
      <div ref={frame} className="edit-framing-picture" style={{ aspectRatio: aspect, width: `min(100%, ${height * aspect}px)` }}>
        {fit === 'blur' && <div className="draft-blur-background"><SyncedMedia url={url} time={start + (time - clip.outputStart) * speed} rate={rate * speed} /></div>}
        <video ref={player} className="edit-framing-video" src={url} playsInline preload="auto" muted={muted || !!narration || (primary && plan.settings.muted) || (!primary && clip.footage.audio === 'mute')} aria-label="Timeline video preview"
          style={{ objectFit: fit === 'crop' ? 'cover' : 'contain', objectPosition, ...bandVideoStyle(bands) }}
          onLoadedMetadata={event => { event.currentTarget.volume = primary ? clamp(plan.settings.volume,0,1) : 1; setSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }); if (event.currentTarget.videoHeight) onAspect(plan.settings.aspect === 'original' ? event.currentTarget.videoWidth / event.currentTarget.videoHeight : aspect); sync(); }}
          onError={() => { setError('This preview clip is unavailable.'); onRate(0); }} />
        {supporting?.url && visual && <SyncedMedia url={supporting.url} time={visual.sourceStart + mainTime - visual.start} rate={rate} />}
        {cover && <SyncedMedia url={job.footageAssets?.find(item => item.id === cover.assetId)?.url ?? `/api/broll/${cover.assetId}/video`} time={cover.start + mainTime - cover.at} rate={rate} fit={cover.fit === 'crop' ? 'cover' : 'contain'} />}
        {narration?.url && !muted && !plan.settings.muted && <SyncedMedia url={narration.url} time={mainTime} rate={rate} audio />}
        <BlackBandsOverlay value={bands} aspect={aspect} />
        {primary && plan.settings.hookText && mainTime < plan.settings.hookDuration && <div className="edit-framing-hook" style={bandEditorialStyle(bands, frameHeight, aspect, .08, .054)}>{plan.settings.hookText}</div>}
        {primary && plan.settings.callouts?.filter(item => mainTime >= item.start && mainTime < item.end).map((item, i) => <div key={i} className="edit-framing-callout" style={bandEditorialStyle(bands, frameHeight, aspect, .24, .047)}>{item.text}</div>)}
        {caption && <CaptionOverlay style={plan.settings.captionStyle || DEFAULT_CAPTION_STYLE} height={frameHeight} text={caption.text} activeWord={activeCaptionWord(caption.text, caption.start, caption.end, mainTime, plan.captionWords)} />}
        {guide !== 'off' && <div className={`edit-platform-guide ${guide}`} aria-hidden="true"><span className="guide-top">App header</span><span className="guide-right" style={{ width: `${guideRight}%`, bottom: `${guideBottom}%` }}>Actions</span><span className="guide-bottom" style={{ height: `${guideBottom}%` }}>Post text &amp; navigation</span></div>}
      </div>
    </div>
    <div className="draft-transport">
      <button type="button" aria-label="Previous frame" title="Previous frame (←)" onClick={() => onSeek(Math.max(0, time - 1 / fps))}><SkipBack size={16} /></button>
      <button type="button" aria-label={rate ? 'Pause timeline' : 'Play timeline'} title="Play / pause (Space)" onClick={() => { if (!rate && time >= duration - .001) onSeek(0); onRate(rate ? 0 : 1); }}>{rate ? <Pause size={18} /> : <Play size={18} />}</button>
      <button type="button" aria-label="Next frame" title="Next frame (→)" onClick={() => onSeek(Math.min(duration, time + 1 / fps))}><SkipForward size={16} /></button>
      <output aria-label="Viewer timecode">{timecode(time, fps)} <span>/ {timecode(duration, fps)}</span></output>
      {!!rate && rate !== 1 && <span>{rate}×</span>}
      <button type="button" aria-label={muted ? 'Unmute preview' : 'Mute preview'} onClick={() => setMuted(!muted)}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
    </div>
    <p className="draft-preview-note">Live cut preview · Render for final sound, transitions and effects.{plan.settings.watermarkRemoval?.enabled && " Saved watermark removal is applied when rendering."}</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
