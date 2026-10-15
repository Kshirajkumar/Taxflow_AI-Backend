async function downloadWhatsAppMedia(media, config) {
  if (media.base64) return Buffer.from(media.base64, 'base64');
  if (media.content) return Buffer.from(media.content, 'base64');
  if (media.url) return Buffer.from(await (await fetch(media.url)).arrayBuffer());
  if (!media.id || !config.whatsappAccessToken) throw new Error('whatsapp_media_id_or_access_token_missing');
  const metadata = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(media.id)}`, { headers: { authorization: `Bearer ${config.whatsappAccessToken}` } });
  if (!metadata.ok) throw new Error(`whatsapp_media_metadata_failed_${metadata.status}`);
  const { url } = await metadata.json();
  if (!url) throw new Error('whatsapp_media_url_missing');
  const content = await fetch(url, { headers: { authorization: `Bearer ${config.whatsappAccessToken}` } });
  if (!content.ok) throw new Error(`whatsapp_media_download_failed_${content.status}`);
  return Buffer.from(await content.arrayBuffer());
}

async function downloadTelegramMedia(media, config) {
  if (media.base64) return Buffer.from(media.base64, 'base64');
  if (media.content) return Buffer.from(media.content, 'base64');
  if (!media.file_id || !config.telegramBotToken) throw new Error('telegram_file_id_or_bot_token_missing');
  const metadata = await fetch(`https://api.telegram.org/bot${encodeURIComponent(config.telegramBotToken)}/getFile?file_id=${encodeURIComponent(media.file_id)}`);
  if (!metadata.ok) throw new Error(`telegram_file_metadata_failed_${metadata.status}`);
  const body = await metadata.json();
  const filePath = body.result?.file_path;
  if (!body.ok || !filePath) throw new Error('telegram_file_path_missing');
  const content = await fetch(`https://api.telegram.org/file/bot${encodeURIComponent(config.telegramBotToken)}/${filePath}`);
  if (!content.ok) throw new Error(`telegram_file_download_failed_${content.status}`);
  return Buffer.from(await content.arrayBuffer());
}

module.exports = { downloadWhatsAppMedia, downloadTelegramMedia };
