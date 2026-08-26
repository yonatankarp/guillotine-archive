import { defineConfig, devices } from '@playwright/test';
import { playwrightRuntime } from './tests/support/playwright-runtime';

export default defineConfig({
  testDir: 'tests/e2e',
  webServer: {
    command: playwrightRuntime.webServerCommand,
    url: playwrightRuntime.site.baseURL,
    reuseExistingServer: playwrightRuntime.reuseExistingServer,
    env: playwrightRuntime.webServerEnvironment,
  },
  use: {
    baseURL: playwrightRuntime.site.baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'Pixel 7',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: '320px',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 320, height: 800 },
      },
    },
  ],
});
