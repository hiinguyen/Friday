import { AppError } from '../errors.js';
import { chosenDiagrams, exportFileName, renderExport, placementsFor } from '../export/index.js';
import { exportDocx, DOCX_CONTENT_TYPE } from '../export/docx.js';
import { exportPptx, PPTX_CONTENT_TYPE } from '../export/pptx.js';

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function registerExportRoutes(app, { store, fontSet }) {
  app.get('/api/projects/:id/export', async (request, reply) => {
    const project = await store.get(request.params.id);
    const format = String(request.query.format ?? '');
    const rawSections = request.query.sections;
    const sectionIds = typeof rawSections === 'string' && rawSections !== '' ? rawSections.split(',').filter(Boolean) : null;
    const transparent = request.query.transparent === '1';

    const diagrams = chosenDiagrams(project, sectionIds);
    if (diagrams.length === 0) throw new AppError('bad_input', 'Chưa có sơ đồ nào được chọn.');

    if (format === 'svg' || format === 'png') {
      if (diagrams.length !== 1) throw new AppError('bad_input', 'Chọn đúng một sơ đồ để xuất SVG hoặc PNG.');
    }
    if (format === 'docx' || format === 'pptx') {
      if (project.document.format !== format) throw new AppError('bad_input', 'Chỉ xuất được về đúng định dạng tệp gốc.');
      try {
        const source = await store.readSource(project);
        const placements = placementsFor(project, diagrams, fontSet);
        const buffer = format === 'docx' ? await exportDocx(source, placements) : await exportPptx(source, placements);
        reply.header('content-disposition', contentDisposition(exportFileName(project, `.${format}`)));
        return reply.type(format === 'docx' ? DOCX_CONTENT_TYPE : PPTX_CONTENT_TYPE).send(buffer);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('export_failed', undefined, { detail: error.message });
      }
    }

    let result;
    try {
      result = await renderExport({ format, project, diagrams, fontSet, transparent });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('export_failed', undefined, { detail: error.message });
    }
    reply.header('content-disposition', contentDisposition(exportFileName(project, result.suffix)));
    return reply.type(result.contentType).send(result.buffer);
  });
}
