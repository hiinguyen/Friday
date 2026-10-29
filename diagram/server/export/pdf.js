import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';
import { layoutSpec, paintScene } from '../../shared/render/render.js';

export function exportPdf(specs, fontSet, { title = null } = {}) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false, compress: false, ...(title ? { info: { Title: title } } : {}) });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    try {
      for (const spec of specs) {
        const scene = layoutSpec(spec, fontSet);
        const svg = paintScene(scene, spec, fontSet, { textAsPaths: true, background: true });
        document.addPage({ size: [scene.width, scene.height], margin: 0 });
        SVGtoPDF(document, svg, 0, 0, { width: scene.width, height: scene.height });
      }
      document.end();
    } catch (error) {
      reject(error);
    }
  });
}
