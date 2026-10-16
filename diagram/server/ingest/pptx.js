import path from 'node:path';
import { AppError } from '../errors.js';
import { NS, parseXml, descendants, textOfRuns, attribute, openZip, coreTitle } from './xml.js';

const BAD_FILE = 'Không đọc được tệp Office này.';

function resolveTarget(target) {
  const clean = target.startsWith('/') ? target.slice(1) : path.posix.join('ppt', target);
  return clean;
}

// One block per slide, in presentation order (p:sldIdLst), title first.
export async function parsePptx(buffer) {
  const zip = await openZip(buffer);
  const presentation = zip.file('ppt/presentation.xml');
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (!presentation || !relsFile) throw new AppError('bad_input', BAD_FILE);
  const presentationDoc = parseXml(await presentation.async('string'));
  const relsDoc = parseXml(await relsFile.async('string'));
  const rels = new Map(descendants(relsDoc, NS.rel, 'Relationship')
    .map((rel) => [attribute(rel, null, 'Id'), attribute(rel, null, 'Target')]));

  const blocks = [];
  const titles = [];
  const slideIds = descendants(presentationDoc, NS.p, 'sldId');
  for (let index = 0; index < slideIds.length; index += 1) {
    const rid = attribute(slideIds[index], NS.r, 'id');
    const target = rid ? rels.get(rid) : null;
    if (!target) continue;
    const part = resolveTarget(target);
    const file = zip.file(part);
    if (!file) continue;
    const slide = parseXml(await file.async('string'));
    const entries = [];
    for (const shape of descendants(slide, NS.p, 'sp')) {
      const placeholder = descendants(shape, NS.p, 'ph')[0];
      const type = placeholder ? attribute(placeholder, null, 'type') : null;
      const isTitleShape = type === 'title' || type === 'ctrTitle';
      for (const paragraph of descendants(shape, NS.a, 'p')) {
        const text = textOfRuns(paragraph, NS.a).trim();
        if (text !== '') entries.push({ text, isTitleShape });
      }
    }
    if (entries.length === 0) continue;
    const titleEntry = entries.find((entry) => entry.isTitleShape) ?? entries[0];
    const text = [titleEntry.text, ...entries.filter((entry) => entry !== titleEntry).map((entry) => entry.text)].join('\n');
    titles.push(titleEntry.text);
    blocks.push({ kind: 'slide', text, source: { slidePart: part, slideIndex: index } });
  }

  // The first slide title is the real deck title; docProps often carries junk like
  // "PptxGenJS Presentation". Fall back to the metadata only when no slide has text.
  const title = titles[0] ?? (await coreTitle(zip)) ?? null;
  return { blocks, title };
}
