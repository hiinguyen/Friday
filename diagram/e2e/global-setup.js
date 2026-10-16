import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocx } from '../test/helpers/office.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Same content as the docx export test: two headed sections.
export default async function globalSetup() {
  await fs.mkdir(FIXTURES, { recursive: true });
  const docx = await buildDocx([
    { text: 'Quy trình', heading: 1 }, 'Nghiên cứu.', 'Thiết kế.', 'Phát triển.',
    { text: 'Đo lường', heading: 1 }, 'Theo dõi số liệu.', 'Báo cáo hằng tuần.',
  ]);
  await fs.writeFile(path.join(FIXTURES, 'plan.docx'), docx);
}
