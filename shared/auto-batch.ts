import type { AutoOptions, RemixSettings } from './types.js';
import type { OwnFootagePlacement } from './own-footage.js';

export type AutoDraft = { options: AutoOptions; variants: number };
export type AutoPromptTarget = { id: string; name: string; draft: AutoDraft };
export interface AutoPromptProposal extends AutoDraft {
  summary: string[];
  clarification?: string;
  unchanged?: boolean;
  manual?: RemixSettings;
}
export interface AutoBatchProposal {
  changes: { id: string; proposal: AutoPromptProposal }[];
  summary: string[];
  clarification?: string;
  reviewGroups: { title: string; summary: string[] }[];
}

/** Footage is explicitly bound to each target; import defaults never inherit it. */
export function applyAutoFootage(current: Record<string, AutoDraft>, fallback: AutoDraft, ids: string[], placements: OwnFootagePlacement[]) {
  return { ...current, ...Object.fromEntries(ids.map(id => {
    const draft = current[id] || fallback;
    return [id, { ...draft, options: { ...draft.options, ownFootage: structuredClone(placements), ownFootageSourceId: id } }];
  })) };
}

/** Propose against each video's own settings, with bounded work and no draft writes. */
export async function suggestAutoBatch(targets: AutoPromptTarget[], prompt: string, signal: AbortSignal,
  request: (target: AutoPromptTarget, prompt: string, signal: AbortSignal) => Promise<AutoPromptProposal>,
  progress: (completed: number) => void = () => {},
): Promise<AutoBatchProposal> {
  signal.throwIfAborted();
  if (!targets.length) throw new Error('Check videos in the source list, or change Apply changes to.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const proposals: AutoPromptProposal[] = new Array(targets.length);
  let cursor = 0, completed = 0;
  try {
    // The prompt API permits two in-flight suggestions across the workspace.
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
      while (cursor < targets.length) {
        controller.signal.throwIfAborted();
        const index = cursor++, target = targets[index]!;
        try { proposals[index] = await request(target, prompt, controller.signal); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          const failure = new Error(`${target.name}: ${error instanceof Error ? error.message : 'The proposal could not be prepared.'} No videos were changed.`);
          controller.abort(failure);
          throw failure;
        }
        controller.signal.throwIfAborted();
        progress(++completed);
      }
    }));
    signal.throwIfAborted();
    const reviewGroups = targets.map((target, index) => ({ title: target.name,
      summary: proposals[index]!.unchanged ? ['Already matches; no changes needed.'] : proposals[index]!.summary }));
    const blocked = proposals.flatMap((proposal, index) => proposal.clarification ? [`${targets[index]!.name}: ${proposal.clarification}`] : []);
    const changes = proposals.flatMap((proposal, index) => proposal.unchanged ? [] : [{ id: targets[index]!.id, proposal }]);
    const manualCount = changes.filter(change => change.proposal.manual).length;
    if (manualCount && manualCount !== changes.length) blocked.push('These edits need different workspaces. Use a request supported in Auto for every video, or edit the videos separately.');
    return { changes: blocked.length ? [] : changes, reviewGroups,
      summary: blocked.length || !changes.length ? [] : [`Apply changes to ${changes.length} video${changes.length === 1 ? '' : 's'}${manualCount ? ' in Manual' : ''}.${changes.length < targets.length ? ` ${targets.length - changes.length} already match.` : ''}`],
      clarification: blocked.length ? blocked.join('\n\n') : !changes.length ? 'All target videos already match. No changes needed.' : undefined };
  } finally { signal.removeEventListener('abort', abort); }
}
