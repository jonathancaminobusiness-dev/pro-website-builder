import { expect, test } from '@playwright/test';

const runId = 'identity-progress-fixture';
const direction = {
  directionId: 'modular-technical',
  label: 'Modular technical',
  versionId: 'version-direction',
  parentVersionId: 'version-root',
  identityHash: 'identity-hash',
  thesis: 'A measured identity.',
  tension: 'Precision with warmth.',
  rationale: 'The rationale is grounded in the briefing.',
  exclusions: [],
  forbiddenDefaults: { fonts: [], palettes: [], motifs: [] },
  axes: [],
  swatches: [],
  decisions: [],
  lintErrors: [],
  blocking: [],
  scores: [],
  rubricGaps: [],
  unscoredDimensions: [],
  blockedPairs: [],
  abstained: false,
  imagePlans: [],
  imageryViolations: [],
};

function snapshot(status: 'queued' | 'running' | 'needs_review') {
  return {
    runId,
    status,
    baseVersionId: 'version-root',
    briefing: 'A deterministic briefing for the Gate 1 interface.',
    directions: status === 'needs_review' ? [direction] : [],
    setCritique: { scores: [], rubricGaps: [], unscoredDimensions: [], blocking: [], abstained: false },
    gate: { state: 'open' as const, reason: 'The captain decides.' },
    approvals: [],
    assets: [],
    failures: [],
  };
}

test('Gate 1 follows running progress and keeps the completed result after refresh', async ({ page }) => {
  let phase: 'queued' | 'running' | 'needs_review' = 'queued';
  let completed = false;

  await page.addInitScript(() => {
    if (sessionStorage.getItem('identity-progress-test-initialized') === '1') return;
    localStorage.clear();
    sessionStorage.setItem('identity-progress-test-initialized', '1');
  });
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      phase = 'running';
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('needs_review')) }).catch(() => {});
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot(completed ? 'needs_review' : phase)) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();

  await expect(page.getByText('executando', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await expect(page.getByText('pronto para executar', { exact: true })).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await expect(page.getByRole('button', { name: 'Gate 1 · identidade' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('executando', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();

  completed = true;
  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(page.getByText('Modular technical', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprovar esta direção' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toHaveCount(0);
});

test('an opened queued run follows a start from another tab', async ({ page }) => {
  const observer = await page.context().newPage();
  let phase: 'queued' | 'running' | 'needs_review' = 'queued';
  let releaseStart = (): void => {};
  const startHeld = new Promise<void>((resolve) => { releaseStart = resolve; });

  await page.addInitScript(() => localStorage.clear());
  await page.context().route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      phase = 'running';
      await startHeld;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('needs_review')) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot(phase)) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();

  await observer.goto('/');
  await observer.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await expect(observer.getByText('pronto para executar', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(observer.getByText('executando', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(observer.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();

  releaseStart();
  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible();
  await observer.close();
});

test('Gate 1 recovers an ambiguous start response through polling', async ({ page }) => {
  let phase: 'queued' | 'running' = 'queued';

  await page.addInitScript(() => localStorage.clear());
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      phase = 'running';
      await route.abort();
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot(phase)) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();

  await expect(page.getByText('O servidor local não respondeu.', { exact: true })).toBeVisible();
  await expect(page.getByText('pronto para executar', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Executar etapa de identidade' })).toHaveCount(0);
  await expect(page.getByText('executando', { exact: true })).toBeVisible({ timeout: 4_000 });
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await expect(page.getByText('pronto para executar', { exact: true })).toHaveCount(0);
});

test('Gate 1 names a pending stage when polling fails during start', async ({ page }) => {
  let releaseStart = (): void => {};
  const startHeld = new Promise<void>((resolve) => { releaseStart = resolve; });
  let failedReads = 0;

  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      await startHeld;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('needs_review')) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      failedReads += 1;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary outage' }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();

  await expect.poll(() => failedReads, { timeout: 20_000 }).toBe(10);
  await expect(page.getByText('Não foi possível acompanhar esta execução. Recarregue para ler o estado atual.', { exact: true })).toBeVisible();

  releaseStart();
  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible();
});
