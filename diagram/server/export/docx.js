import { AppError } from '../errors.js';
import { NS, parseXml, serializeXml, childElements, descendants, attribute, openZip } from '../ingest/xml.js';

const BAD_FILE = 'Không đọc được tệp Office này.';
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function firstUnused(used, prefix) {
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function uniqueMediaName(zip, sectionId) {
  const base = `diagram-${sectionId}`;
  let name = `word/media/${base}.png`;
  let index = 2;
  while (zip.file(name)) {
    name = `word/media/${base}-${index}.png`;
    index += 1;
  }
  return name;
}

function pictureParagraph({ cx, cy, docPrId, rid, title, sectionId }) {
  return `<w:p xmlns:w="${NS.w}">
  <w:pPr><w:jc w:val="center"/></w:pPr>
  <w:r>
    <w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="${NS.wp}">
        <wp:extent cx="${cx}" cy="${cy}"/>
        <wp:docPr id="${docPrId}" name="Diagram ${docPrId}" descr="${escapeXml(title)}"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic xmlns:a="${NS.a}">
          <a:graphicData uri="${NS.pic}">
            <pic:pic xmlns:pic="${NS.pic}">
              <pic:nvPicPr><pic:cNvPr id="${docPrId}" name="diagram-${escapeXml(sectionId)}.png"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="${rid}" xmlns:r="${NS.r}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>`;
}

function textWidthTwips(body) {
  const sectPrs = descendants(body, NS.w, 'sectPr');
  const sectPr = sectPrs[sectPrs.length - 1];
  if (!sectPr) return 9026;
  const pageSize = descendants(sectPr, NS.w, 'pgSz')[0];
  const margins = descendants(sectPr, NS.w, 'pgMar')[0];
  const width = Number(attribute(pageSize, NS.w, 'w'));
  const left = Number(attribute(margins, NS.w, 'left') ?? 0);
  const right = Number(attribute(margins, NS.w, 'right') ?? 0);
  if (!Number.isFinite(width) || width <= 0) return 9026;
  return width - (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
}

export async function exportDocx(sourceBuffer, placements) {
  const zip = await openZip(sourceBuffer);
  const mainFile = zip.file('word/document.xml');
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (!mainFile || !contentTypesFile) throw new AppError('bad_input', BAD_FILE);

  const doc = parseXml(await mainFile.async('string'));
  const body = descendants(doc, NS.w, 'body')[0];
  if (!body) throw new AppError('bad_input', BAD_FILE);
  const children = childElements(body);

  const relsPath = 'word/_rels/document.xml.rels';
  const relsFile = zip.file(relsPath);
  const relsDoc = relsFile
    ? parseXml(await relsFile.async('string'))
    : parseXml(`<Relationships xmlns="${NS.rel}"/>`);
  const relationships = descendants(relsDoc, NS.rel, 'Relationship');
  const usedIds = new Set(relationships.map((rel) => attribute(rel, null, 'Id')));

  const docPrs = descendants(doc, NS.wp, 'docPr');
  let docPrId = docPrs.reduce((max, el) => Math.max(max, Number(attribute(el, null, 'id')) || 0), 1000);
  const pageWidthTwips = textWidthTwips(body);

  const ordered = [...placements].sort((a, b) => (b.bodyIndex ?? 0) - (a.bodyIndex ?? 0));
  for (const placement of ordered) {
    const mediaName = uniqueMediaName(zip, placement.sectionId);
    zip.file(mediaName, placement.png);
    const rid = firstUnused(usedIds, 'rIdDiagram');
    usedIds.add(rid);

    const relationship = relsDoc.createElementNS(NS.rel, 'Relationship');
    relationship.setAttribute('Id', rid);
    relationship.setAttribute('Type', IMAGE_REL);
    relationship.setAttribute('Target', mediaName.replace('word/media/', 'media/'));
    relsDoc.documentElement.appendChild(relationship);

    docPrId += 1;
    const cx = Math.min(pageWidthTwips * 635, Math.round(placement.width * 9525));
    const cy = Math.round((cx * placement.height) / placement.width);
    const fragment = parseXml(pictureParagraph({ cx, cy, docPrId, rid, title: placement.title, sectionId: placement.sectionId }));
    const node = doc.importNode(fragment.documentElement, true);
    const reference = children[placement.bodyIndex ?? 0];
    if (reference) body.insertBefore(node, reference.nextSibling);
    else body.appendChild(node);
  }

  const contentTypes = parseXml(await contentTypesFile.async('string'));
  const hasPng = descendants(contentTypes, NS.ct, 'Default').some((el) => attribute(el, null, 'Extension') === 'png');
  if (!hasPng) {
    const definition = contentTypes.createElementNS(NS.ct, 'Default');
    definition.setAttribute('Extension', 'png');
    definition.setAttribute('ContentType', 'image/png');
    contentTypes.documentElement.appendChild(definition);
  }

  zip.file('word/document.xml', serializeXml(doc));
  zip.file(relsPath, serializeXml(relsDoc));
  zip.file('[Content_Types].xml', serializeXml(contentTypes));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export { DOCX_CONTENT_TYPE };
