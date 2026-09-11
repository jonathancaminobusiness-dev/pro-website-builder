const duplicateCodes = new Set(['SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE']);

/**
 * Swallows the one failure a second writer of the same row can produce. Two
 * objects in this server write the same ledger rows — an identity run and the
 * prototype run seeded from it share the version the captain approved — and the
 * row is content-addressed, so the duplicate is the same fact written twice.
 */
export async function ignoringDuplicate(write: Promise<void>): Promise<void> {
  try { await write; } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (!duplicateCodes.has(code)) throw error;
  }
}
