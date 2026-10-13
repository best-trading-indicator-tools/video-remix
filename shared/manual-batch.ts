import type { AutoDraft } from './auto-batch.js';
import type { RemixSettings } from './types.js';

export type ManualPromptTarget = { id: string; name: string; settings: RemixSettings };
export type ManualProposal = { settings: RemixSettings; auto?: AutoDraft; summary: string[]; clarification?: string; unchanged?: boolean };
export type ManualBatchProposal = { changes: { id: string; proposal: ManualProposal }[]; summary: string[]; clarification?: string; reviewGroups: { title: string; summary: string[] }[] };

/** Review every target atomically using its own settings; the prompt API allows two requests at once. */
export async function suggestManualBatch(targets: ManualPromptTarget[], prompt: string, signal: AbortSignal,
  request: (target: ManualPromptTarget, prompt: string, signal: AbortSignal) => Promise<ManualProposal>,
  progress: (count: number) => void = () => {},
): Promise<ManualBatchProposal> {
  signal.throwIfAborted();
  if (!targets.length) throw new Error('Check videos in the source list to edit and export them.');
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const proposals: ManualProposal[] = new Array(targets.length);
  let cursor = 0, completed = 0;
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
    while (cursor < targets.length) {
      combined.throwIfAborted();
      const index = cursor++, target = targets[index]!;
      try { proposals[index] = await request(target, prompt, combined); }
      catch (error) {
        if (combined.aborted) throw error;
        const failure = new Error(`${target.name}: ${error instanceof Error ? error.message : 'The proposal could not be prepared.'} No videos were changed.`);
        controller.abort(failure); throw failure;
      }
      combined.throwIfAborted(); progress(++completed);
    }
  }));
  signal.throwIfAborted();
  const blocked = proposals.flatMap((proposal, index) => proposal.clarification && !proposal.unchanged ? [`${targets[index]!.name}: ${proposal.clarification}`] : []);
  const changes = proposals.flatMap((proposal, index) => proposal.auto || proposal.summary.length ? [{ id: targets[index]!.id, proposal }] : []);
  const switching = changes.filter(change => change.proposal.auto).length;
  if (switching && switching !== changes.length) blocked.push('These edits need different workspaces. Use a request supported in one workspace for every video.');
  return { changes: blocked.length ? [] : changes, summary: !blocked.length && changes.length ? [`Apply changes to ${changes.length} video${changes.length === 1 ? '' : 's'}${switching ? ' in Auto' : ''}.`] : [],
    clarification: blocked.length ? blocked.join('\n\n') : !changes.length ? 'All target videos already match. No changes needed.' : undefined,
    reviewGroups: targets.map((target, index) => ({ title: target.name, summary: proposals[index]!.summary.length ? proposals[index]!.summary : ['Already matches; no changes needed.'] })) };
}
