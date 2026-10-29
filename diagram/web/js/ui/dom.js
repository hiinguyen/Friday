// Element builder. Text children go through textContent, so user data is never parsed as HTML.
function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object') {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'dataset' && typeof value === 'object') Object.assign(el.dataset, value);
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// Parses SVG markup from our own renderer (it XML-escapes every text) into a live element,
// through DOMParser rather than innerHTML.
export function svgFromMarkup(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

// A 24x24 stroke icon from the shared icon table ([tag, attributes] pairs).
export function iconElement(shapes, { size = 18 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, String(value));
    svg.appendChild(shape);
  }
  return svg;
}

export function on(el, event, handler, options) {
  el.addEventListener(event, handler, options);
  return () => el.removeEventListener(event, handler, options);
}
