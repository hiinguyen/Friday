import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function findSoffice() {
  for (const name of ['soffice', 'libreoffice']) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// Converts a document to PDF with headless LibreOffice, or returns null when it is not installed.
export async function convertWithSoffice(file) {
  const soffice = await findSoffice();
  if (!soffice) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-soffice-'));
  const profile = path.join(dir, 'profile');
  const outDir = path.join(dir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  try {
    await execFileAsync(soffice, [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, file], { timeout: 120000 });
  } catch {
    return null;
  }
  const pdf = path.join(outDir, `${path.basename(file).replace(/\.[^.]+$/, '')}.pdf`);
  try {
    await fs.access(pdf);
    return pdf;
  } catch {
    return null;
  }
}
