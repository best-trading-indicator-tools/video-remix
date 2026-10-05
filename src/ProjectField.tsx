import { useEffect, useState } from 'react';
import { apiRequest } from './api-client';
import ProblemNotice from './ProblemNotice';

export default function ProjectField({ value, endpoint, onSaved }: { value?: string; endpoint: string; onSaved: (project: string) => void }) {
  const [project, setProject] = useState(value || ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => setProject(value || ''), [value, endpoint]);
  return <form className="project-field" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await apiRequest(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) }); onSaved(project.trim()); }
    catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
  }}><label>Project<input value={project} maxLength={60} placeholder="Add a project…" onChange={event => setProject(event.target.value)} disabled={busy} /></label><button className="secondary-button" disabled={busy || project.trim() === (value || '')}>{busy ? 'Saving…' : 'Save'}</button>{error && <ProblemNotice message={error} operation="Save project" />}</form>;
}
