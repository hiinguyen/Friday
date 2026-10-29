import { h } from '../ui/dom.js';
import { compatibleTemplates } from '../../../shared/render/registry.js';
import { THEMES, THEME_IDS } from '../../../shared/render/themes.js';
import { setTemplate, setStyle } from '../../../shared/spec/ops.js';
import { currentSpec } from '../state.js';
import { thumbnail } from './canvas.js';

const DENSITY_OPTIONS = [['compact', 'Gọn'], ['normal', 'Vừa'], ['airy', 'Thoáng']];
const THUMB_DELAY_MS = 150;

// Template thumbnails are live renders of the current spec, so they are drawn lazily: only
// when visible, and again (debounced) after the spec changes.
export function mount(el, { actions, fontSet }) {
  const templateGrid = h('div', { class: 'template-grid' });
  const themeGrid = h('div', { class: 'theme-grid' });
  const densityGroup = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Mật độ' });
  el.append(
    h('section', { class: 'picker' }, h('h2', { class: 'pane-title', text: 'Kiểu sơ đồ' }), templateGrid),
    h('section', { class: 'picker' }, h('h2', { class: 'pane-title', text: 'Màu sắc' }), themeGrid),
    h('section', { class: 'picker' }, h('h2', { class: 'pane-title', text: 'Mật độ' }), densityGroup),
  );

  const templateButtons = new Map();
  const visible = new Set();
  let spec = null;
  let thumbTimer = null;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.dataset.template;
      if (entry.isIntersecting) visible.add(id);
      else visible.delete(id);
    }
    scheduleThumbs();
  });

  function drawThumbs() {
    thumbTimer = null;
    if (!spec) return;
    for (const id of visible) {
      const entry = templateButtons.get(id);
      const key = JSON.stringify([spec.nodes, spec.edges, spec.title, spec.subtitle, spec.style]);
      if (!entry || entry.button.disabled || entry.key === key) continue;
      entry.key = key;
      entry.thumb.replaceChildren(thumbnail(setTemplate(spec, id), fontSet));
    }
  }

  function scheduleThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(drawThumbs, THUMB_DELAY_MS);
  }

  function ensureTemplateButtons(list) {
    if (templateButtons.size > 0) return;
    for (const template of list) {
      const thumb = h('span', { class: 'template-thumb' });
      const reason = h('span', { class: 'visually-hidden' });
      const button = h('button', {
        class: 'template-option', type: 'button', 'data-template': template.id,
        onClick: () => actions.edit((current) => setTemplate(current, template.id)),
      }, thumb, h('span', { class: 'option-label', text: template.label }), reason);
      templateButtons.set(template.id, { button, thumb, reason, key: null });
      templateGrid.append(button);
      observer.observe(button);
    }
  }

  for (const id of THEME_IDS) {
    const theme = THEMES[id];
    const strip = h('span', { class: 'swatch-strip' }, theme.accents.map((color) => h('span', { style: { background: color } })));
    themeGrid.append(h('button', {
      class: 'theme-option', type: 'button', 'data-theme': id,
      onClick: () => actions.edit((current) => setStyle(current, { theme: id })),
    }, h('span', { class: 'swatch', style: { background: theme.background } }, strip), h('span', { class: 'option-label', text: theme.label })));
  }
  for (const [id, label] of DENSITY_OPTIONS) {
    densityGroup.append(h('button', {
      class: 'segment', type: 'button', 'data-density': id,
      onClick: () => actions.edit((current) => setStyle(current, { density: id })),
    }, label));
  }

  function update(state) {
    spec = currentSpec(state);
    el.hidden = !spec;
    if (!spec) return;
    const list = compatibleTemplates(spec);
    ensureTemplateButtons(list);
    for (const template of list) {
      const entry = templateButtons.get(template.id);
      entry.button.disabled = !template.ok;
      entry.button.title = template.ok ? template.label : template.reason;
      entry.reason.textContent = template.ok ? '' : `: ${template.reason}`;
      entry.button.setAttribute('aria-pressed', String(spec.template === template.id));
      if (!template.ok) {
        entry.thumb.replaceChildren();
        entry.key = null;
      }
    }
    for (const button of themeGrid.children) button.setAttribute('aria-pressed', String((spec.style?.theme ?? 'classic') === button.dataset.theme));
    for (const button of densityGroup.children) button.setAttribute('aria-pressed', String((spec.style?.density ?? 'normal') === button.dataset.density));
    scheduleThumbs();
  }

  return { update };
}
