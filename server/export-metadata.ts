/** Mandatory for every final MP4 encoding pass, including caption burn-in. */
export const CLEAN_EXPORT_METADATA_ARGS = [
  "-sn", "-dn",
  "-map_metadata", "-1",
  "-map_metadata:s", "-1",
  "-map_chapters", "-1",
  // Suppress automatically generated software tags as well as copied tags.
  "-fflags", "+bitexact",
  "-flags:v", "+bitexact",
  "-flags:a", "+bitexact",
  "-metadata", "encoder=",
  "-metadata:s", "encoder=",
  "-metadata:s:v:0", "rotate=0",
  // Do not import source unregistered SEI or embedded broadcast captions.
  // Burned captions remain pixels. Pixel/audio watermarks are not metadata.
  "-udu_sei", "0",
  "-a53cc", "0",
  "-movflags", "+faststart",
];

export interface ExportMetadata {
  format?: { tags?: Record<string, string> };
  streams?: {
    codec_type?: string;
    tags?: Record<string, string>;
    disposition?: { attached_pic?: number };
  }[];
  chapters?: unknown[];
}

/** Only neutral MP4 playback fields may remain; never echo rejected tag values. */
export function assertCleanExportMetadata(info: ExportMetadata): void {
  const fail = () => { throw new Error("Export metadata verification failed. The file was not saved; please retry the export."); };
  const checkTags = (tags: Record<string, string> | undefined, allowed: Record<string, RegExp>) => {
    for (const [key, value] of Object.entries(tags ?? {})) {
      if (!Object.hasOwn(allowed, key) || !allowed[key]!.test(value)) fail();
    }
  };
  checkTags(info.format?.tags, {
    major_brand: /^(?:isom|mp4[12])$/,
    minor_version: /^\d+$/,
    compatible_brands: /^(?:isom|iso[2-9]|avc1|mp4[12])+$/,
  });
  const streams = info.streams ?? [];
  if (streams.filter(stream => stream.codec_type === "video").length !== 1
    || streams.filter(stream => stream.codec_type === "audio").length > 1
    || info.chapters?.length) fail();
  for (const stream of streams) {
    if (!["video", "audio"].includes(stream.codec_type ?? "") || stream.disposition?.attached_pic) fail();
    checkTags(stream.tags, {
      language: /^und$/,
      handler_name: stream.codec_type === "video" ? /^VideoHandler$/ : /^SoundHandler$/,
      vendor_id: /^(?:\[0\]){4}$/,
      rotate: /^0$/,
    });
  }
}
