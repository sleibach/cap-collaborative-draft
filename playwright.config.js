'use strict'

const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:4004',
    screenshot: 'on',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/e2e-results.json' }],
    ['html', { open: 'never', outputFolder: 'test-results/html' }]
  ],
  outputDir: 'test-results/artifacts',
  projects: [
    {
      name: 'chromium',
      use: { channel: 'chromium' }
    }
  ]
})
