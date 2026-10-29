import { AppError, ok } from '../errors.js';
import { shouldSkipSegment, singleSection } from '../agent/tasks.js';
import { validateSpec } from '../../shared/spec/validate.js';

export function mergeAnswers(existing, incoming) {
  const result = [...(existing ?? [])];
  for (const answer of incoming ?? []) {
    const index = result.findIndex((entry) => entry.questionId === answer.questionId);
    if (index === -1) result.push(answer);
    else result[index] = answer;
  }
  return result;
}

export function findSection(project, sectionId) {
  const section = (project.sections ?? []).find((entry) => entry.id === sectionId);
  if (!section) throw new AppError('not_found');
  return section;
}

// An agent call takes seconds, and the editor keeps saving diagrams meanwhile. Apply each
// result to a fresh read of the project, never to the copy read before the call.
async function latest(store, project) {
  return store.get(project.id);
}

export async function runAgent(locks, agent, project, task, context) {
  const controller = locks.acquire(project.id);
  try {
    return await agent.run(task, context, { signal: controller.signal });
  } finally {
    locks.release(project.id, controller);
  }
}

export function registerAgentRoutes(app, { store, agent, locks, maxCallsPerMinute = 20 }) {
  const limit = { config: { rateLimit: { max: maxCallsPerMinute, timeWindow: '1 minute' } } };

  app.post('/projects/:id/segment', limit, async (request) => {
    const project = await store.get(request.params.id);
    project.answers = mergeAnswers(project.answers, request.body?.answers);
    project.pendingQuestions = null;
    if (shouldSkipSegment(project.document)) {
      project.sections = [singleSection(project.document)];
      return ok(await store.save(project));
    }
    const result = await runAgent(locks, agent, project, 'segment', { document: project.document, answers: project.answers });
    const fresh = await latest(store, project);
    fresh.answers = project.answers;
    if (result.questions.length > 0) {
      fresh.pendingQuestions = { task: 'segment', sectionId: null, questions: result.questions };
    } else {
      fresh.sections = result.sections;
      fresh.pendingQuestions = null;
    }
    return ok(await store.save(fresh));
  });

  app.post('/projects/:id/sections/:sid/generate', limit, async (request) => {
    const project = await store.get(request.params.id);
    const section = findSection(project, request.params.sid);
    project.answers = mergeAnswers(project.answers, request.body?.answers);
    project.pendingQuestions = null;
    const result = await runAgent(locks, agent, project, 'generate', { document: project.document, section, answers: project.answers });
    const fresh = await latest(store, project);
    fresh.answers = project.answers;
    if (result.questions.length > 0) {
      fresh.pendingQuestions = { task: 'generate', sectionId: section.id, questions: result.questions };
    } else {
      fresh.pendingQuestions = null;
      fresh.diagrams[section.id] = { candidates: result.candidates, chosen: null };
    }
    return ok(await store.save(fresh));
  });

  app.put('/projects/:id/sections/:sid/diagram', async (request) => {
    const project = await store.get(request.params.id);
    const section = findSection(project, request.params.sid);
    const spec = request.body?.spec;
    const errors = validateSpec(spec);
    if (errors.length > 0) throw new AppError('bad_input', errors.slice(0, 3).join('; '));
    project.diagrams[section.id] = { ...(project.diagrams[section.id] ?? {}), chosen: { ...spec, sectionId: section.id } };
    return ok(await store.save(project));
  });

  app.post('/projects/:id/sections/:sid/refine', limit, async (request) => {
    const project = await store.get(request.params.id);
    const section = findSection(project, request.params.sid);
    const spec = request.body?.spec;
    if (!spec) throw new AppError('bad_input');
    const instruction = String(request.body?.instruction ?? '').slice(0, 500);
    const result = await runAgent(locks, agent, project, 'refine', { document: project.document, section, answers: project.answers, diagram: spec, instruction });
    const fresh = await latest(store, project);
    fresh.diagrams[section.id] = { ...(fresh.diagrams[section.id] ?? {}), chosen: result.spec };
    return ok(await store.save(fresh));
  });

  app.post('/projects/:id/cancel', async (request) => ok({ cancelled: locks.cancel(request.params.id) }));
}
