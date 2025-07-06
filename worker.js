/*
Required Environment Variables:
  - ENV_BOT_TOKEN: Your Telegram Bot Token from @BotFather.
  - ENV_BOT_SECRET: Obtain a Random UUID as a Secret. (https://www.uuidgenerator.net)
  - ENV_ADMIN_UID: Your Telegram UID. Get it from Bots Like @userinfobot.

  Optional Environment Variables:
  - ENV_DB_TYPE: The Type of Database. Can be 'KV' (default) or 'D1'.
  - ENV_DB_NAME: The Name of the KV or D1. Defaults to 'nfd'.
  - ENV_TIMEZONE: The Timezone for Timestamps. Defaults to 'UTC'.

 Register/UnRegister the WebSocket:
  https://xxx.workers.dev/registerWebhook
  https://xxx.workers.dev/unRegisterWebhook
*/

// This is the endpoint for the bot's webhook.
const WEBHOOK = '/endpoint'

// --- Constants moved to be accessed from 'env' object within functions ---

// Notification interval: 1 hour
const NOTIFY_INTERVAL = 3600 * 1000;
// URL for the fraud database.
const FRAUD_DB_URL = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
// Toggle for sending new message notifications to the admin.
const enable_notification = true
// Key for storing the bot's start time in the database.
const BOT_START_TIME_KEY = 'bot-start-time';

// Default menu for regular users.
const USER_MENU = [
  { command: "start", description: "🚀 Start the Bot" },
  { command: "help", description: "❓ Get Help Information" }
];

// Menu for the admin user.
const ADMIN_MENU = [
  { command: "start", description: "🚀 Start the Bot" },
  { command: "help", description: "❓ Get Help Information" },
  { command: "status", description: "📊 Check Bot Status & Statistics" },
  { command: "block", description: "🚫 Block User" },
  { command: "unblock", description: "✅ Unblock User" },
  { command: "checkblock", description: "ℹ️ Check Block Status" }
];

// --- Database Abstraction Layer ---
// This class provides a consistent way to interact with either KV or D1 databases.
// D1 implementation uses separate tables for different data types to better organize data,
// while maintaining a simple key-value interface for the application logic.
class DatabaseAdapter {
  constructor(type, dbName, env) {
    this.type = type.toUpperCase();
    this.dbName = dbName;
    this.env = env;
    // Get the database instance upon initialization.
    this.dbInstance = this.getDbInstance();
  }

  getDbInstance() {
    // In an ES module environment, database bindings are passed through the `env` parameter.
    if (this.env && this.env[this.dbName]) {
      return this.env[this.dbName];
    }
    
    // Fallback to global access for backward compatibility (less common for modern workers).
    if (typeof globalThis[this.dbName] !== 'undefined') {
      return globalThis[this.dbName];
    } else if (typeof self !== 'undefined' && typeof self[this.dbName] !== 'undefined') {
      return self[this.dbName];
    } else if (typeof window !== 'undefined' && typeof window[this.dbName] !== 'undefined') {
      return window[this.dbName];
    }
    
    console.error(`Cannot find database instance: ${this.dbName}`);
    return null;
  }
  
  /**
   * For D1, determines the correct table name based on the key's prefix.
   * This allows for organizing data into logical tables.
   * @param {string} key The key for the data.
   * @returns {string} The name of the D1 table.
   */
  _getD1TableName(key) {
    if (key.startsWith('stats-')) return 'stats';
    if (key.startsWith('msg-map-')) return 'mappings';
    if (key.startsWith('isblocked-') || key.startsWith('lastmsg-')) return 'users';
    // Default table for general settings like bot start time.
    return 'settings';
  }

  async get(key) {
    if (!this.dbInstance) {
      console.error('Database instance not available');
      return null;
    }

    try {
      if (this.type === 'KV') {
        return await this.dbInstance.get(key, { type: "json" });
      } else if (this.type === 'D1') {
        const tableName = this._getD1TableName(key);
        const stmt = `SELECT value FROM ${tableName} WHERE key = ?`;
        const result = await this.dbInstance.prepare(stmt).bind(key).first();
        return result ? JSON.parse(result.value) : null;
      }
    } catch (error) {
      console.error(`Database get error for key ${key}:`, error);
      return null;
    }
    throw new Error(`Unsupported database type: ${this.type}`);
  }

