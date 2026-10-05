import { EMPTY_FILTERS, REVIEW_LABELS, type LibraryFilters as Filters } from '../shared/library';

export default function LibraryFilters({ value, onChange, projects }: { value: Filters; onChange: (value: Filters) => void; projects: string[] }) {
  const update = (key: keyof Filters, next: string) => onChange({ ...value, [key]: next });
  return <div className="library-filters" role="search" aria-label="Filter exports">
    <label className="library-search">Search<input type="search" maxLength={200} placeholder="Title, source or project…" value={value.search} onChange={e => update('search', e.target.value)} /></label>
    <label>Decision<select value={value.review} onChange={e => update('review', e.target.value)}>{Object.entries(REVIEW_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>Publication<select value={value.publication} onChange={e => update('publication', e.target.value)}><option value="all">All publishing states</option><option value="unpublished">Unpublished</option><option value="scheduled">Scheduled / in progress</option><option value="published">Published</option></select></label>
    <label>Format<select value={value.aspect} onChange={e => update('aspect', e.target.value)}><option value="">All formats</option>{['9:16','16:9','1:1','4:5','original'].map(aspect => <option key={aspect} value={aspect}>{aspect === 'original' ? 'Original ratio' : aspect}</option>)}</select></label>
    <label>Project<select value={value.project} onChange={e => update('project', e.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project}>{project}</option>)}</select></label>
    <label>From<input type="date" value={value.after} max={value.before || undefined} onChange={e => update('after', e.target.value)} /></label>
    <label>Through<input type="date" value={value.before} min={value.after || undefined} onChange={e => update('before', e.target.value)} /></label>
    {JSON.stringify(value) !== JSON.stringify(EMPTY_FILTERS) && <button className="secondary-button" onClick={() => onChange({ ...EMPTY_FILTERS })}>Clear filters</button>}
  </div>;
}
