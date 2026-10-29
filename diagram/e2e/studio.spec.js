import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCREENS = path.join(ROOT, 'test-results', 'screens');
const ASKING_TEXT = [
  '# Quy trình tuyển dụng', 'Sàng lọc hồ sơ ứng viên. [[hỏi]]', 'Phỏng vấn với trưởng nhóm.', 'Gửi thư mời nhận việc.',
  '# Hội nhập', 'Gặp gỡ đội ngũ.', 'Đào tạo quy trình nội bộ.',
].join('\n\n');
const PLAIN_TEXT = ASKING_TEXT.replace(' [[hỏi]]', '');

async function expectNoHorizontalScroll(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

// On narrow screens the sections live in a drawer that may be closed.
async function sectionButton(page, name) {
  const drawer = page.getByRole('button', { name: 'Nội dung', exact: true });
  if (await drawer.isVisible() && (await drawer.getAttribute('aria-expanded')) !== 'true') await drawer.click();
  return page.getByRole('list', { name: 'Các phần' }).getByRole('button', { name: new RegExp(name) });
}

async function pickFirstCandidate(page, sectionName) {
  await (await sectionButton(page, sectionName)).click();
  const candidates = page.getByRole('group', { name: 'Các phương án' }).getByRole('button');
  await expect(candidates).toHaveCount(3);
  await candidates.first().click();
  await expect(candidates.first()).toHaveAttribute('aria-pressed', 'true');
}

async function download(page, formatName) {
  await page.getByRole('button', { name: 'Xuất' }).click();
  const dialog = page.getByRole('dialog', { name: 'Xuất sơ đồ' });
  await dialog.getByRole('radio', { name: formatName }).check();
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Tải xuống' }).click()]);
  const target = path.join(os.tmpdir(), `diagram-e2e-${Date.now()}-${file.suggestedFilename()}`);
  await file.saveAs(target);
  return { name: file.suggestedFilename(), bytes: await fs.readFile(target) };
}

async function createEditedProject(request) {
  const created = await (await request.post('/api/projects', { data: { text: PLAIN_TEXT } })).json();
  const id = created.data.id;
  await request.post(`/api/projects/${id}/segment`, { data: { answers: [] } });
  const generated = await (await request.post(`/api/projects/${id}/sections/s1/generate`, { data: { answers: [] } })).json();
  await request.put(`/api/projects/${id}/sections/s1/diagram`, { data: { spec: generated.data.diagrams.s1.candidates[0] } });
  return id;
}

test('paste text, answer the question, pick a candidate, edit, finish, export PNG', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Nội dung văn bản').fill(ASKING_TEXT);
  await page.getByRole('button', { name: 'Tạo sơ đồ' }).click();

  const questions = page.getByRole('dialog', { name: 'AI cần bạn làm rõ' });
  await expect(questions).toBeVisible();
  await questions.getByRole('radio', { name: 'Các bước theo thứ tự' }).check();
  await questions.getByRole('button', { name: 'Gửi câu trả lời' }).click();

  await pickFirstCandidate(page, 'Quy trình tuyển dụng');
  const diagram = page.getByRole('img', { name: 'Quy trình tuyển dụng' });
  await expect(diagram.locator('[data-node-id="n1"]').first()).toBeAttached();

  await diagram.locator('[data-node-id="n1"][data-role="node-label"]').first().dblclick();
  await page.keyboard.type('Tự sửa');
  await page.keyboard.press('Enter');
  await expect(diagram.locator('text', { hasText: 'Tự sửa' })).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(diagram.locator('text', { hasText: 'Tự sửa' })).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z');
  await expect(diagram.locator('text', { hasText: 'Tự sửa' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Nửa đêm' }).click();
  await expect(diagram.locator('[data-role="background"]')).toHaveAttribute('fill', '#0e1424');
  await page.getByRole('button', { name: 'Thẻ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Thẻ', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hoàn thiện với AI' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã hoàn thiện' })).toBeVisible();
  await expect(diagram.locator('text', { hasText: 'Tự sửa' })).toHaveCount(1);
  await expect(diagram.locator('text', { hasText: /^AI: / }).first()).toBeAttached();

  const png = await download(page, 'PNG');
  expect(png.name.endsWith('.png')).toBe(true);
  expect(png.bytes.length).toBeGreaterThan(5 * 1024);
});

test('docx round trip', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Tải tệp' }).click();
  await page.locator('input[type="file"]').setInputFiles(path.join(HERE, 'fixtures', 'plan.docx'));
  await page.getByRole('button', { name: 'Tạo sơ đồ' }).click();
  await expect(page.getByRole('list', { name: 'Các phần' }).getByRole('button')).toHaveCount(2);

  for (const name of ['Quy trình', 'Đo lường']) await pickFirstCandidate(page, name);

  const docx = await download(page, 'Word (.docx)');
  expect(docx.name.endsWith('.docx')).toBe(true);
  const zip = await JSZip.loadAsync(docx.bytes);
  const xml = await zip.file('word/document.xml').async('string');
  expect(xml.match(/<w:drawing>/g)?.length).toBe(2);
});

test('cancel', async ({ page, request }) => {
  const created = await (await request.post('/api/projects', { data: { text: PLAIN_TEXT } })).json();
  await page.goto(`/#/p/${created.data.id}`);
  await page.getByRole('button', { name: 'Phân tích lại' }).click();
  await page.getByRole('button', { name: 'Huỷ' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã huỷ.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('token', () => {
  const port = 8792;
  let server = null;
  let dataDir = null;

  test.beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagram-e2e-token-'));
    server = spawn(process.execPath, ['server/main.js'], {
      cwd: ROOT,
      env: { ...process.env, DIAGRAM_AGENT: 'fake', DIAGRAM_PORT: String(port), DIAGRAM_HOST: '127.0.0.1', DIAGRAM_TOKEN: 'e2e-token', DIAGRAM_DATA_DIR: dataDir },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
      } catch {
        /* not listening yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the token server did not start');
  });

  test.afterAll(async () => {
    server?.kill();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('asks for the token, refuses a wrong one, accepts the right one', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${port}/`);
    const dialog = page.getByRole('dialog', { name: 'Mã truy cập' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Mã truy cập').fill('sai-ma');
    await dialog.getByRole('button', { name: 'Tiếp tục' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Mã truy cập không đúng.')).toBeVisible();
    await dialog.getByLabel('Mã truy cập').fill('e2e-token');
    await dialog.getByRole('button', { name: 'Tiếp tục' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Chưa có dự án nào.')).toBeVisible();
  });
});

test('layout', async ({ page, request }, testInfo) => {
  await fs.mkdir(SCREENS, { recursive: true });
  const shot = (name) => page.screenshot({ path: path.join(SCREENS, `${testInfo.project.name}-${name}.png`), fullPage: true });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Biến văn bản thành sơ đồ' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot('home');

  const id = await createEditedProject(request);
  await page.goto(`/#/p/${id}/s/s1`);
  const diagram = page.getByRole('img', { name: 'Quy trình tuyển dụng' });
  await expect(diagram).toBeVisible();
  // Template thumbnails render lazily once visible.
  await page.getByRole('button', { name: 'Thẻ', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Thẻ', exact: true }).locator('svg')).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoHorizontalScroll(page);
  await shot('editor');

  await diagram.locator('[data-node-id="n2"][data-role="node-label"]').first().click();
  await expect(page.getByRole('heading', { name: 'Mục 2' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot('editor-selected');

  await page.getByRole('button', { name: 'Xuất' }).click();
  await expect(page.getByRole('dialog', { name: 'Xuất sơ đồ' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot('export');
});
