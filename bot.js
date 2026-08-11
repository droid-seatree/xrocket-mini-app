const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const CONFIG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  adminChatId: process.env.TELEGRAM_CHAT_ID, // Admin Telegram ID
  adminGramAddress: 'UQBKSdooh-MvNvxhmpxi5cYrYqkLKfqsElZCI0tjLXn2iyfD', // 3% fee destination wallet
  adminFeePercent: 0.03, // 3% platform fee for standard users
  xrocketApiKey: process.env.XROCKET_API_KEY,
  withdrawCurrency: 'USDT',
  requiredAccessKey: process.env.ACCESS_KEY || '11c404e0a9d31914f6003a9af65f301eeb9721deff93e59b02daaf683d6f0f7e',
  targetPairs: ['BTC_USDT', 'XAUT_USDT', 'ETH_USDT', 'SOL_USDT'],
  stopLossPercent: 0.065, // Fixed 6.5% Stop Loss
  maxTradeUsdtCap: 25.00,
  balanceTradeRatio: 0.25
};

// Initialize persistent SQLite database
const db = new sqlite3.Database(path.join(__dirname, 'wallets.db'));

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      chat_id TEXT PRIMARY KEY,
      wallet_address TEXT,
      is_authenticated INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

const dbSaveWallet = (chatId, wallet, isAuthenticated) => {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO user_wallets (chat_id, wallet_address, is_authenticated, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      [chatId.toString(), wallet, isAuthenticated ? 1 : 0],
      function (err) {
        if (err) reject(err);
        else resolve(this);
      }
    );
  });
};

const dbGetUserData = (chatId) => {
  return new Promise((resolve, reject) => {
    db.get(`SELECT wallet_address, is_authenticated FROM user_wallets WHERE chat_id = ?`, [chatId.toString()], (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
};

const bot = new TelegramBot(CONFIG.telegramToken, { polling: true });
const isAdmin = (chatId) => chatId.toString() === CONFIG.adminChatId.toString();

// Command: /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userData = await dbGetUserData(chatId);
  const userRole = isAdmin(chatId) ? '👑 Administrator (Unlocked)' : '👤 Trader';
  const statusNotice = (isAdmin(chatId) || userData?.is_authenticated) ? '🟢 Access Granted' : '🔒 Access Locked (Key Required)';

  bot.sendMessage(chatId, `<b>xRocket Terminal</b>\nRole: <b>${userRole}</b>\nStatus: <b>${statusNotice}</b>\n\nClick below to configure settings & unlock:`, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Open Terminal Settings", web_app: { url: process.env.WEB_APP_URL } }]
      ]
    }
  });
});

