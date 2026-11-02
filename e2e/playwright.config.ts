import { defineConfig, devices } from '@playwright/test';

// Smoke tests run against the Vite dev server; every /api request is mocked in e2e/fixtures.ts,
// so no upstream or Node API server is needed. Set E2E_PORT if 5174 is taken.
const port = Number(process.env.E2E_PORT) || 5174;

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile/ },
  ],
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    cwd: '..',
    reuseExistingServer: false,
  },
});
