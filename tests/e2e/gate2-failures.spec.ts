import { expect, test } from '@playwright/test';

/**
 * Gate 2 is a pt-BR screen and reads through the Studio's one request helper, so
 * a refusal the server could not explain — a 500 with no JSON — is stated in the
 * language of the interface instead of the browser's own 'Failed to fetch'. And
 * a server that never comes back ends the loop: the reads are budgeted the way
 * Gate 1 budgets its own.
 */
test('states an unexplained refusal in pt-BR and stops reading after the failure budget', async ({ page }) => {
  test.setTimeout(120_000);
  let attempts = 0;
  await page.route('**/api/prototype/**', async (route) => {
    attempts += 1;
    await route.fulfill({ status: 500, contentType: 'text/plain; charset=utf-8', body: 'boom' });
  });

  await page.goto('/#/gate-2/gate2-unreachable');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Não foi possível concluir a ação.');
  await expect(alert).not.toContainText('Failed to fetch');

  // Ten failed reads end the loop and say so, rather than reading in silence.
  await expect(alert).toContainText('Recarregue para ler o estado atual.', { timeout: 60_000 });
  // Ten reads for the loop, plus the one the development double-mount spends.
  const spent = attempts;
  expect(spent).toBeLessThanOrEqual(12);
  await page.waitForTimeout(5_000);
  expect(attempts).toBe(spent);
});
