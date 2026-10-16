import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

const ID_PATTERN = /^p_\d{8}_[0-9a-f]{6}$/;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  const day = nowIso().slice(0, 10).replace(/-/g, '');
  return `p_${day}_${crypto.randomBytes(3).toString('hex')}`;
}

function summary(project) {
  const diagrams = Object.values(project.diagrams ?? {});
  return {
    id: project.id,
    title: project.document.title,
    format: project.document.format,
    updatedAt: project.updatedAt,
    sectionCount: (project.sections ?? []).length,
    diagramCount: diagrams.filter((entry) => entry && entry.chosen).length,
  };
}

export function createStore(dataDir, { maxProjects = 500 } = {}) {
  const projectsDir = path.join(dataDir, 'projects');

  function projectDir(id) {
    if (!ID_PATTERN.test(String(id ?? ''))) throw new AppError('not_found');
    return path.join(projectsDir, id);
  }

  async function countProjects() {
    try {
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).length;
    } catch {
      return 0;
    }
  }

  async function writeProject(project) {
    const dir = projectDir(project.id);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, 'project.json');
    const temp = path.join(dir, `project.json.${crypto.randomBytes(3).toString('hex')}.tmp`);
    await fs.writeFile(temp, JSON.stringify(project, null, 2));
    await fs.rename(temp, target);
  }

  return {
    async create({ document, source = null }) {
      if (await countProjects() >= maxProjects) {
        throw new AppError('bad_input', `Đã đạt giới hạn ${maxProjects} dự án. Hãy xoá bớt dự án cũ.`);
      }
      const timestamp = nowIso();
      const project = {
        id: newId(),
        createdAt: timestamp,
        updatedAt: timestamp,
        document,
        sourceFile: source ? `source.${source.ext}` : null,
        answers: [],
        pendingQuestions: null,
        sections: [],
        diagrams: {},
      };
      const dir = projectDir(project.id);
      await fs.mkdir(dir, { recursive: true });
      if (source) await fs.writeFile(path.join(dir, project.sourceFile), source.buffer);
      await writeProject(project);
      return project;
    },

    async get(id) {
      const dir = projectDir(id);
      try {
        return JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8'));
      } catch {
        throw new AppError('not_found');
      }
    },

    async save(project) {
      const next = { ...project, updatedAt: nowIso() };
      await writeProject(next);
      return next;
    },

    async list() {
      let entries;
      try {
        entries = await fs.readdir(projectsDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const projects = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          projects.push(JSON.parse(await fs.readFile(path.join(projectsDir, entry.name, 'project.json'), 'utf8')));
        } catch {
          /* skip a half-written project */
        }
      }
      return projects
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 50)
        .map(summary);
    },

    async remove(id) {
      const dir = projectDir(id);
      try {
        await fs.rm(dir, { recursive: true, force: false });
      } catch {
        throw new AppError('not_found');
      }
    },

    async readSource(project) {
      if (!project.sourceFile) throw new AppError('not_found');
      return fs.readFile(path.join(projectDir(project.id), project.sourceFile));
    },
  };
}
