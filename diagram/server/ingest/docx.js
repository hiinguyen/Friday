import { AppError } from '../errors.js';
import { NS, parseXml, descendants, childElements, textOfRuns, attribute, openZip, coreTitle } from './xml.js';

const BAD_FILE = 'Không đọc được tệp Office này.';

// Heading level from w:pStyle (Heading1..6 or Title) or w:outlineLvl, else undefined.
function headingLevel(paragraph) {
  const pPr = descendants(paragraph, NS.w, 'pPr')[0];
  if (!pPr) return undefined;
  const pStyle = descendants(pPr, NS.w, 'pStyle')[0];
  if (pStyle) {
    const value = attribute(pStyle, NS.w, 'val') ?? '';
    const heading = /^heading\s?([1-6])$/i.exec(value);
    if (heading) return Number(heading[1]);
    if (/^title$/i.test(value)) return 1;
  }
  const outline = descendants(pPr, NS.w, 'outlineLvl')[0];
  if (outline) {
    const value = Number(attribute(outline, NS.w, 'val'));
    if (Number.isInteger(value) && value >= 0 && value <= 5) return value + 1;
  }
  return undefined;
}

function isListItem(paragraph) {
  return descendants(paragraph, NS.w, 'numPr').length > 0;
}

function tableText(table) {
  return descendants(table, NS.w, 'tr')
    .map((row) => childElements(row)
      .filter((cell) => cell.localName === 'tc')
      .map((cell) => textOfRuns(cell, NS.w).trim())
      .join(' | '))
    .join('\n');
}

export async function parseDocx(buffer) {
  const zip = await openZip(buffer);
  const main = zip.file('word/document.xml');
  if (!main) throw new AppError('bad_input', BAD_FILE);
  const doc = parseXml(await main.async('string'));
  const body = descendants(doc, NS.w, 'body')[0];
  if (!body) throw new AppError('bad_input', BAD_FILE);

  const blocks = [];
  let listItems = [];
  let listIndex = -1;
  const flushList = () => {
    const text = listItems.join('\n');
    if (text !== '') blocks.push({ kind: 'list', text, source: { bodyIndex: listIndex } });
    listItems = [];
    listIndex = -1;
  };

  childElements(body).forEach((element, index) => {
    if (element.namespaceURI === NS.w && element.localName === 'p') {
      const text = textOfRuns(element, NS.w).trim();
      if (isListItem(element)) {
        if (text !== '') {
          listItems.push(`- ${text}`);
          listIndex = index;
        }
        return;
      }
      flushList();
      if (text === '') return;
      const level = headingLevel(element);
      if (level !== undefined) blocks.push({ kind: 'heading', level, text, source: { bodyIndex: index } });
      else blocks.push({ kind: 'paragraph', text, source: { bodyIndex: index } });
      return;
    }
    if (element.namespaceURI === NS.w && element.localName === 'tbl') {
      flushList();
      const text = tableText(element).trim();
      if (text !== '') blocks.push({ kind: 'table', text, source: { bodyIndex: index } });
      return;
    }
    flushList();
  });
  flushList();

  // The first heading names the document better than docProps; use the metadata only when
  // there is no heading.
  const heading = blocks.find((block) => block.kind === 'heading');
  return { blocks, title: heading ? heading.text : await coreTitle(zip) };
}
