import { expect, test, type Page } from '@playwright/test';
import { CONSOLIDATED_SUMMARY, FakeConversationApi, type FakeConversationOptions } from './fake-conversation-api.js';

const ENTRY = 'Somos uma clínica veterinária de bairro. Queremos cuidar de cães e gatos com prevenção, sem parecer hospital frio nem pet shop genérico.';

async function openConversation(page: Page, options: FakeConversationOptions = {}): Promise<FakeConversationApi> {
  const api = new FakeConversationApi(options);
  await api.install(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByLabel('Briefing do projeto').fill(ENTRY);
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();
  return api;
}

test('reads the text, answers the one question and closes the briefing into three text directions', async ({ page }) => {
  await openConversation(page);

  const chat = page.locator('.briefing-chat');
  await expect(chat.getByRole('heading', { name: 'Conversa de briefing' })).toBeVisible();
  await expect(chat.getByText('0/6 mensagens')).toBeVisible();
  // The identity stage is not spendable while the briefing is still open.
  await expect(page.getByRole('button', { name: 'Feche o briefing para executar' })).toBeDisabled();

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();

  await expect(chat.getByText('Fatos que você disse')).toBeVisible();
  await expect(chat.getByText('Hipóteses do Studio')).toBeVisible();
  await expect(chat.getByText('Ainda desconhecido')).toBeVisible();
  await expect(chat.getByText('Por que isso muda a identidade.').first()).toBeVisible();
  await expect(chat.getByText('1/6 mensagens')).toBeVisible();

  // One question at a time: the panel shows exactly one prompt to answer.
  await expect(chat.locator('#briefing-chat-question')).toHaveCount(1);
  await chat.getByRole('button', { name: 'Segurança clínica', exact: true }).click();
  await page.getByRole('button', { name: 'Responder' }).click();

  const summary = page.getByLabel(/Briefing final, editável/);
  await expect(summary).toHaveValue(CONSOLIDATED_SUMMARY);
  await summary.fill(`${CONSOLIDATED_SUMMARY} O acompanhamento é o diferencial.`);
  await page.getByRole('button', { name: 'Fechar briefing' }).click();

  await expect(chat.locator('.chat-closed')).toContainText('Briefing fechado');
  // Closing the briefing is what enables the stage.
  await expect(page.getByRole('button', { name: 'Executar etapa de identidade' })).toBeEnabled();
  await expect(chat.locator('.chat-direction')).toHaveCount(3);
  await expect(chat.getByText('conceito descrito · sem preview').first()).toBeVisible();
  // The visual stage owns previews; nothing in the chat opens one.
  await expect(chat.locator('iframe')).toHaveCount(0);
  for (const forbidden of ['ver proposta', 'gerar identidade', 'abrir preview']) {
    await expect(chat.getByText(new RegExp(forbidden, 'i'))).toHaveCount(0);
  }
  // The closed summary is the text a new execution carries, and the replacement
  // still asks before it takes the one run this browser remembers.
  await page.getByRole('button', { name: 'Nova execução' }).click();
  await expect(page.getByText('Uma execução nova substitui')).toBeVisible();
  await page.getByRole('button', { name: 'Criar mesmo assim' }).click();
  await expect(page.locator('.gate-briefing')).toHaveText(`${CONSOLIDATED_SUMMARY} O acompanhamento é o diferencial.`);
});

test('keeps the draft on a dead network and retries the same intent without a second turn', async ({ page }) => {
  const api = await openConversation(page, { dropNextRequest: true });
  const chat = page.locator('.briefing-chat');

  // The resume itself was dropped: the panel says so and reopens from the saved
  // point rather than showing an empty conversation that was never read.
  await expect(chat.getByRole('alert')).toContainText('Nada foi fechado');
  await chat.getByRole('button', { name: 'Tentar novamente' }).click();

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();
  await expect(chat.locator('#briefing-chat-question')).toHaveCount(1);

  // The send that follows is dropped, then retried with the key it already had.
  const answer = page.getByLabel('Sua resposta');
  await answer.fill('Segurança clínica sem perder o carinho.');
  const dropped: string[] = [];
  await page.route('**/conversation', (route) => {
    dropped.push(String((route.request().postDataJSON() as { idempotencyKey?: string }).idempotencyKey));
    return route.abort('failed');
  }, { times: 1 });
  await page.getByRole('button', { name: 'Responder' }).click();

  await expect(chat.getByRole('alert')).toContainText('o que você escreveu continua aqui');
  await expect(answer).toHaveValue('Segurança clínica sem perder o carinho.');
  await expect(chat.locator('.chat-pending')).toHaveCount(1);

  await chat.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByLabel(/Briefing final, editável/)).toHaveValue(CONSOLIDATED_SUMMARY);

  // The retry carried the key the dropped attempt already had, so the server
  // folds the repeat into one turn instead of recording a second.
  const answerWrites = api.writes.filter((write) => write.body.intent === 'answer');
  expect(answerWrites).toHaveLength(1);
  expect(answerWrites[0]?.body.idempotencyKey).toBe(dropped[0]);
  await expect(chat.locator('.chat-turn', { hasText: 'Segurança clínica sem perder o carinho.' })).toHaveCount(1);
});

