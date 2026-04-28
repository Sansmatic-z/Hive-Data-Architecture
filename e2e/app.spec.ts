import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
    Reflect.deleteProperty(window, 'showOpenFilePicker');
  });
  await page.goto('/');
});

test('creates an archive and downloads it in fallback mode', async ({ page }) => {
  await page.getByLabel('Cell security password').fill('E2EPass!123');
  const fileInput = page.locator('input[type="file"]').first();

  const downloadPromise = page.waitForEvent('download');
  await fileInput.setInputFiles({
    name: 'create.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from playwright'),
  });
  await expect(page.getByText('Hive Synchronized')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /Save HDA Hive/i }).click();
  const download = await downloadPromise;
  expect(await download.path()).toBeTruthy();
});

test('decrypts an encrypted archive through inspection flow', async ({ page }, testInfo) => {
  await page.getByLabel('Cell security password').fill('E2EPass!123');
  const fileInput = page.locator('input[type="file"]').first();
  const archiveDownload = page.waitForEvent('download');
  await fileInput.setInputFiles({
    name: 'secret.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('secret payload'),
  });
  await expect(page.getByText('Hive Synchronized')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: /Save HDA Hive/i }).click();
  const archive = await archiveDownload;
  const archivePath = path.join(testInfo.outputDir, 'secret.hda.html');
  await archive.saveAs(archivePath);

  await page.reload();
  await page.getByText('UNPACK').click();
  await page.locator('input[type="file"]').first().setInputFiles(archivePath);
  await expect(page.getByText('Archive Inspector')).toBeVisible();
  await page.getByPlaceholder('Optional Passphrase...').fill('E2EPass!123');
  await page.getByRole('button', { name: /Extract Archive/i }).click();
  await expect(page.getByText('Payload Restored')).toBeVisible();
});

test('shows an error for a corrupted archive', async ({ page }, testInfo) => {
  const archivePath = path.join(testInfo.outputDir, 'broken.hda.html');
  await fs.mkdir(testInfo.outputDir, { recursive: true });
  await fs.writeFile(archivePath, '<html><body>broken archive</body></html>');
  await page.reload();
  await page.getByText('UNPACK').click();
  await page.locator('input[type="file"]').first().setInputFiles(archivePath);
  await expect(page.getByText('Protocol Violation')).toBeVisible();
});

test('supports cancel and retry', async ({ page }) => {
  const fileInput = page.locator('input[type="file"]').first();
  const largePath = path.join(process.cwd(), 'playwright-large.bin');
  await fs.writeFile(largePath, Buffer.alloc(64 * 1024 * 1024, 7));
  await fileInput.setInputFiles(largePath);
  await expect(page.getByRole('button', { name: /Cancel Operation/i })).toBeVisible();
  await page.getByRole('button', { name: /Cancel Operation/i }).click();
  await expect(page.getByText('Operation Suspended')).toBeVisible();
  await page.getByRole('button', { name: /Resume Job/i }).click();
  await expect(page.getByText('Hive Synchronized')).toBeVisible();
  await fs.unlink(largePath);
});

test('uses memory fallback when file-system access is unavailable', async ({ page }) => {
  await expect(page.getByText(/File System Access API is unavailable/i)).toBeVisible();
});
