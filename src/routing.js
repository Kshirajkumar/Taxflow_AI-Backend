function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function parsePeriod(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const numeric = text.match(/\b(20\d{2})[-\/.](0?[1-9]|1[0-2])\b|\b(0?[1-9]|1[0-2])[-\/.](20\d{2})\b/);
  if (numeric) return numeric[1] ? { year: Number(numeric[1]), month: Number(numeric[2]) } : { year: Number(numeric[4]), month: Number(numeric[3]) };
  const monthNames = 'january february march april may june july august september october november december'.split(' ');
  const named = text.toLowerCase().match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/);
  return named ? { year: Number(named[2]), month: monthNames.indexOf(named[1]) + 1 } : null;
}

function intakeHints(message = {}) {
  const text = String(message.caption || message.text || '');
  const explicitClient = message.client_id || text.match(/(?:^|\s)(?:client|client_id)[:=\s]+([A-Za-z0-9_-]+)/i)?.[1];
  const period = message.year && message.month
    ? { year: Number(message.year), month: Number(message.month) }
    : parsePeriod(text);
  return { clientId: explicitClient, telegramUsername: message.from?.username, telegramUserId: message.from?.id, year: period?.year, month: period?.month };
}

function resolveRoute(input, clients) {
  const sender = normalize(input.sender);
  const explicit = normalize(input.clientId);
  const telegramUsername = normalize(input.telegramUsername);
  const telegramUserId = normalize(input.telegramUserId);
  const candidates = clients.filter((client) => {
    if (explicit && normalize(client.id) === explicit) return true;
    const aliases = [client.id, client.name, ...(client.aliases || []), client.phone, client.telegramUsername, client.telegramUserId].map(normalize);
    return [sender, telegramUsername, telegramUserId].some((value) => value && aliases.some((alias) => alias && (value === alias || value.includes(alias))));
  });
  if (candidates.length !== 1) return { status: 'quarantine', reason: candidates.length ? 'ambiguous_client' : 'unknown_client' };
  const client = candidates[0];
  const period = input.year && input.month ? { year: Number(input.year), month: Number(input.month) } : null;
  if (!period || !Number.isInteger(period.year) || !Number.isInteger(period.month) || period.month < 1 || period.month > 12) {
    return { status: 'quarantine', reason: 'unknown_period', clientId: client.id, clientName: client.name };
  }
  return { status: 'routed', clientId: client.id, clientName: client.name, year: period.year, month: period.month };
}

module.exports = { resolveRoute, intakeHints, parsePeriod };
