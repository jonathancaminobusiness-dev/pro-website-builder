import { expect, test, type Page } from '@playwright/test';
import { CONSOLIDATED_SUMMARY } from '../../apps/studio/src/briefing/conversation-fixture.js';
import { FakeConversationApi, type FakeConversationOptions } from './fake-conversation-api.js';

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
  // The failed answer is no longer in flight, so the log stops announcing it as
  // being sent; the turn it becomes is counted once after the replay lands.
  await expect(chat.locator('.chat-pending')).toHaveCount(0);
  // Nothing can rewrite the field the pending answer came from, by keyboard or
  // by a suggested option, so the replay cannot send text the screen replaced.
  await expect(answer).toHaveAttribute('readonly', '');
  await expect(chat.getByRole('button', { name: 'Experiência premium', exact: true })).toBeDisabled();

  await chat.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByLabel(/Briefing final, editável/)).toHaveValue(CONSOLIDATED_SUMMARY);

  // The retry carried the key the dropped attempt already had, so the server
  // folds the repeat into one turn instead of recording a second.
  const answerWrites = api.writes.filter((write) => write.body.intent === 'answer');
  expect(answerWrites).toHaveLength(1);
  expect(answerWrites[0]?.body.idempotencyKey).toBe(dropped[0]);
  await expect(chat.locator('.chat-turn', { hasText: 'Segurança clínica sem perder o carinho.' })).toHaveCount(1);
});

