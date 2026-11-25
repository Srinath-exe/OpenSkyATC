// The model update channel (public/model-updates.json -> src/lib/models/updates.ts, src/game/ModelUpdate): a player who has a
// model is asked, may put it off or skip it, and the old model stays in use until the new one has loaded.
import { test, expect, type Page } from '@playwright/test';

const HASH = 'a'.repeat(64);
const rel = (version: string) => ({ schema: 1, models: { s1: { version, aliases: [], title: 'Command model', what: 'x', notes: ['Understands step-by-step taxi'], dir: `/models/s1/${version}`, bytes: 1, files: [{ name: 'model.json', size: 16000, sha256: HASH }, { name: 'model.bin', size: 2000000, sha256: HASH }] } } });

async function open(page: Page, version: string, opts: { have?: string; broken?: boolean } = {}) {
  await page.route('**/model-updates.json', (r) => r.fulfill({ json: rel(version) }));
  await page.route(`**/models/s1/${version}/*`, async (r) => {
    const f = r.request().url().split('/').pop()!.split('?')[0];
    if (opts.broken) return r.fulfill({ status: 503, body: 'no' });
    const real = await page.request.get(`/models/s1/2m-free-v1/${f}`);
    return r.fulfill({ status: 200, body: await real.body(), headers: { 'content-type': 'application/octet-stream' } });
  });
  await page.addInitScript(([have]) => {
    (window as unknown as { __forceModelUpdate: boolean }).__forceModelUpdate = true;
    if (have && !localStorage.getItem('seeded')) { localStorage.setItem('seeded', '1'); localStorage.setItem('skycontrol_models_v1', JSON.stringify({ s1: { state: 'ready', progress: 1, bytes: 1, loadMs: 1, runMs: 1, device: 'x', at: 1, message: '', version: have } })); }
    localStorage.setItem('skycontrol_setup_done', '1');
  }, [opts.have ?? '']);
  await page.goto('/play?icao=KSFO&test=1', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="page-atc"][data-ready="true"]').waitFor({ timeout: 90_000 });
}

test('a player who has the model is asked, updates, and is not asked again', async ({ page }) => {
  await open(page, '2m-free-v9', { have: '2m-free-v1' });
  const card = page.getByTestId('model-update');
  await expect(card).toContainText('A better command model is ready', { timeout: 20_000 });
  await expect(card).toContainText('step-by-step taxi');
  await page.getByTestId('model-update-go').click();
  await expect(card).toContainText('newest version', { timeout: 60_000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_model_dirs') ?? '{}').s1)).toBe('/models/s1/2m-free-v9');
  await page.reload(); await page.locator('[data-testid="page-atc"][data-ready="true"]').waitFor({ timeout: 90_000 }); await page.waitForTimeout(3000);
  await expect(card).toHaveCount(0);
});

test('later hides it for now; skip hides that version for good but not the next one', async ({ page }) => {
  await open(page, '2m-free-v9', { have: '2m-free-v1' });
  await page.getByTestId('model-update-skip').click({ timeout: 20_000 });
  await expect(page.getByTestId('model-update')).toHaveCount(0);
  await page.unroute('**/model-updates.json'); await page.route('**/model-updates.json', (r) => r.fulfill({ json: rel('2m-free-v10') }));
  await page.reload();
  await expect(page.getByTestId('model-update')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('model-update-later').click();
  await expect(page.getByTestId('model-update')).toHaveCount(0);
});

test('a failed download keeps the old model and can be tried again', async ({ page }) => {
  await open(page, '2m-free-v9', { have: '2m-free-v1', broken: true });
  await page.getByTestId('model-update-go').click({ timeout: 20_000 });
  await expect(page.getByTestId('model-update')).toContainText('current model still works', { timeout: 60_000 });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('skycontrol_model_dirs') ?? '{}').s1 ?? null)).toBeNull();
  await expect(page.getByTestId('model-update-go')).toHaveText('Try again');
});

test('a player with nothing downloaded is not asked', async ({ page }) => {
  await open(page, '2m-free-v9');
  await page.waitForTimeout(3000); await expect(page.getByTestId('model-update')).toHaveCount(0);
});

test('a list that points off this site, or is malformed, is ignored', async ({ page }) => {
  for (const bad of [{ dir: 'https://example.com/models/x' }, { dir: '/models/../x' }, { files: [{ name: '../x', size: 1, sha256: HASH }] }, { files: [{ name: 'model.bin', size: 1, sha256: 'zz' }] }]) {
    const j = rel('2m-free-v9'); Object.assign(j.models.s1, bad);
    await page.unrouteAll(); await open(page, '2m-free-v9', { have: '2m-free-v1' }); await page.route('**/model-updates.json', (r) => r.fulfill({ json: j })); await page.reload();
    await page.locator('[data-testid="page-atc"][data-ready="true"]').waitFor({ timeout: 90_000 }); await page.waitForTimeout(1500);
    await expect(page.getByTestId('model-update')).toHaveCount(0);
  }
});
