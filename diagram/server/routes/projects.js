import { AppError, ok } from '../errors.js';

function sourceFor(document, buffer) {
  if (document.format === 'docx' || document.format === 'pptx') return { buffer, ext: document.format };
  return null;
}

export function registerProjectRoutes(app, { store, ingest }) {
  app.get('/projects', async () => ok(await store.list()));

  app.post('/projects', async (request) => {
    if (request.isMultipart()) {
      const part = await request.file();
      if (!part) throw new AppError('bad_input');
      let buffer;
      try {
        buffer = await part.toBuffer();
      } catch (error) {
        throw new AppError('bad_input', 'Tệp lớn hơn 20 MB.', { detail: error.message });
      }
      if (part.file.truncated) throw new AppError('bad_input', 'Tệp lớn hơn 20 MB.');
      const document = await ingest.ingestFile({ filename: part.filename, buffer });
      return ok(await store.create({ document, source: sourceFor(document, buffer) }));
    }

    const body = request.body ?? {};
    if (typeof body.text === 'string') {
      if (body.text.length < 1 || body.text.length > 200000) throw new AppError('bad_input', 'Văn bản phải từ 1 đến 200.000 ký tự.');
      return ok(await store.create({ document: ingest.ingestText(body.text), source: null }));
    }
    if (typeof body.url === 'string' && body.url.trim() !== '') {
      const document = await ingest.ingestUrl(body.url.trim());
      return ok(await store.create({ document, source: null }));
    }
    throw new AppError('bad_input');
  });

  app.get('/projects/:id', async (request) => ok(await store.get(request.params.id)));

  app.delete('/projects/:id', async (request) => {
    await store.remove(request.params.id);
    return ok({ id: request.params.id });
  });

  app.post('/projects/:id/sections', async (request) => {
    const project = await store.get(request.params.id);
    const blockIds = request.body?.blockIds;
    if (!Array.isArray(blockIds) || blockIds.length === 0) throw new AppError('bad_input');
    const order = new Map(project.document.blocks.map((block, index) => [block.id, index]));
    if (blockIds.some((id) => !order.has(id))) throw new AppError('bad_input');
    const sorted = [...new Set(blockIds)].sort((a, b) => order.get(a) - order.get(b));
    const first = project.document.blocks.find((block) => block.id === sorted[0]);
    project.sections.push({
      id: `s${project.sections.length + 1}`,
      blockIds: sorted,
      title: first.text.slice(0, 60),
      summary: '',
      suggestedKinds: [],
    });
    return ok(await store.save(project));
  });
}
