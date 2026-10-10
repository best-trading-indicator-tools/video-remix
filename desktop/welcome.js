const api = window.remixDesktop;
const selected = new Set();
let initialized = false;
const tools = document.getElementById('tools');
function render(state) {
  if (!initialized && state.components.length) { for (const item of state.components) if (item.recommended && !item.ready) selected.add(item.id); initialized = true; }
  tools.replaceChildren(...state.components.map(item => {
    const label = document.createElement('label'); label.className = 'tool';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(item.id); input.disabled = state.busy;
    input.addEventListener('change', () => { if (input.checked) selected.add(item.id); else selected.delete(item.id); document.getElementById('install').disabled = !selected.size || state.busy; });
    const copy = document.createElement('span'), title = document.createElement('strong'), description = document.createElement('small');
    title.textContent = item.name + (item.ready ? ' · Ready' : ''); if (item.ready) title.className = 'ready';
    description.textContent = item.description; copy.append(title, description); label.append(input, copy); return label;
  }));
  document.getElementById('phase').textContent = state.phase;
  const progress = document.getElementById('progress'); progress.max = state.total; progress.value = state.completed;
  document.getElementById('error').textContent = state.error;
  document.getElementById('logs').textContent = state.logs.join('\n');
  document.getElementById('install').disabled = state.busy || !selected.size || !state.engineReady;
  document.getElementById('install').textContent = state.busy ? 'Installing…' : state.error ? 'Retry selected tools' : 'Install selected tools';
  document.getElementById('studio').disabled = !state.engineReady;
  document.getElementById('cancel').hidden = !state.busy;
}
const showError = error => { document.getElementById('error').textContent = error.message; };
document.getElementById('install').addEventListener('click', () => api.install([...selected]).then(render).catch(showError));
document.getElementById('studio').addEventListener('click', () => api.openStudio().catch(showError));
document.getElementById('cancel').addEventListener('click', () => api.cancel().catch(showError));
api.onState(render); api.getState().then(render).catch(showError);