// Process incoming WebApp settings & validate Access Key
bot.on('web_app_data', async (msg) => {
  const chatId = msg.chat.id;
  try {
    const data = JSON.parse(msg.web_app_data.data);

    // Verify Access Key (Admin bypasses requirement)
    const isKeyValid = data.accessKey === CONFIG.requiredAccessKey;
    const hasAccess = isAdmin(chatId) || isKeyValid;

    if (!hasAccess) {
      await bot.sendMessage(
        chatId,
        `<b>❌ ACCESS DENIED</b>\nInvalid Terminal Access Key. Access to xRocket API engine was blocked.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (data.action === "SAVE_SETTINGS" && data.userWallet) {
      await dbSaveWallet(chatId, data.userWallet, true);
      const roleNotice = isAdmin(chatId) ? "Administrator Mode (0% Fee)" : "Trader Mode (3% Creator Fee Applied)";

      await bot.sendMessage(
        chatId,
        `<b>🔓 ACCESS GRANTED</b>\nWallet: <code>${data.userWallet}</code>\nMode: <b>${roleNotice}</b>`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    console.error("Error processing WebApp payload:", err.message);
  }
});

// Place order execution via xRocket API
async function placeXrocketOrder(orderParams) {
  try {
    const response = await fetch("https://pay.xrocket.tg/api/v1/trade/order", {
      method: 'POST',
      headers: {
        'Rocket-Pay-Key': CONFIG.xrocketApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderParams)
    });
    return await response.json();
  } catch (err) {
    console.error("xRocket Order Placement Error:", err.message);
    return null;
  }
}

// Evaluate Trade Execution (Enforces risk management and auth check)
async function evaluateAndTrade(chatId, pair, priceData) {
  const userData = await dbGetUserData(chatId);

  // Security Gate: Ensure user is authenticated before calling xRocket API
  if (!isAdmin(chatId) && !userData?.is_authenticated) {
    console.log(`Blocked trade attempt for unauthorized Chat ID: ${chatId}`);
    return;
  }

  const isTargetPair = CONFIG.targetPairs.includes(pair);
  const isSafeFallback = !isTargetPair && priceData.volatility < 0.02 && priceData.momentum > 0.01;

  if (isTargetPair || isSafeFallback) {
    const tradeAmount = Math.min(priceData.availableBalance * CONFIG.balanceTradeRatio, CONFIG.maxTradeUsdtCap);
    const entryPrice = priceData.currentPrice;
    const stopLossPrice = entryPrice * (1 - CONFIG.stopLossPercent);

    // Place buy order on xRocket
    const order = await placeXrocketOrder({
      pair: pair,
      side: 'BUY',
      amount: tradeAmount,
      stopLoss: stopLossPrice
    });

    await bot.sendMessage(chatId,
      `<b>🚨 TRADE EXECUTED</b>\n` +
      `<b>Pair:</b> ${pair}\n` +
      `<b>Size:</b> $${tradeAmount.toFixed(2)}\n` +
      `<b>Entry Price:</b> $${entryPrice}\n` +
      `<b>Stop Loss (6.5%):</b> $${stopLossPrice.toFixed(4)}`,
      { parse_mode: 'HTML' }
    );

    return order;
  }
}

// Automated Profit Payout Engine (Admin gets 100%, Non-Admin splits 3% fee to Admin)
async function processProfitWithdrawal(chatId, profitAmount) {
  if (profitAmount <= 0) return;

  const userData = await dbGetUserData(chatId);
  const userWallet = userData?.wallet_address;

  if (!userWallet) {
    console.error(`No saved wallet found for Chat ID ${chatId}`);
    return;
  }

  if (isAdmin(chatId)) {
    // Admin receives 100% of profit with 0% fee
    await executeXrocketTransfer(userWallet, profitAmount);
    await bot.sendMessage(chatId, `<b>💰 ADMIN WITHDRAWAL (100%)</b>\nSent $${profitAmount.toFixed(2)} to <code>${userWallet}</code>`, { parse_mode: 'HTML' });
  } else {
    // Non-Admin: Route 3% fee to Admin GRAM address and 97% to user
    const adminFee = profitAmount * CONFIG.adminFeePercent;
    const userPayout = profitAmount * (1 - CONFIG.adminFeePercent);

    // 1. Send 97% profit to user wallet
    await executeXrocketTransfer(userWallet, userPayout);
    await bot.sendMessage(chatId, `<b>💰 PROFIT WITHDRAWN (97%)</b>\nSent $${userPayout.toFixed(2)} to <code>${userWallet}</code>\n<i>(3% creator fee applied: $${adminFee.toFixed(2)})</i>`, { parse_mode: 'HTML' });

    // 2. Route 3% fee to Admin GRAM wallet
    await executeXrocketTransfer(CONFIG.adminGramAddress, adminFee);
    await bot.sendMessage(CONFIG.adminChatId, `<b>👑 ADMIN FEE COLLECTED (3%)</b>\nReceived $${adminFee.toFixed(2)} from user <code>${chatId}</code>`, { parse_mode: 'HTML' });
  }
}

// xRocket Pay API Transfer Call
async function executeXrocketTransfer(targetAddress, amount) {
  try {
    return await fetch("https://pay.xrocket.tg/api/v1/withdraw", {
      method: 'POST',
      headers: {
        'Rocket-Pay-Key': CONFIG.xrocketApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        network: 'TON',
        currency: CONFIG.withdrawCurrency,
        amount: amount,
        address: targetAddress
      })
    });
  } catch (err) {
    console.error("xRocket Transfer Error:", err.message);
  }
}

console.log("xRocket Bot Engine running on Long Polling...");