  async put(key, value) {
    if (!this.dbInstance) {
      console.error('Database instance not available');
      return;
    }

    try {
      if (this.type === 'KV') {
        await this.dbInstance.put(key, JSON.stringify(value));
        return;
      } else if (this.type === 'D1') {
        const tableName = this._getD1TableName(key);
        const jsonValue = JSON.stringify(value);
        const stmt = `INSERT OR REPLACE INTO ${tableName} (key, value) VALUES (?, ?)`;
        await this.dbInstance.prepare(stmt).bind(key, jsonValue).run();
        return;
      }
    } catch (error) {
      console.error(`Database put error for key ${key}:`, error);
      return;
    }
    throw new Error(`Unsupported database type: ${this.type}`);
  }

  async delete(key) {
    if (!this.dbInstance) {
      console.error('Database instance not available');
      return;
    }

    try {
      if (this.type === 'KV') {
        await this.dbInstance.delete(key);
        return;
      } else if (this.type === 'D1') {
        const tableName = this._getD1TableName(key);
        const stmt = `DELETE FROM ${tableName} WHERE key = ?`;
        await this.dbInstance.prepare(stmt).bind(key).run();
        return;
      }
    } catch (error) {
      console.error(`Database delete error for key ${key}:`, error);
      return;
    }
    throw new Error(`Unsupported database type: ${this.type}`);
  }

