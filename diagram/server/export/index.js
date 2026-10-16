import { AppError } from '../errors.js';
import { exportSvg } from './svg.js';
import { exportPng } from './png.js';
import { exportPdf } from './pdf.js';
import { exportMarkdownZip } from './markdown-zip.js';

export { exportSvg, exportPng, exportPdf, exportMarkdownZip };

export function chosenDiagrams(project, sectionIds = null) {
  const filter = sectionIds ? new Set(sectionIds) : null;
  const result = [];
  for (const section of project.sections ?? []) {
    if (filter && !filter.has(section.id)) continue;
    const chosen = project.diagrams?.[section.id]?.chosen;
    if (chosen) result.push({ section, spec: chosen });
  }
  return result;
}

export function exportFileName(project, suffix) {
  const slug = String(project.document?.title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'diagram'}${suffix}`;
}

export async function renderExport({ format, project, diagrams, fontSet, transparent }) {
  const first = diagrams[0];
  switch (format) {
    case 'svg':
      return { buffer: Buffer.from(exportSvg(first.spec, fontSet)), contentType: 'image/svg+xml; charset=utf-8', suffix: `-${first.section.id}.svg` };
    case 'png':
      return { buffer: exportPng(first.spec, fontSet, { transparent }), contentType: 'image/png', suffix: `-${first.section.id}.png` };
    case 'pdf':
      return { buffer: await exportPdf(diagrams.map((entry) => entry.spec), fontSet, { title: project.document.title }), contentType: 'application/pdf', suffix: '.pdf' };
    case 'zip': {
      const pngs = Object.fromEntries(diagrams.map((entry) => [entry.section.id, exportPng(entry.spec, fontSet)]));
      return { buffer: await exportMarkdownZip(project, pngs, diagrams.map((entry) => entry.section)), contentType: 'application/zip', suffix: '.zip' };
    }
    default:
      throw new AppError('bad_input');
  }
}
