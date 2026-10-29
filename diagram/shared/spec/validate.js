import { COLOR_SLOTS, DENSITY_NAMES, LIMITS, SPEC_VERSION } from './constants.js';
import { findCycleNode } from './tree.js';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

export function validateSpec(spec) {
  if (!isObject(spec)) return ['spec must be an object'];
  const errors = [];
  if (spec.version !== SPEC_VERSION) errors.push(`version must be ${SPEC_VERSION}`);
  if (!isText(spec.id)) errors.push('id must be a non-empty string');
  if (!isText(spec.template)) errors.push('template must be a non-empty string');
  if (!isText(spec.title)) errors.push('title must be a non-empty string');
  else if (spec.title.length > LIMITS.title) errors.push(`title must be at most ${LIMITS.title} characters`);
  if (typeof spec.subtitle !== 'string') errors.push('subtitle must be a string');
  else if (spec.subtitle.length > LIMITS.subtitle) errors.push(`subtitle must be at most ${LIMITS.subtitle} characters`);
  if (typeof spec.lang !== 'string') errors.push('lang must be a string');

  const nodes = spec.nodes;
  if (!Array.isArray(nodes)) {
    errors.push('nodes must be an array');
  } else {
    const ids = new Set();
    for (const node of nodes) {
      if (isObject(node) && isText(node.id) && !ids.has(node.id)) ids.add(node.id);
    }
    const seen = new Set();
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const at = `node ${index}`;
      if (!isObject(node)) {
        errors.push(`${at} must be an object`);
        continue;
      }
      if (!isText(node.id)) errors.push(`${at} id must be a non-empty string`);
      else if (seen.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
      else seen.add(node.id);
      if (!isText(node.label)) errors.push(`${at} label must be a non-empty string`);
      else if (node.label.length > LIMITS.label) errors.push(`${at} label must be at most ${LIMITS.label} characters`);
      if (typeof node.detail !== 'string') errors.push(`${at} detail must be a string`);
      else if (node.detail.length > LIMITS.detail) errors.push(`${at} detail must be at most ${LIMITS.detail} characters`);
      if (typeof node.icon !== 'string') errors.push(`${at} icon must be a string`);
      if (node.parent !== null && !ids.has(node.parent)) errors.push(`${at} parent must be null or the id of another node`);
      if (node.value !== null && !(typeof node.value === 'number' && Number.isFinite(node.value))) errors.push(`${at} value must be null or a finite number`);
      if (typeof node.emphasis !== 'boolean') errors.push(`${at} emphasis must be a boolean`);
      if (node.color !== null && !COLOR_SLOTS.includes(node.color)) errors.push(`${at} color must be null or a palette slot`);
    }
    if (findCycleNode(nodes) !== null) errors.push('node parents form a cycle');
  }

  if (!Array.isArray(spec.edges)) {
    errors.push('edges must be an array');
  } else {
    const ids = new Set(Array.isArray(nodes) ? nodes.filter((node) => isObject(node) && isText(node.id)).map((node) => node.id) : []);
    for (const edge of spec.edges) {
      if (!isObject(edge)) {
        errors.push('each edge must be an object');
        continue;
      }
      if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push('edge must connect two node ids');
      if (typeof edge.label !== 'string') errors.push('edge label must be a string');
    }
  }

  if (!isObject(spec.style)) {
    errors.push('style must be an object');
  } else {
    if (typeof spec.style.theme !== 'string') errors.push('style theme must be a string');
    if (!DENSITY_NAMES.includes(spec.style.density)) errors.push(`density must be one of ${DENSITY_NAMES.join(', ')}`);
  }

  if (!Array.isArray(spec.locks)) {
    errors.push('locks must be an array');
  } else if (spec.locks.some((lock) => typeof lock !== 'string')) {
    errors.push('locks must be strings');
  }

  return errors;
}
