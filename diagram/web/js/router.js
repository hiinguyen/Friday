export function parseRoute(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const section = /^\/p\/([^/]+)\/s\/([^/]+)\/?$/.exec(raw);
  if (section) return { name: 'project', projectId: decodeURIComponent(section[1]), sectionId: decodeURIComponent(section[2]) };
  const project = /^\/p\/([^/]+)\/?$/.exec(raw);
  if (project) return { name: 'project', projectId: decodeURIComponent(project[1]), sectionId: null };
  return { name: 'home' };
}

export function onRoute(fn) {
  const run = () => fn(parseRoute(window.location.hash));
  window.addEventListener('hashchange', run);
  run();
}

export function go(path) {
  const next = path.startsWith('#') ? path : `#${path}`;
  if (window.location.hash === next) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else window.location.hash = next;
}
