import { useEffect, useState } from "react";
import { Film, Play, Trash2 } from "lucide-react";
import { footagePlacementLabel, type OwnFootageAsset, type OwnFootagePlacement } from "../shared/own-footage";
import { apiRequest } from "./api-client";
import "./own-footage.css";

export type AddedFootagePreview = { asset: OwnFootageAsset; placement: OwnFootagePlacement };

/** Keep active inserts visible alongside the source, even with collapsed settings. */
export default function AddedFootageNotice({ value, onPreview, onRemove, disabled, previewDisabled }: {
  value: OwnFootagePlacement[]; onPreview: (preview: AddedFootagePreview) => void;
  onRemove: (id: string) => void; disabled: boolean; previewDisabled: boolean;
}) {
  const [assets, setAssets] = useState<OwnFootageAsset[]>([]);
  const assetIds = value.map(item => item.assetId).join(",");
  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<{ assets: OwnFootageAsset[] }>("/api/broll", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setAssets(result.assets); }).catch(() => {});
    return () => controller.abort();
  }, [assetIds]);
  return <section className="added-footage-notice" aria-label="Added footage in this export">
    <strong><Film size={15} />This export includes added footage</strong>
    <p>These clips are included in addition to this video’s source footage.</p>
    <ul>{value.map(item => {
      const asset = assets.find(asset => asset.id === item.assetId);
      return <li key={item.id}>
        <div><strong>{asset?.name || "Uploaded clip"}</strong><span>{footagePlacementLabel(item)}</span></div>
        <button type="button" className="secondary-button" disabled={!asset || previewDisabled} aria-label={`Preview added clip ${asset?.name || ""}`} onClick={() => { if (asset) onPreview({ asset, placement: item }); }}><Play size={13} />Preview</button>
        <button type="button" className="secondary-button" disabled={disabled} aria-label={`Remove ${asset?.name || "added clip"} from this video`} onClick={() => onRemove(item.id)}><Trash2 size={13} />Remove</button>
      </li>;
    })}</ul>
  </section>;
}
