import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import type { CaptionStyle, RemixSettings, VideoSource } from '../shared/types';
import type { BlackBands } from '../shared/black-bands';
import type { OwnFootageAsset, OwnFootagePlacement } from '../shared/own-footage';
import { buildFootagePreview, footagePreviewPosition } from '../shared/footage-preview';
import { manualCropPosition } from '../shared/manual';
import { apiRequest } from './api-client';
import { BlackBandsOverlay, bandVideoStyle } from './BlackBandsEditor';
import { SampleCaptionOverlay } from './CaptionStyleEditor';
import PreviewBackground from './PreviewBackground';
import ProblemNotice from './ProblemNotice';
import './footage-preview.css';

export type FootagePreviewJump = { id: string; token: number };
const clock = (value: number) => `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, '0')}`;

export default function FootageSequencePreview({ source, placements, settings, aspect, fit, bands, filter, captions, captionStyle, jump }: {
  source: VideoSource; placements: OwnFootagePlacement[]; settings?: RemixSettings;
  aspect: number; fit: 'crop' | 'contain' | 'blur'; bands?: BlackBands; filter: string;
  captions: boolean; captionStyle?: CaptionStyle; jump: FootagePreviewJump | null;
}) {
  const [assets, setAssets] = useState<OwnFootageAsset[]>([]);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [muted, setMuted] = useState(false);
  const [seekVersion, setSeekVersion] = useState(0), [height, setHeight] = useState(465);
  const root = useRef<HTMLDivElement>(null), frame = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLVideoElement>(null), sourceAudio = useRef<HTMLAudioElement>(null);
  const currentTime = useRef(0), shouldPlay = useRef(false);
  const previousPlacements = useRef(placements);
  const assetKey = [...new Set(placements.map(item => item.assetId))].sort().join(',');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError('');
    void apiRequest<{ assets: OwnFootageAsset[] }>('/api/broll', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setAssets(result.assets); setLoading(false); } })
      .catch(reason => { if (!controller.signal.aborted) { setLoadError(reason.message); setLoading(false); } });
    return () => controller.abort();
  }, [assetKey]);
  const prepared = useMemo(() => {
    try { return { timeline: buildFootagePreview(source, placements, assets, settings), error: '' }; }
    catch (reason) { return { timeline: null, error: (reason as Error).message }; }
  }, [source.duration, source.fps, placements, assets, settings]);
  const timeline = prepared.timeline;
  const position = timeline ? footagePreviewPosition(timeline, time) : null;
  const segment = position?.segment;
  const url = segment?.asset?.url ?? source.url;
  const stop = () => { shouldPlay.current = false; setPlaying(false); picture.current?.pause(); sourceAudio.current?.pause(); };
  const seek = (next: number) => {
    const value = Math.max(0, Math.min(timeline?.duration ?? 0, next));
    currentTime.current = value; setTime(value); setSeekVersion(version => version + 1);
  };
  const syncAudio = () => {
    const audio = sourceAudio.current, player = picture.current;
    if (!audio || !player || !audio.readyState || !segment) return;
    const offset = Math.max(0, (player.currentTime - segment.mediaStart) / segment.mediaRate);
    const expected = segment.sourceStart + offset * segment.sourceRate;
    audio.playbackRate = segment.sourceRate;
    audio.muted = muted || !!settings?.muted;
    audio.volume = Math.min(1, settings?.volume ?? 1);
    if (Math.abs(audio.currentTime - expected) > 0.12) audio.currentTime = expected;
    if (shouldPlay.current && !player.paused && !player.seeking && player.readyState >= 3) {
      if (audio.paused) void audio.play().catch(() => { if (audio.isConnected && shouldPlay.current) { stop(); setError('Could not play the source audio. Press Play to try again.'); } });
    } else audio.pause();
  };
  const sync = () => {
    const player = picture.current;
    if (!player?.readyState || !timeline) return;
    const at = footagePreviewPosition(timeline, currentTime.current);
    player.playbackRate = at.segment.mediaRate;
    player.muted = muted || !!settings?.muted || at.segment.kind === 'cover' || at.segment.placement?.audio === 'mute';
    player.volume = Math.min(1, settings?.volume ?? 1);
    const target = Math.min(at.mediaTime, Math.max(0, player.duration - 0.001));
    if (Math.abs(player.currentTime - target) > 0.03) player.currentTime = target;
    if (shouldPlay.current) void player.play().then(syncAudio).catch(reason => {
      if (player.isConnected && shouldPlay.current && reason.name !== 'AbortError') { stop(); setError('Could not play this clip. Press Play to try again.'); }
    });
    else player.pause();
    syncAudio();
  };
  const advance = () => {
    if (!segment || !timeline) return;
    if (segment.end >= timeline.duration - 0.001) { stop(); seek(timeline.duration); }
    else { picture.current?.pause(); sourceAudio.current?.pause(); seek(segment.end); }
  };
  useEffect(() => { sync(); }, [position?.segmentIndex, timeline, seekVersion, playing, muted, settings?.muted, settings?.volume]);
  useEffect(() => {
    if (!playing || !timeline || !segment) return;
    let request: number;
    const tick = () => {
      const player = picture.current;
      if (player && !player.paused && !player.seeking && player.readyState >= 2) {
        const next = segment.start + Math.max(0, (player.currentTime - segment.mediaStart) / segment.mediaRate);
        if (next >= segment.end - 0.012) { advance(); return; }
        if (Math.abs(next - currentTime.current) > 0.025) { currentTime.current = next; setTime(next); }
        syncAudio();
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, position?.segmentIndex, timeline, muted, settings?.muted, settings?.volume]);
  useEffect(() => {
    if (!timeline || loading) { stop(); return; }
    const changed = placements.find(item => JSON.stringify(item) !== JSON.stringify(previousPlacements.current.find(old => old.id === item.id)));
    previousPlacements.current = placements;
    const target = changed && timeline.segments.find(segment => segment.placement?.id === changed.id);
    stop(); setError(''); seek(target ? target.start : Math.min(currentTime.current, timeline.duration));
  }, [timeline, loading]);
  useEffect(() => {
    if (!jump || !timeline || loading) return;
    const target = timeline.segments.find(segment => segment.placement?.id === jump.id);
    if (target) { stop(); setError(''); seek(target.start); }
    else setError('This cover is outside the edited video. Move it earlier to preview it.');
  }, [jump, loading]);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(frame.current); return () => observer.disconnect();
  }, [!!timeline, loading]);
  useEffect(() => () => { shouldPlay.current = false; }, []);

  if (loading) return <div className="footage-preview-message" role="status">Loading your footage into the preview…</div>;
  if (!timeline || !segment || !position || loadError) return <div className="footage-preview-message"><ProblemNotice message={loadError || prepared.error} operation="Preview added footage" /></div>;
  const isSource = segment.kind === 'source';
  const contentFit = segment.placement?.fit ?? fit;
  const baseTime = position.baseTime;
  const chapters = placements.map(item => ({ item, start: timeline.segments.find(segment => segment.placement?.id === item.id)?.start }));
  return <div ref={root} className="footage-live-preview">
    <div className="preview-label"><span />LIVE · FULL SEQUENCE</div>
    <div ref={frame} className={`video-frame${bands ? ' has-black-bands' : ''}`} style={{ width: `min(100%, calc(var(--live-preview-height, 465px) * ${aspect}))`, aspectRatio: aspect }}>
      {isSource && fit === 'blur' && <PreviewBackground key={position.segmentIndex} source={source.url} videoRef={picture} filter={filter} />}
      <video key={`${position.segmentIndex}:${url}`} ref={picture} src={url} playsInline preload="auto" aria-label="Main video preview"
        onLoadedMetadata={sync} onEnded={advance} onPlaying={syncAudio} onSeeked={syncAudio} onWaiting={() => sourceAudio.current?.pause()}
        onError={() => { stop(); setError('The browser could not play this clip. Check that the video is still available.'); }}
        style={{ ...bandVideoStyle(bands), objectFit: contentFit === 'crop' ? 'cover' : 'contain',
          objectPosition: isSource && contentFit === 'crop' ? manualCropPosition(source.width, source.height, aspect / (bands ? 1 - (bands.topPercent + bands.bottomPercent) / 100 : 1), segment.focalPoint ?? settings?.focalPoint ?? { x: 0.5, y: 0.5 }) : '50% 50%',
          filter: isSource ? filter : 'none', transform: isSource && settings ? `scale(${settings.mirror ? -settings.zoom : settings.zoom}, ${settings.zoom})` : 'none' }} />
      {segment.kind === 'cover' && source.hasAudio && <audio ref={sourceAudio} src={source.url} preload="auto" onLoadedMetadata={syncAudio}
        onError={() => { stop(); setError('The browser could not play the source audio for this cover shot.'); }} />}
      {segment.kind !== 'insert' && settings?.hookText && baseTime < settings.hookDuration && <div className="hook-preview" style={bands ? { top: `${bands.topPercent + (100 - bands.topPercent - bands.bottomPercent) * 0.08}%` } : undefined}>{settings.hookText}</div>}
      <BlackBandsOverlay value={bands} aspect={aspect} />
      {captions && segment.kind !== 'insert' && <SampleCaptionOverlay style={captionStyle} height={height} />}
    </div>
    <div className="footage-preview-controls">
      <div className="footage-preview-now" role="status">{segment.kind === 'source' ? 'Source video' : segment.kind === 'cover' ? 'Cover · source audio continues' : segment.placement?.audio === 'mute' ? 'Added clip · silent' : 'Added clip · clip audio'}<span title={segment.asset?.name ?? source.name}>{segment.asset?.name ?? source.name}</span></div>
      <div className="footage-preview-transport">
        <button type="button" aria-label={playing ? 'Pause combined preview' : 'Play combined preview'} onClick={() => {
          if (playing) stop(); else { setError(''); if (time >= timeline.duration - 0.02) seek(0); shouldPlay.current = true; setPlaying(true); }
        }}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
        <span>{clock(time)}</span>
        <input type="range" min={0} max={timeline.duration} step={0.01} value={time} aria-label="Combined preview position" aria-valuetext={`${clock(time)} of ${clock(timeline.duration)}`} onChange={event => seek(Number(event.target.value))} />
        <span>{clock(timeline.duration)}</span>
        <button type="button" aria-label={muted ? 'Unmute preview' : 'Mute preview'} aria-pressed={muted} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
        <button type="button" aria-label="Full screen preview" disabled={!document.fullscreenEnabled} onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void root.current?.requestFullscreen().catch(() => setError('Full screen is unavailable in this browser.')); }}><Maximize size={18} /></button>
      </div>
      <div className="footage-preview-chapters" aria-label="Jump to added footage">
        <button type="button" className="secondary-button" onClick={() => { stop(); seek(0); }}>Start of edit</button>
        {chapters.map(({ item, start }, index) => <button key={item.id} type="button" className="secondary-button" disabled={start === undefined} aria-pressed={segment.placement?.id === item.id}
          title={assets.find(asset => asset.id === item.assetId)?.name}
          onClick={() => { if (start !== undefined) { stop(); seek(start); } }}><Play size={13} />{item.appendToEnd ? 'Outro' : item.mode === 'cover' ? 'Cover' : 'Insert'} {index + 1}{start === undefined ? ' · outside edit' : ` · ${clock(start)}`}</button>)}
      </div>
      {error && <ProblemNotice message={error} operation="Preview added footage" />}
    </div>
  </div>;
}
