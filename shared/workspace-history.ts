/** Session history of editing decisions. Media files and render jobs live outside it. */
export type HistoryContext = { mode: "auto" | "manual" | "shorts"; sourceId?: string; draftId?: string };
type Change = { before: unknown; after: unknown };
type Entry = { id: number; label: string; context?: HistoryContext; redoContext?: HistoryContext; group?: object; changes: Map<string, Change> };
const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
export class WorkspaceHistory {
  private values = new Map<string, unknown>();
  private writers = new Map<string, (value: any) => void>();
  private listeners = new Set<() => void>();
  private past: Entry[] = [];
  private future: Entry[] = [];
  private pending?: Entry;
  private sequence = 0;
  private revision = 0;
  private nextLabel?: string;
  group?: object;
  context?: HistoryContext;
  restoredContext?: HistoryContext;
  restoreSequence = 0;
  constructor(private limit = 100) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.revision;
  private emit() { this.revision++; this.listeners.forEach(listener => listener()); }
  init<T>(key: string, initial: T | (() => T), persist?: (value: T) => void): T {
    if (!this.values.has(key)) this.values.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    if (persist) this.writers.set(key, persist);
    return this.get<T>(key);
  }
  get<T>(key: string) { return this.values.get(key) as T; }
  label(label: string) { this.nextLabel = label; if (this.pending) this.pending.label = label; queueMicrotask(() => { this.nextLabel = undefined; }); }
  labelDefault(label: string) { if (!this.nextLabel) this.label(label); }
  navigateOnRedo(context: HistoryContext) { if (this.pending) this.pending.redoContext = context; }
  set<T>(key: string, update: T | ((value: T) => T), label: string) {
    const before = this.get<T>(key), after = typeof update === "function" ? (update as (value: T) => T)(before) : update;
    if (equal(before, after)) return;
    this.writers.get(key)?.(after);
    if (!this.pending) {
      this.pending = { id: ++this.sequence, label: this.nextLabel || label, context: this.context && { ...this.context }, group: this.group, changes: new Map() };
      queueMicrotask(() => this.flush());
    }
    const previous = this.pending.changes.get(key);
    this.pending.changes.set(key, { before: previous ? previous.before : before, after });
    this.values.set(key, after); this.future = []; this.emit();
  }
  flush() {
    const entry = this.pending; this.pending = undefined;
    if (!entry) return;
    const last = this.past.at(-1);
    if (entry.group && last?.group === entry.group && equal(last.context, entry.context)) {
      for (const [key, change] of entry.changes) {
        const previous = last.changes.get(key);
        last.changes.set(key, { before: previous ? previous.before : change.before, after: change.after });
      }
      this.prune(last);
      if (!last.changes.size) this.past.pop();
    } else {
      this.prune(entry);
      if (entry.changes.size) this.past.push(entry);
      if (this.past.length > this.limit) this.past.shift();
    }
    this.emit();
  }
  private prune(entry: Entry) { for (const [key, change] of entry.changes) if (equal(change.before, change.after)) entry.changes.delete(key); }
  /** Apply external facts to every snapshot: imports, deleted media, background analysis. */
  rebase<T>(key: string, update: (value: T) => T) {
    this.flush();
    const next = update(this.get<T>(key)); if (!equal(next, this.get(key))) this.writers.get(key)?.(next); this.values.set(key, next);
    for (const entry of [...this.past, ...this.future]) {
      const change = entry.changes.get(key);
      if (change) { change.before = update(change.before as T); change.after = update(change.after as T); this.prune(entry); }
    }
    this.past = this.past.filter(entry => entry.changes.size); this.future = this.future.filter(entry => entry.changes.size);
    this.emit();
  }
  isApplied(id?: number) { return !!id && (this.pending?.id === id || this.past.some(entry => entry.id === id)); }
  get undoLabel() { return this.pending?.label || this.past.at(-1)?.label; }
  get redoLabel() { return this.future.at(-1)?.label; }
  get undoId() { return this.pending?.id || this.past.at(-1)?.id; }
  undo = () => this.restore(false);
  redo = () => this.restore(true);
  private restore(redo: boolean) {
    this.flush(); this.group = undefined;
    const from = redo ? this.future : this.past, to = redo ? this.past : this.future;
    const entry = from.at(-1); if (!entry) return;
    // Check persistent preset storage before changing the workspace.
    for (const [key, change] of entry.changes) this.writers.get(key)?.(redo ? change.after : change.before);
    from.pop(); to.push(entry);
    for (const [key, change] of entry.changes) this.values.set(key, redo ? change.after : change.before);
    const context = redo ? entry.redoContext || entry.context : entry.context;
    this.restoreSequence++;
    this.restoredContext = context; this.emit(); return { ...entry, context };
  }
}