test('keeps the panel usable when a skip is refused, and replays the skip on demand', async ({ page }) => {
  const api = await openConversation(page);
  const chat = page.locator('.briefing-chat');

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();
  await expect(chat.locator('#briefing-chat-question')).toHaveCount(1);

  await page.route('**/conversation', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'identity-conversation-e2e', state: 'recommendation' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Pular esta pergunta' }).click();

  await expect(chat.getByRole('alert')).toContainText('não seguiu o contrato');
  // A skip carried no field, so nothing it could have replaced stays frozen.
  await expect(page.getByRole('button', { name: 'Cancelar conversa' })).toBeEnabled();
  await expect(page.getByLabel('Sua resposta')).not.toHaveAttribute('readonly', '');

  await chat.getByRole('button', { name: 'Tentar novamente' }).click();

  await expect(page.getByLabel(/Briefing final, editável/)).toHaveValue(CONSOLIDATED_SUMMARY);
  const skips = api.writes.filter((write) => write.body.intent === 'skip');
  expect(skips).toHaveLength(1);
});

test('answers the question the captain typed into instead of replaying the skip that failed', async ({ page }) => {
  const api = await openConversation(page);
  const chat = page.locator('.briefing-chat');

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();
  await expect(chat.locator('#briefing-chat-question')).toHaveCount(1);

  await page.route('**/conversation', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runId: 'identity-conversation-e2e', state: 'recommendation' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Pular esta pergunta' }).click();
  await expect(chat.getByRole('alert')).toContainText('não seguiu o contrato');

  await page.getByLabel('Sua resposta').fill('Segurança clínica sem perder o carinho.');
  // The typed text is the action the captain chose; the skip is no longer on offer.
  await expect(chat.getByRole('button', { name: 'Tentar novamente' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Responder' }).click();

  await expect(page.getByLabel(/Briefing final, editável/)).toHaveValue(CONSOLIDATED_SUMMARY);
  expect(api.writes.filter((write) => write.body.intent === 'skip')).toHaveLength(0);
  expect(api.writes.filter((write) => write.body.intent === 'answer')).toHaveLength(1);
  await expect(chat.locator('.chat-turn', { hasText: 'Segurança clínica sem perder o carinho.' })).toHaveCount(1);
});

test('explains an off-contract response and lets the captain try again', async ({ page }) => {
  await openConversation(page, { breakNextResponse: true });
  const chat = page.locator('.briefing-chat');

  await expect(chat.getByRole('alert')).toContainText('não seguiu o contrato');
  await expect(chat.getByRole('button', { name: 'Reabrir do ponto salvo' })).toHaveCount(0);
  await chat.getByRole('button', { name: 'Tentar novamente' }).click();
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
  // A cancellation answers no question, so it carries no question id.
  const cancels = api.writes.filter((write) => write.body.intent === 'cancel');
  expect(cancels).toHaveLength(1);
  expect(cancels[0]?.body.questionId).toBeUndefined();
  // Cancelling closed no briefing, so it enabled no stage either.
  await expect(page.getByRole('button', { name: 'Feche o briefing para executar' })).toBeDisabled();

  // A cancelled conversation does not reopen on this execution and does not
  // pretend to: the persisted text is still closable, and that is the exit.
  await expect(chat.getByRole('button', { name: 'Reabrir do ponto salvo' })).toHaveCount(0);
  await expect(chat.getByText('não volta a abrir nesta execução')).toBeVisible();
  const summary = page.getByLabel(/Briefing final, editável/);
  await expect(summary).toHaveValue(ENTRY);
  await page.getByRole('button', { name: 'Fechar briefing' }).click();

  await expect(chat.locator('.chat-closed')).toContainText('Briefing fechado');
  await expect(page.getByRole('button', { name: 'Executar etapa de identidade' })).toBeEnabled();
});

test('re-sends a corrected close as a new request instead of replaying the failed one', async ({ page }) => {
  const api = await openConversation(page);
  const chat = page.locator('.briefing-chat');

  await page.getByLabel(/Conte sobre o negócio/).fill(ENTRY);
  await page.getByRole('button', { name: 'Enviar para leitura' }).click();
  await page.getByLabel('Sua resposta').fill('Segurança clínica sem perder o carinho.');
  await page.getByRole('button', { name: 'Responder' }).click();

  const summary = page.getByLabel(/Briefing final, editável/);
  await expect(summary).toHaveValue(CONSOLIDATED_SUMMARY);
  await page.route('**/conversation/confirm', (route) => route.abort('failed'), { times: 1 });
  await page.getByRole('button', { name: 'Fechar briefing' }).click();

  // The summary that produced the failed close is frozen until the captain says
  // what to do with it: replay it, or drop it and edit.
  await expect(chat.getByRole('alert')).toBeVisible();
  await expect(summary).toHaveAttribute('readonly', '');
  await chat.getByRole('button', { name: 'Editar e reenviar' }).click();

  const corrected = `${CONSOLIDATED_SUMMARY} O acompanhamento é o diferencial.`;
  await summary.fill(corrected);
  await page.getByRole('button', { name: 'Fechar briefing' }).click();

  await expect(chat.locator('.chat-closed')).toContainText('Briefing fechado');
  const confirms = api.writes.filter((write) => write.path.endsWith('/confirm'));
  expect(confirms).toHaveLength(1);
  expect(confirms[0]?.body.summary).toBe(corrected);
  await expect(chat.locator('.chat-summary')).toHaveCount(0);
});

test('says a conversation it could not read was not read, and keeps the stage closed', async ({ page }) => {
  const api = new FakeConversationApi();
  await api.install(page);
  await page.route('**/conversation', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'falha ao ler' }) }), { times: 1 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Gate 1 · identidade' }).click();
  await page.getByLabel('Briefing do projeto').fill(ENTRY);
  await page.getByRole('button', { name: 'Criar execução de identidade' }).click();

  const chat = page.locator('.briefing-chat');
  await expect(chat.getByText('Não foi possível abrir a conversa desta execução')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Não foi possível abrir a conversa desta execução' })).toBeDisabled();

  await chat.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByLabel(/Conte sobre o negócio/)).toBeVisible();
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

test('closes a consolidated summary the server left unconfirmed, which unlocks the stage', async ({ page }) => {
  await openConversation(page, { initial: { state: 'final', briefing: ENTRY, summary: CONSOLIDATED_SUMMARY, messageCount: 4 } });
  const chat = page.locator('.briefing-chat');

  await expect(page.getByRole('button', { name: 'Feche o briefing para executar' })).toBeDisabled();
  const summary = page.getByLabel(/Briefing final, editável/);
  await expect(summary).toHaveValue(CONSOLIDATED_SUMMARY);
  await page.getByRole('button', { name: 'Fechar briefing' }).click();

  await expect(chat.locator('.chat-closed')).toContainText('Briefing fechado');
  await expect(page.getByRole('button', { name: 'Executar etapa de identidade' })).toBeEnabled();
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
