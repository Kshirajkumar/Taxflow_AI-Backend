async function telegramRequest(config, method, payload) {
  if (!config.telegramBotToken) throw new Error('telegram_bot_token_missing');
  const base = String(config.telegramApiBaseUrl || 'https://api.telegram.org').replace(/\/$/, '');
  const response = await fetch(`${base}/bot${encodeURIComponent(config.telegramBotToken)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    const error = new Error(body.description || `telegram_${method}_failed_${response.status}`);
    error.statusCode = response.status;
    error.telegramErrorCode = body.error_code;
    throw error;
  }
  return body.result;
}

function sendTelegramMessage(config, chatId, text) {
  return telegramRequest(config, 'sendMessage', { chat_id: String(chatId), text, disable_web_page_preview: true });
}

function getTelegramBot(config) {
  return telegramRequest(config, 'getMe', {});
}

module.exports = { getTelegramBot, sendTelegramMessage, telegramRequest };
