const TelegramBot = require('node-telegram-bot-api');

module.exports = function initBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN missing from environment variables.');
    return;
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log('Telebob Bot Engine running on Long Polling...');

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const webAppUrl = process.env.WEB_APP_URL || 'https://your-app.up.railway.app';

    bot.sendMessage(chatId, '🚀 Welcome to the xRocket Trading Terminal on Telebob!', {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🚀 Open Terminal Settings',
              web_app: { url: webAppUrl }
            }
          ]
        ]
      }
    });
  });

  return bot;
};
