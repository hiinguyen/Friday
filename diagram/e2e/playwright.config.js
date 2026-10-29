import { defineConfig, devices } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(os.tmpdir(), `diagram-e2e-${process.pid}`);

export default defineConfig({
  testDir: '.',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './global-setup.js',
  use: { baseURL: 'http://127.0.0.1:8791', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'node server/main.js',
    cwd: '..',
    url: 'http://127.0.0.1:8791/api/health',
    reuseExistingServer: false,
    env: { DIAGRAM_AGENT: 'fake', DIAGRAM_PORT: '8791', DIAGRAM_DATA_DIR: dataDir, DIAGRAM_FAKE_DELAY_MS: '300' },
  },
});
