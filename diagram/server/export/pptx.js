import path from 'node:path';
import { AppError } from '../errors.js';
import { NS, parseXml, serializeXml, descendants, attribute, openZip } from '../ingest/xml.js';

const BAD_FILE = 'Không đọc được tệp Office này.';
const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const PAGE_MARGIN = 0.05;

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolvePart(baseDir, target) {
  return target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(baseDir, target));
}

async function readRels(zip, partPath) {
  const dir = path.posix.dirname(partPath);
  const relsPath = path.posix.join(dir, '_rels', `${path.posix.basename(partPath)}.rels`);
  const file = zip.file(relsPath);
  if (!file) return [];
  const doc = parseXml(await file.async('string'));
  return descendants(doc, NS.rel, 'Relationship').map((rel) => {
    const target = attribute(rel, null, 'Target') ?? '';
    return { id: attribute(rel, null, 'Id'), type: attribute(rel, null, 'Type'), target, part: resolvePart(dir, target) };
  });
}

function firstUnused(used, prefix) {
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function uniqueMedia(zip, dir, base) {
  let name = `${dir}/${base}.png`;
  let index = 2;
  while (zip.file(name)) {
    name = `${dir}/${base}-${index}.png`;
    index += 1;
  }
  return name;
}

async function layoutType(zip, part) {
  const file = zip.file(part);
  if (!file) return null;
  const doc = parseXml(await file.async('string'));
  const root = descendants(doc, NS.p, 'sldLayout')[0] ?? doc.documentElement;
  return attribute(root, null, 'type');
}

async function chooseLayoutPart(zip, slidePart) {
  const layoutRel = (await readRels(zip, slidePart)).find((rel) => rel.type.endsWith('/slideLayout'));
  if (!layoutRel) return null;
  const layoutPart = layoutRel.part;
  const masterRel = (await readRels(zip, layoutPart)).find((rel) => rel.type.endsWith('/slideMaster'));
  if (!masterRel) return layoutPart;
  const candidates = (await readRels(zip, masterRel.part)).filter((rel) => rel.type.endsWith('/slideLayout')).map((rel) => rel.part);
  for (const wanted of ['blank', 'titleOnly']) {
    for (const part of candidates) {
      if ((await layoutType(zip, part)) === wanted) return part;
    }
  }
  return layoutPart;
}

function slideXml({ title, x, y, cx, cy }) {
  return `<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:pic>
        <p:nvPicPr><p:cNvPr id="2" name="Diagram" descr="${escapeXml(title)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
        <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      </p:pic>
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function slideRelsXml(layoutTarget, mediaTarget) {
  return `<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${LAYOUT_REL}" Target="${layoutTarget}"/><Relationship Id="rId2" Type="${IMAGE_REL}" Target="${mediaTarget}"/></Relationships>`;
}

const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';

export async function exportPptx(sourceBuffer, placements) {
  const zip = await openZip(sourceBuffer);
  const presFile = zip.file('ppt/presentation.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!presFile || !contentTypesFile) throw new AppError('bad_input', BAD_FILE);

  const presDoc = parseXml(await presFile.async('string'));
  const relsPath = 'ppt/_rels/presentation.xml.rels';
  const relsFile = zip.file(relsPath);
  const presRelsDoc = relsFile ? parseXml(await relsFile.async('string')) : parseXml(`<Relationships xmlns="${NS.rel}"/>`);
  const sldIdLst = descendants(presDoc, NS.p, 'sldIdLst')[0];
  if (!sldIdLst) throw new AppError('bad_input', BAD_FILE);

  const slideSize = descendants(presDoc, NS.p, 'sldSz')[0];
  const slideCx = Number(attribute(slideSize, null, 'cx')) || 12192000;
  const slideCy = Number(attribute(slideSize, null, 'cy')) || 6858000;

  const relElements = descendants(presRelsDoc, NS.rel, 'Relationship');
  const targetOfRel = new Map(relElements.map((rel) => [attribute(rel, null, 'Id'), resolvePart('ppt', attribute(rel, null, 'Target') ?? '')]));
  const usedRelIds = new Set(relElements.map((rel) => attribute(rel, null, 'Id')));

  const contentTypes = parseXml(await contentTypesFile.async('string'));
  let sldIds = descendants(sldIdLst, NS.p, 'sldId');
  let maxSlide = 0;
  for (const name of Object.keys(zip.files)) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (match) maxSlide = Math.max(maxSlide, Number(match[1]));
  }

  for (const placement of placements) {
    let sourceRelId = null;
    for (const [id, part] of targetOfRel) {
      if (part === placement.slidePart) {
        sourceRelId = id;
        break;
      }
    }
    const sourceSldId = sourceRelId ? sldIds.find((el) => attribute(el, NS.r, 'id') === sourceRelId) : null;
    if (!sourceRelId || !sourceSldId) continue;

    maxSlide += 1;
    const slidePart = `ppt/slides/slide${maxSlide}.xml`;
    const mediaName = uniqueMedia(zip, 'ppt/media', `diagram-${placement.sectionId}`);
    zip.file(mediaName, placement.png);

    const layoutPart = (await chooseLayoutPart(zip, placement.slidePart)) ?? 'ppt/slideLayouts/slideLayout1.xml';
    const availableW = slideCx * (1 - 2 * PAGE_MARGIN);
    const availableH = slideCy * (1 - 2 * PAGE_MARGIN);
    const ratio = Math.min(availableW / placement.width, availableH / placement.height);
    const cx = Math.round(placement.width * ratio);
    const cy = Math.round(placement.height * ratio);
    const x = Math.round((slideCx - cx) / 2);
    const y = Math.round((slideCy - cy) / 2);

    zip.file(slidePart, slideXml({ title: placement.title, x, y, cx, cy }));
    zip.file(`ppt/slides/_rels/slide${maxSlide}.xml.rels`, slideRelsXml(path.posix.relative('ppt/slides', layoutPart), path.posix.relative('ppt/slides', mediaName)));

    const newRelId = firstUnused(usedRelIds, 'rIdDiagram');
    usedRelIds.add(newRelId);
    const relElement = presRelsDoc.createElementNS(NS.rel, 'Relationship');
    relElement.setAttribute('Id', newRelId);
    relElement.setAttribute('Type', SLIDE_REL);
    relElement.setAttribute('Target', `slides/slide${maxSlide}.xml`);
    presRelsDoc.documentElement.appendChild(relElement);

    const maxId = sldIds.reduce((max, el) => Math.max(max, Number(attribute(el, null, 'id')) || 0), 0);
    const sldIdElement = presDoc.createElementNS(NS.p, 'p:sldId');
    sldIdElement.setAttribute('id', String(Math.max(maxId + 1, 256)));
    sldIdElement.setAttributeNS(NS.r, 'r:id', newRelId);
    sldIdLst.insertBefore(sldIdElement, sourceSldId.nextSibling);
    sldIds = descendants(sldIdLst, NS.p, 'sldId');

    const override = contentTypes.createElementNS(NS.ct, 'Override');
    override.setAttribute('PartName', `/${slidePart}`);
    override.setAttribute('ContentType', SLIDE_CONTENT_TYPE);
    contentTypes.documentElement.appendChild(override);
  }

  const hasPng = descendants(contentTypes, NS.ct, 'Default').some((el) => attribute(el, null, 'Extension') === 'png');
  if (!hasPng) {
    const definition = contentTypes.createElementNS(NS.ct, 'Default');
    definition.setAttribute('Extension', 'png');
    definition.setAttribute('ContentType', 'image/png');
    contentTypes.documentElement.appendChild(definition);
  }

  zip.file('ppt/presentation.xml', serializeXml(presDoc));
  zip.file(relsPath, serializeXml(presRelsDoc));
  zip.file('[Content_Types].xml', serializeXml(contentTypes));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export { PPTX_CONTENT_TYPE };
