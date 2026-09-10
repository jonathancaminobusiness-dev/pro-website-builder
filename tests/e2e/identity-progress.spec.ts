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

function snapshot(status: 'queued' | 'running' | 'needs_review' | 'cancelled' | 'failed' | 'interrupted', snapshotRunId = runId) {
  return {
    runId: snapshotRunId,
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

test('queued polling failures do not consume the start recovery budget', async ({ page }) => {
  await page.clock.install();
  let phase: 'queued' | 'running' = 'queued';
  let queuedFailures = 10;
  let reads = 0;

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
      reads += 1;
      if (queuedFailures > 0) {
        queuedFailures -= 1;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporary outage' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot(phase)) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.clock.fastForward(1_500);
    await expect.poll(() => reads).toBe(attempt + 1);
  }

  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toBeVisible();
  await page.clock.fastForward(1_500);
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
});

test('a missing run clears start recovery and restores replacement controls', async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  await page.addInitScript(() => localStorage.clear());
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      await route.abort();
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      reads += 1;
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Identity run not found.' }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toBeVisible();

  await page.clock.fastForward(1_500);
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toHaveCount(0);
  await expect(page.getByLabel('Abrir outra execução')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nova execução' })).toBeVisible();
});

test('a terminal poll unlocks Gate 1 while start is still pending', async ({ page }) => {
  await page.clock.install();
  let releaseStart = (): void => {};
  const startHeld = new Promise<void>((resolve) => { releaseStart = resolve; });

  await page.addInitScript(() => localStorage.clear());
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
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('needs_review')) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await page.clock.fastForward(1_500);

  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aprovar esta direção' })).toBeEnabled();

  releaseStart();
  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible();
});

test('a queued read from before start cannot clear recovery', async ({ page }) => {
  await page.clock.install();
  let releaseQueuedRead = (): void => {};
  const queuedReadHeld = new Promise<void>((resolve) => { releaseQueuedRead = resolve; });
  let staleRead = true;
  let staleReadStarted = false;
  let staleReadCompleted = false;
  let allowRunning = false;

  await page.addInitScript(() => localStorage.clear());
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      await route.abort();
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      if (staleRead) {
        staleReadStarted = true;
        await queuedReadHeld;
        staleRead = false;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
        staleReadCompleted = true;
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot(allowRunning ? 'running' : 'queued')) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.clock.fastForward(1_500);
  await expect.poll(() => staleReadStarted).toBe(true);
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toBeVisible();

  releaseQueuedRead();
  await expect.poll(() => staleReadCompleted).toBe(true);
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toBeVisible();

  allowRunning = true;
  await page.clock.fastForward(1_500);
  await expect(page.getByText('executando', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
});

test('a terminal poll does not unlock decisions during cancellation', async ({ page }) => {
  await page.clock.install();
  let releaseStart = (): void => {};
  let releaseCancel = (): void => {};
  const startHeld = new Promise<void>((resolve) => { releaseStart = resolve; });
  const cancelHeld = new Promise<void>((resolve) => { releaseCancel = resolve; });

  await page.addInitScript(() => localStorage.clear());
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
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/cancel`) {
      await cancelHeld;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('cancelled')) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('needs_review')) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await page.getByRole('button', { name: 'Cancelar execução' }).click();
  await page.clock.fastForward(1_500);

  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprovar esta direção' })).toBeDisabled();

  releaseCancel();
  await expect(page.getByText('cancelada', { exact: true })).toBeVisible();
  releaseStart();
});

test('a retry blocks Gate 1 replacement actions while start is pending', async ({ page }) => {
  await page.clock.install();
  let releaseStart = (): void => {};
  const startHeld = new Promise<void>((resolve) => { releaseStart = resolve; });

  await page.addInitScript(() => localStorage.clear());
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('failed')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      await startHeld;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('needs_review')) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('failed')) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Tentar novamente' }).click();

  await expect(page.getByText('falhou', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tentar novamente' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Nova execução' })).toBeDisabled();
  await expect(page.getByLabel('Abrir outra execução')).toHaveCount(0);

  releaseStart();
  await expect(page.getByText('aguarda gate', { exact: true })).toBeVisible();
});

test('a retry ignores stale reads, clears recovery errors, and shows verification', async ({ page }) => {
  await page.clock.install();
  let startCalls = 0;
  let staleReadStarted = false;
  let staleReadCompleted = false;
  let releaseStaleRead = (): void => {};
  const staleReadHeld = new Promise<void>((resolve) => { releaseStaleRead = resolve; });
  let allowRunning = false;

  await page.addInitScript(() => localStorage.clear());
  await page.route('**/api/identity/runs**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && pathname === '/api/identity/runs') {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(snapshot('queued')) });
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/start`) {
      startCalls += 1;
      if (startCalls === 1) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('running')) });
      } else {
        await route.abort();
      }
      return;
    }
    if (request.method() === 'POST' && pathname === `/api/identity/runs/${runId}/cancel`) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('failed')) });
      return;
    }
    if (request.method() === 'GET' && pathname === `/api/identity/runs/${runId}`) {
      if (!staleReadStarted) {
        staleReadStarted = true;
        await staleReadHeld;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot('failed')) });
        staleReadCompleted = true;
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot(allowRunning ? 'running' : 'failed')) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  await page.getByRole('button', { name: 'Executar etapa de identidade' }).click();
  await expect(page.getByText('executando', { exact: true })).toBeVisible();
  await page.clock.fastForward(1_500);
  await expect.poll(() => staleReadStarted).toBe(true);

  await page.getByRole('button', { name: 'Cancelar execução' }).click();
  await expect(page.getByText('falhou', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByText('O servidor local não respondeu.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verificando execução…' })).toBeVisible();

  releaseStaleRead();
  await expect.poll(() => staleReadCompleted).toBe(true);
  allowRunning = true;
  await page.clock.fastForward(1_500);
  await expect(page.getByText('executando', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancelar execução' })).toBeVisible();
  await expect(page.getByText('O servidor local não respondeu.', { exact: true })).toHaveCount(0);
});