  async init() {
    if (this.type === 'D1' && this.dbInstance) {
      try {
        const tableNames = ['settings', 'stats', 'mappings', 'users'];
        const statements = [];

        for (const tableName of tableNames) {
          statements.push(this.dbInstance.prepare(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `));
          
          statements.push(this.dbInstance.prepare(
            `CREATE INDEX IF NOT EXISTS idx_${tableName}_key ON ${tableName}(key)`
          ));
        }

        await this.dbInstance.batch(statements);
        console.log('D1 database tables and indexes initialized successfully.');
      } catch (error) {
        console.error('Failed to initialize D1 database via batch:', error);
        console.log('Attempting to initialize tables sequentially...');
        try {
            const tableNames = ['settings', 'stats', 'mappings', 'users'];
            for (const tableName of tableNames) {
                 await this.dbInstance.prepare(`
                    CREATE TABLE IF NOT EXISTS ${tableName} (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                 `).run();
                 await this.dbInstance.prepare(
                    `CREATE INDEX IF NOT EXISTS idx_${tableName}_key ON ${tableName}(key)`
                 ).run();
            }
            console.log('D1 tables initialized sequentially.');
        } catch(e) {
            console.error('Sequential D1 initialization failed:', e);
            throw e;
        }
      }
    }
  }

  async healthCheck() {
    if (!this.dbInstance) {
      return { healthy: false, error: 'Database instance not available' };
    }

    try {
      if (this.type === 'KV') {
        await this.dbInstance.get('health-check', { type: "text" });
        return { healthy: true, type: this.type };
      } else if (this.type === 'D1') {
        await this.dbInstance.prepare("SELECT 1").first();
        return { healthy: true, type: this.type };
      }
    } catch (error) {
      return { healthy: false, error: error.message, type: this.type };
    }
    return { healthy: false, error: `Unsupported database type: ${this.type}` };
  }
}

// --- Telegram API Communication ---

/**
 * Constructs the URL for a Telegram API method.
 * @param {object} env - The worker environment object containing secrets.
 * @param {string} methodName - The name of the API method.
 * @param {object|null} params - Optional URL parameters.
 * @returns {string} The full Telegram API URL.
 */
function apiUrl (env, methodName, params = null) {
  let query = ''
  if (params) {
    query = '?' + new URLSearchParams(params).toString()
  }
  return `https://api.telegram.org/bot${env.ENV_BOT_TOKEN}/${methodName}${query}`
}

/**
 * Sends a request to the Telegram API with a timeout and error handling.
 * @param {object} env - The worker environment object.
 * @param {string} methodName - The API method to call.
 * @param {object} body - The request body.
 * @param {object|null} params - Optional URL parameters.
 * @param {number} timeout - Request timeout in milliseconds.
 * @returns {Promise<object>} The JSON response from Telegram.
 */
async function requestTelegram(env, methodName, body, params = null, timeout = 15000){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(apiUrl(env, methodName, params), {
      ...body,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
        const errorBody = await response.text();
        console.error(`Telegram API Error: ${response.status} ${response.statusText}`, errorBody);
        throw new Error(`Telegram API error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`Telegram request failed for ${methodName}:`, error);
    throw error;
  }
}

/**
 * Creates a standard request body for POST requests.
 * @param {object} body - The JSON payload.
 * @returns {object} The fetch request body object.
 */
function makeReqBody(body){
  return {
    method:'POST',
    headers:{
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }
}

// --- API Helper Functions ---
function sendMessage(env, msg = {}){
  return requestTelegram(env, 'sendMessage', makeReqBody(msg))
}

function copyMessage(env, msg = {}){
  return requestTelegram(env, 'copyMessage', makeReqBody(msg))
}

function forwardMessage(env, msg){
  return requestTelegram(env, 'forwardMessage', makeReqBody(msg))
}

/**
 * Sets the bot's menu commands for either admins or regular users.
 * @param {object} env - The worker environment object.
 * @param {boolean} isAdmin - Whether to set the admin menu.
 */
async function setBotMenu(env, isAdmin = false) {
  try {
    if (isAdmin) {
      await requestTelegram(env, 'setMyCommands', makeReqBody({
        commands: ADMIN_MENU,
        scope: { type: "chat", chat_id: env.ENV_ADMIN_UID }
      }));
    } else {
      await requestTelegram(env, 'setMyCommands', makeReqBody({
        commands: USER_MENU,
        scope: { type: "all_private_chats" }
      }));
    }
  } catch (error) {
    console.error('Failed to set bot menu:', error);
  }
}


// --- Bot Logic and Statistics ---

/**
 * Formats milliseconds into a human-readable uptime string (e.g., "1d 2h 3m 4s").
 */
const formatUptime = (ms) => {
    if (ms < 0) ms = 0;
    const s = Math.floor((ms / 1000) % 60);
    const m = Math.floor((ms / (1000 * 60)) % 60);
    const h = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const d = Math.floor(ms / (1000 * 60 * 60 * 24));
    return [
        d > 0 ? `${d}d` : '',
        h > 0 ? `${h}h` : '',
        m > 0 ? `${m}m` : '',
        s > 0 || (d === 0 && h === 0 && m === 0) ? `${s}s` : ''
    ].filter(Boolean).join(' ');
};

/**
 * Retrieves bot statistics and status information.
 * @param {DatabaseAdapter} db - The database adapter.
 * @param {object} env - The worker environment object.
 * @returns {Promise<object|null>} An object with bot stats or null on error.
 */
async function getBotStats(db, env) {
  try {
    const formatDateTime = (date) => {
      const timezoneToUse = env.ENV_TIMEZONE || 'UTC';
      return date.toLocaleString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23', timeZone: timezoneToUse, timeZoneName: 'short',
      });
    };

    const now = new Date();
    const botStartTimeMillis = await db.get(BOT_START_TIME_KEY) || now.getTime();
    
    return {
      status: "Online",
      timestamp: formatDateTime(now),
      database: env.ENV_DB_TYPE || 'KV',
      messagesProcessed: await db.get('stats-messages') || 0,
      fraudDetected: await db.get('stats-fraud') || 0,
      uptime: formatUptime(now.getTime() - botStartTimeMillis),
    };
  } catch (error) {
    console.error('Error getting bot stats:', error);
    return null;
  }
}

// --- Stat Updaters ---
async function updateMessageStats(db) {
  try {
    await db.put('stats-messages', (await db.get('stats-messages') || 0) + 1);
  } catch (error) {
    console.error('Error updating message stats:', error);
  }
}

async function updateFraudStats(db) {
  try {
    await db.put('stats-fraud', (await db.get('stats-fraud') || 0) + 1);
  } catch (error) {
    console.error('Error updating fraud stats:', error);
  }
}

/**
 * Checks if a user ID is in the fraud database.
 * @param {string|number} id - The user ID to check.
 * @returns {Promise<boolean>} True if the user is a fraud risk, false otherwise.
 */
async function isFraud(id) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(FRAUD_DB_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.error('Failed to fetch fraud DB:', response.status);
      return false;
    }
    
    const dbContent = await response.text();
    const fraudIds = new Set(dbContent.split('\n').filter(v => v.trim()));
    return fraudIds.has(id.toString());
  } catch (error) {
    console.error('Error fetching fraud DB:', error);
    return false;
  }
}


// --- Message and Command Handlers ---

/**
 * Handles incoming webhook requests from Telegram.
 * @param {Request} request - The incoming request.
 * @param {object} env - The worker environment object.
 */
async function handleWebhook (request, env) {
  try {
    const DB_TYPE = env.ENV_DB_TYPE || 'KV';
    const DB_NAME = env.ENV_DB_NAME || 'nfd';
    const db = new DatabaseAdapter(DB_TYPE, DB_NAME, env);
    
    const healthCheck = await db.healthCheck();
    if (!healthCheck.healthy) {
      console.error('Database health check failed:', healthCheck.error);
    }
    
    if (!await db.get(BOT_START_TIME_KEY)) {
        await db.put(BOT_START_TIME_KEY, Date.now());
    }

    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.ENV_BOT_SECRET) {
      return new Response('Unauthorized', { status: 403 })
    }

    const update = await request.json()
    await onUpdate(update, db, env)
    return new Response('Ok')
  } catch (error) {
    console.error('Webhook error:', error);
    return new Response('Error handling webhook', { status: 500 })
  }
}

async function onUpdate (update, db, env) {
  if ('message' in update) {
    await onMessage(update.message, db, env)
  }
}

async function onMessage (message, db, env) {
  try {
    await updateMessageStats(db);
    
    if (message.text && message.text.startsWith('/')) {
      return await handleCommand(message, db, env);
    }
    
    if(message.chat.id.toString() === env.ENV_ADMIN_UID){
      return await handleAdminMessage(message, db, env);
    }
    
    return await handleGuestMessage(message, db, env)
  } catch (error) {
    console.error('Message handling error:', error);
  }
}

async function handleCommand(message, db, env) {
  const command = message.text.split(' ')[0].substring(1).toLowerCase();
  const chatId = message.chat.id;
  const isAdmin = chatId.toString() === env.ENV_ADMIN_UID;
  
  switch (command) {
    case 'start':
      return sendMessage(env, {
        chat_id: chatId,
        text: isAdmin 
          ? '🤖 Admin Panel Active!\n\nUse the Menu Commands or Reply to Forwarded Messages to Manage Users.'
          : '🤖 Bot is Running! Send Me a Message and I\'ll Forward it to the Admin.\n\n⚠️ Please Verify All Information Before Any Transactions!',
      });
    
    case 'help':
      const helpText = isAdmin 
        ? `🔧 *Admin Commands:*\n\n/start - Restart Bot\n/help - Show this Help\n/status - View Bot Status & Statistics\n/block - Block User\n/unblock - Unblock User\n/checkblock - Check Block Status\n\n💡 Reply to Forwarded Messages to Respond to Users.`
        : `❓ *How to Use this Bot:*\n\n/start - Start the Bot\n/help - Show this Help\n\n💬 Just Send Me Any Message and I'll Forward it to the Admin.\n\n⚠️ Always Verify Information Before Any Transactions!`;
      return sendMessage(env, { chat_id: chatId, text: helpText, parse_mode: 'Markdown' });
    
    case 'status':
      if (isAdmin) {
        const stats = await getBotStats(db, env);
        if (stats) {
          return sendMessage(env, {
            chat_id: chatId,
            text: `📊 *Bot Status & Statistics:*\n\n✅ Status: ${stats.status}\n🕒 Timestamp: ${stats.timestamp}\n💾 Database: ${stats.database}\n\n📈 *Statistics:*\n📊 Messages Processed: ${stats.messagesProcessed}\n🚨 Fraud Detected: ${stats.fraudDetected}\n🕒 Uptime: ${stats.uptime}`,
            parse_mode: 'Markdown'
          });
        }
      }
      break; // Non-admins calling /status will just fall through silently
    
    case 'block':
      return isAdmin ? handleBlock(message, db, env) : Promise.resolve();
    
    case 'unblock':
      return isAdmin ? handleUnBlock(message, db, env) : Promise.resolve();
    
    case 'checkblock':
      return isAdmin ? checkBlock(message, db, env) : Promise.resolve();
    
    default:
      return sendMessage(env, {
        chat_id: chatId,
        text: '❓ Unknown Command. Use /help to See Available Commands.'
      });
  }
}

async function handleAdminMessage(message, db, env) {
  if(!message?.reply_to_message?.chat){
    return sendMessage(env, {
      chat_id: env.ENV_ADMIN_UID,
      text:'💡 Reply to Forwarded Messages to Respond to Users, or Use the Menu Commands.'
    })
  }
  
  const guestChatId = await db.get('msg-map-' + message?.reply_to_message.message_id)
  if (!guestChatId) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text: '❌ Cannot Find Original Message' })
  }
  
  return copyMessage(env, {
    chat_id: guestChatId,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  })
}

async function handleGuestMessage(message, db, env){
  const chatId = message.chat.id;
  
  const [isBlocked, isFraudUser] = await Promise.all([
    db.get('isblocked-' + chatId),
    isFraud(chatId)
  ]);
  
  if(isBlocked){
    return sendMessage(env, { chat_id: chatId, text:'🚫 You are Blocked from Using this Bot.' })
  }

  if(isFraudUser){
    await updateFraudStats(db);
    return sendMessage(env, {
      chat_id: env.ENV_ADMIN_UID,
      text:`🚨 *SCAM ALERT*\n\n👤 User ID: ${chatId}\n📝 Message: ${message.text || '[No text content]'}\n⚠️ This User is in the Fraud Database!`,
      parse_mode: 'Markdown'
    })
  }

  const forwardReq = await forwardMessage(env, {
    chat_id: env.ENV_ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id
  })
  
  if(forwardReq?.ok){
    await db.put('msg-map-' + forwardReq.result.message_id, chatId);
  }
  
  return handleNotify(chatId, db, env)
}

async function handleNotify(chatId, db, env){
  if(!enable_notification) return;
  
  const lastMsgTime = await db.get('lastmsg-' + chatId)
  
  if(!lastMsgTime || Date.now() - lastMsgTime > NOTIFY_INTERVAL){
    await db.put('lastmsg-' + chatId, Date.now());
    return sendMessage(env, {
      chat_id: env.ENV_ADMIN_UID,
      text: `💬 *New Message*\n\n👤 From User: ${chatId}\n⚠️ Please Verify All Information Before Trading!`,
      parse_mode: 'Markdown'
    })
  }
}

async function handleBlock(message, db, env){
  if (!message?.reply_to_message) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text: '❌ Please Reply to a Forwarded Message to Block the User.' });
  }
  const guestChatId = await db.get('msg-map-' + message.reply_to_message.message_id)
  if(!guestChatId) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text:'❌ Cannot Find User to Block' })
  }
  if(guestChatId.toString() === env.ENV_ADMIN_UID){
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text:'❌ You Cannot Block Yourself' })
  }
  await db.put('isblocked-' + guestChatId, true)
  return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text: `🚫 User ${guestChatId} has been Blocked` })
}