test('explains an off-contract response and lets the captain try again', async ({ page }) => {
  await openConversation(page, { breakNextResponse: true });
  const chat = page.locator('.briefing-chat');

  await expect(chat.getByRole('alert')).toContainText('não seguiu o contrato');
  await chat.getByRole('button', { name: 'Reabrir do ponto salvo' }).click();
  await expect(page.getByLabel(/Conte sobre o negócio/)).toBeVisible();
});

test('says plainly that a cancelled conversation sent nothing to the curator', async ({ page }) => {
  const api = await openConversation(page);
  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();
  await expect(page.locator('#briefing-chat-question')).toHaveCount(1);

  await page.getByRole('button', { name: 'Cancelar conversa' }).click();

  const chat = page.locator('.briefing-chat');
  await expect(chat.getByText('Nada foi enviado ao curador')).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Fechar briefing' })).toHaveCount(0);
  // A cancellation answers no question, so it carries no question id.
  const cancels = api.writes.filter((write) => write.body.intent === 'cancel');
  expect(cancels).toHaveLength(1);
  expect(cancels[0]?.body.questionId).toBeUndefined();
  // Cancelling closed no briefing, so it enabled no stage either.
  await expect(page.getByRole('button', { name: 'Feche o briefing para executar' })).toBeDisabled();
});

test('reads the ceiling from the contract and closes manually once it is reached', async ({ page }) => {
  await openConversation(page, { messageLimit: 1 });
  const chat = page.locator('.briefing-chat');
  await expect(chat.getByText('0/1 mensagens')).toBeVisible();

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();

  await expect(chat.getByText('limite atingido')).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Pular esta pergunta' })).toHaveCount(0);
  await expect(page.getByLabel(/Briefing final, editável/)).toBeVisible();
  await page.getByRole('button', { name: 'Fechar briefing' }).click();
  await expect(chat.locator('.chat-closed')).toContainText('Briefing fechado');
});

test('reopens a restarted conversation at the persisted point instead of a default', async ({ page }) => {
  await openConversation(page, {
    initial: {
      state: 'question',
      briefing: ENTRY,
      messageCount: 2,
      turns: [{ id: 'turn-entry', role: 'captain', message: ENTRY, intent: 'entry', facts: [], hypotheses: [], unknowns: [], nextState: 'recommendation' }],
      question: { id: 'question-first-visit', prompt: 'O que precisa acontecer na primeira visita?', why: 'Esse trade-off decide o tom das três direções.' },
    },
  });

  const chat = page.locator('.briefing-chat');
  await expect(chat.getByText('2/6 mensagens')).toBeVisible();
  await expect(chat.getByText(ENTRY).first()).toBeVisible();
  await expect(chat.locator('#briefing-chat-question')).toHaveText('O que precisa acontecer na primeira visita?');
  await expect(page.getByLabel(/Conte sobre o negócio/)).toHaveCount(0);
});

test('leaves the old briefing flow alone when the server has no conversation for the run', async ({ page }) => {
  await openConversation(page, { absent: true });

  await expect(page.locator('.briefing-chat')).toHaveCount(0);
  await expect(page.locator('.gate-briefing')).toHaveText(ENTRY);
  await expect(page.getByRole('button', { name: 'Executar etapa de identidade' })).toBeVisible();
});

for (const width of [1440, 390] as const) {
  test(`the briefing conversation never scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openConversation(page);
    await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
    await page.getByRole('button', { name: 'Enviar para leitura' }).click();
    await page.getByLabel('Sua resposta').fill('Segurança clínica sem perder o carinho.');
    await page.getByRole('button', { name: 'Responder' }).click();
    await page.getByRole('button', { name: 'Fechar briefing' }).click();
    await expect(page.locator('.chat-direction')).toHaveCount(3);

    const metrics = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  });
}

test('names every field, reads errors aloud and keeps the history in a live region', async ({ page }) => {
  await openConversation(page);
  const chat = page.locator('.briefing-chat');

  await expect(chat.locator('[role="log"]')).toHaveAttribute('aria-live', 'polite');
  await expect(chat.locator('[role="log"]')).toHaveAttribute('aria-label', 'Histórico da conversa de briefing');
  await expect(page.getByLabel(/Conte sobre o negócio/)).toBeVisible();

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();

  // The one question on screen takes focus, and the field says which question it answers.
  await expect(page.getByLabel('Sua resposta')).toBeFocused();
  await expect(page.getByLabel('Sua resposta')).toHaveAttribute('aria-describedby', 'briefing-chat-question');

  await page.route('**/conversation', (route) => route.abort('failed'), { times: 1 });
  await page.getByLabel('Sua resposta').fill('Segurança clínica.');
  await page.getByRole('button', { name: 'Responder' }).click();
  await expect(chat.getByRole('alert')).toBeVisible();
});
