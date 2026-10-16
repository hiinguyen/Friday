import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell } from 'docx';
import PptxGenJS from 'pptxgenjs';

const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6, title: HeadingLevel.TITLE };

export async function buildDocx(paragraphs) {
  const children = paragraphs.map((p) => {
    if (typeof p === 'string') return new Paragraph(p);
    if (p.table) return new Table({ rows: p.table.map((row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })) })) });
    if (p.bullet) return new Paragraph({ text: p.bullet, bullet: { level: 0 } });
    return new Paragraph({ text: p.text, heading: HEADINGS[p.heading] });
  });
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

export async function buildPptx(slides) {
  const pptx = new PptxGenJS();
  for (const slide of slides) {
    const s = pptx.addSlide();
    s.addText(slide.title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 28 });
    if (slide.lines.length > 0) s.addText(slide.lines.join('\n'), { x: 0.5, y: 1.3, w: 9, h: 4, fontSize: 16 });
  }
  return pptx.write({ outputType: 'nodebuffer' });
}