async function handleUnBlock(message, db, env){
  if (!message?.reply_to_message) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text: '❌ Please Reply to a Forwarded Message to Unblock the User.' });
  }
  const guestChatId = await db.get('msg-map-' + message.reply_to_message.message_id)
  if(!guestChatId) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text:'❌ Cannot Find User to Unblock' })
  }
  await db.put('isblocked-' + guestChatId, false)
  return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text:`✅ User ${guestChatId} has been Unblocked` })
}

async function checkBlock(message, db, env){
  if (!message?.reply_to_message) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text: '❌ Please Reply to a Forwarded Message to Check Block Status.' });
  }
  const guestChatId = await db.get('msg-map-' + message.reply_to_message.message_id)
  if(!guestChatId) {
    return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text:'❌ Cannot Find User' })
  }
  const blocked = await db.get('isblocked-' + guestChatId)
  return sendMessage(env, { chat_id: env.ENV_ADMIN_UID, text: `ℹ️ User ${guestChatId} is ` + (blocked ? '🚫 Blocked' : '✅ Not Blocked') })
}

// --- Webhook Registration ---

async function registerWebhook (request, env, requestUrl) {
  try {
    const DB_TYPE = env.ENV_DB_TYPE || 'KV';
    const DB_NAME = env.ENV_DB_NAME || 'nfd';
    const db = new DatabaseAdapter(DB_TYPE, DB_NAME, env);
    
    console.log('Database health check:', await db.healthCheck());

    if (DB_TYPE === 'D1') {
      await db.init();
    }
    
    if (!await db.get(BOT_START_TIME_KEY)) {
        await db.put(BOT_START_TIME_KEY, Date.now());
    }
    
    const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${WEBHOOK}`
    const r = await (await fetch(apiUrl(env, 'setWebhook', { url: webhookUrl, secret_token: env.ENV_BOT_SECRET }))).json()
    
    if (r.ok) {
      await setBotMenu(env, false);
      await setBotMenu(env, true);
      console.log('Bot menus set successfully');
    }
    
    return new Response('ok' in r && r.ok ? `Ok - Webhook and Menu Set (DB: ${DB_TYPE})` : JSON.stringify(r, null, 2))
  } catch (error) {
    console.error('Webhook registration error:', error);
    return new Response(`Error: ${error.message}`, { status: 500 })
  }
}

async function unRegisterWebhook (request, env) {
  try {
    const r = await (await fetch(apiUrl(env, 'setWebhook', { url: '' }))).json()
    return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 })
  }
}

// --- Main Worker Entrypoint ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    try {
      if (url.pathname === WEBHOOK) {
        return await handleWebhook(request, env)
      } else if (url.pathname === '/registerWebhook') {
        return await registerWebhook(request, env, url)
      } else if (url.pathname === '/unRegisterWebhook') {
        return await unRegisterWebhook(request, env)
      } else {
        return new Response('Endpoint not found. Visit /registerWebhook to set up the bot.', { status: 404 })
      }
    } catch(err) {
      console.error("Top level error:", err);
      return new Response("An internal error occurred", {status: 500});
    }
  }
}