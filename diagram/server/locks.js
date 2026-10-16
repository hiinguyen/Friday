import { AppError } from './errors.js';

export function createLocks() {
  const running = new Map();
  return {
    acquire(projectId) {
      if (running.has(projectId)) throw new AppError('busy');
      const controller = new AbortController();
      running.set(projectId, controller);
      return controller;
    },
    release(projectId, controller) {
      if (running.get(projectId) === controller) running.delete(projectId);
    },
    cancel(projectId) {
      const controller = running.get(projectId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}
