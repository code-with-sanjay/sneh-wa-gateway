// ============================================================
//  Sneh WA-Gateway – Production Server
//  Custom MongoDB KeyStore (Full KeyStore interface)
// ============================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { 
  makeWASocket, 
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 5000;
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080,https://snehai.netlify.app').split(',');
const MONGODB_URI = process.env.MONGODB_URI;

// ===== SETUP =====
const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ===== DATABASE CONNECTION =====
let dbClient = null;
let sessionsCollection = null;
let keysCollection = null;

async function connectToDatabase() {
  if (!MONGODB_URI) {
    console.warn('[DB] MongoDB not configured – sessions will be ephemeral (file‑based).');
    return null;
  }
  try {
    dbClient = new MongoClient(MONGODB_URI, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000
    });
    await dbClient.connect();
    const db = dbClient.db('sneh');
    sessionsCollection = db.collection('sessions');
    keysCollection = db.collection('keys');
    await sessionsCollection.createIndex({ userId: 1 }, { unique: true });
    await keysCollection.createIndex({ userId: 1, type: 1, ids: 1 });
    console.log('[DB] Connected to MongoDB.');
    return sessionsCollection;
  } catch (err) {
    console.error('[DB] Failed to connect to MongoDB:', err);
    return null;
  }
}

// ============================================================
//  CUSTOM KEYSTORE (Backed by MongoDB)
//  Implements the full Baileys KeyStore interface
// ============================================================
class MongoKeyStore {
  constructor(userId) {
    this.userId = userId;
  }

  async get(type, ids) {
    if (!keysCollection) return [];
    try {
      const docs = await keysCollection.find({ userId: this.userId, type, ids: { $in: ids } }).toArray();
      return docs.map(doc => ({ ...doc.data }));
    } catch {
      return [];
    }
  }

  async set(data) {
    if (!keysCollection) return;
    for (const item of data) {
      const { id, type, value } = item;
      await keysCollection.updateOne(
        { userId: this.userId, type, id },
        { $set: { userId: this.userId, type, id, data: value } },
        { upsert: true }
      );
    }
  }

  async getOrCreate(type, ids) {
    if (!keysCollection) return [];
    const existing = await this.get(type, ids);
    if (existing.length > 0) return existing;
    // Create new keys (Baileys will populate them)
    const newKeys = ids.map(id => ({ id, type, value: null }));
    await this.set(newKeys);
    return newKeys;
  }

  async delete(type, ids) {
    if (!keysCollection) return;
    await keysCollection.deleteMany({ userId: this.userId, type, id: { $in: ids } });
  }

  async clear() {
    if (!keysCollection) return;
    await keysCollection.deleteMany({ userId: this.userId });
  }
}

// ============================================================
//  CUSTOM AUTH STATE (Creds + KeyStore)
// ============================================================
async function getMongoAuthState(userId) {
  // If MongoDB is not available, fallback to file
  if (!sessionsCollection) {
    const userSessionDir = path.join(SESSION_DIR, userId);
    if (!fs.existsSync(userSessionDir)) {
      fs.mkdirSync(userSessionDir, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
    return { state, saveCreds };
  }

  // Load credentials from MongoDB
  const doc = await sessionsCollection.findOne({ userId });
  const creds = doc?.creds || {};

  // Create state with creds and the custom key store
  const state = {
    creds,
    keys: new MongoKeyStore(userId)
  };

  const saveCreds = async () => {
    try {
      await sessionsCollection.updateOne(
        { userId },
        { $set: { userId, creds: state.creds } },
        { upsert: true }
      );
    } catch (err) {
      console.error(`[DB] Failed to save creds for ${userId}:`, err);
    }
  };

  return { state, saveCreds };
}

// ===== SESSION MANAGEMENT =====
const activeSockets = {};
const pendingQRs = {};
const reconnectAttempts = {};

// ===== CONNECTION FUNCTION =====
async function connectToWhatsApp(userId, res = null) {
  if (MONGODB_URI && !sessionsCollection) {
    await connectToDatabase();
  }

  const { state, saveCreds } = await getMongoAuthState(userId);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    browser: ['Sneh AI Gateway', 'Chrome', '120.0.0.0'],
    version: [2, 3000, 1015901307],
    keepAliveIntervalMs: 30000,
  });

  activeSockets[userId] = sock;
  reconnectAttempts[userId] = 0;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataURL = await QRCode.toDataURL(qr);
        pendingQRs[userId] = qrDataURL;
        if (res && !res.headersSent) {
          res.json({ qr: qrDataURL });
        }
        console.log(`[WA] QR generated for user: ${userId}`);
      } catch (err) {
        console.error(`[WA] QR generation error:`, err);
        if (res && !res.headersSent) {
          res.status(500).json({ error: 'Failed to generate QR code' });
        }
      }
    }

    if (connection === 'open') {
      delete pendingQRs[userId];
      reconnectAttempts[userId] = 0;
      console.log(`[WA] ✅ User ${userId} connected.`);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      delete pendingQRs[userId];

      if (shouldReconnect) {
        const attempts = (reconnectAttempts[userId] || 0) + 1;
        reconnectAttempts[userId] = attempts;
        const delay = Math.min(60000, 5000 + attempts * 3000);
        console.log(`[WA] 🔄 Reconnecting for user ${userId} (attempt ${attempts}) in ${delay/1000}s...`);
        setTimeout(() => {
          connectToWhatsApp(userId).catch(err => {
            console.error(`[WA] Reconnection failed for ${userId}:`, err);
          });
        }, delay);
      } else {
        delete activeSockets[userId];
        delete reconnectAttempts[userId];
        console.log(`[WA] User ${userId} logged out permanently.`);
      }
    }
  });

  return sock;
}

// ===== API ENDPOINTS (unchanged) =====
app.get('/api/wa/qr', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (sanitizedUserId !== userId) {
    return res.status(400).json({ error: 'Invalid userId format' });
  }

  if (activeSockets[sanitizedUserId] && activeSockets[sanitizedUserId].user) {
    return res.json({ connected: true });
  }

  if (pendingQRs[sanitizedUserId]) {
    return res.json({ qr: pendingQRs[sanitizedUserId] });
  }

  try {
    await connectToWhatsApp(sanitizedUserId, res);
  } catch (err) {
    console.error('[API] QR error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate QR: ' + err.message });
    }
  }
});

app.get('/api/wa/status', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9\-_]/g, '');
  const isConnected = !!(activeSockets[sanitizedUserId] && activeSockets[sanitizedUserId].user);

  res.json({
    connected: isConnected,
    lastSeen: null
  });
});

app.post('/api/wa/disconnect', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (activeSockets[sanitizedUserId]) {
    try {
      activeSockets[sanitizedUserId].logout();
    } catch (err) {
      console.warn('[API] Logout error:', err);
    }
    delete activeSockets[sanitizedUserId];
    delete pendingQRs[sanitizedUserId];
    delete reconnectAttempts[sanitizedUserId];
    // Clean up keys and creds from MongoDB
    if (keysCollection) {
      keysCollection.deleteMany({ userId: sanitizedUserId }).catch(console.error);
    }
    if (sessionsCollection) {
      sessionsCollection.deleteOne({ userId: sanitizedUserId }).catch(console.error);
    }
  }

  res.json({ success: true });
});

app.post('/api/wa/action', async (req, res) => {
  const { userId, action, recipient, message } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9\-_]/g, '');
  const sock = activeSockets[sanitizedUserId];

  if (!sock || !sock.user) {
    return res.status(400).json({ 
      error: 'WhatsApp not connected. Please scan the QR code first.' 
    });
  }

  try {
    let result = { success: true };

    switch (action) {
      case 'send': {
        if (!recipient || !message) {
          return res.status(400).json({ error: 'Missing recipient or message' });
        }

        let formattedRecipient = recipient.replace(/[^0-9]/g, '');
        if (!formattedRecipient.startsWith('91') && formattedRecipient.length === 10) {
          formattedRecipient = '91' + formattedRecipient;
        }
        if (formattedRecipient.length < 10) {
          return res.status(400).json({ error: 'Invalid phone number' });
        }

        const jid = `${formattedRecipient}@s.whatsapp.net`;

        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 2000));
        await sock.sendPresenceUpdate('paused', jid);

        await sock.sendMessage(jid, { text: message });

        result = {
          success: true,
          action: 'send',
          recipient: formattedRecipient,
          message: message
        };
        break;
      }

      case 'summarize':
        result = {
          success: true,
          action: 'summarize',
          summary: 'Summarization feature is under development. Please check back soon!'
        };
        break;

      case 'unread':
        result = {
          success: true,
          action: 'unread',
          count: 0,
          preview: 'Unread count feature coming soon.'
        };
        break;

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }

    res.json(result);
  } catch (err) {
    console.error('[WA] Action error:', err);
    res.status(500).json({ 
      error: err.message || 'Failed to execute WhatsApp action' 
    });
  }
});

app.get('/api/health', (req, res) => {
  const activeCount = Object.keys(activeSockets).filter(
    id => activeSockets[id] && activeSockets[id].user
  ).length;

  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeSessions: activeCount,
    pendingQRCodes: Object.keys(pendingQRs).length,
    mongoConnected: !!(sessionsCollection)
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sneh WA-Gateway',
    version: '2.2.0',
    status: 'running',
    endpoints: {
      qr: 'GET /api/wa/qr?userId=xxx',
      status: 'GET /api/wa/status?userId=xxx',
      disconnect: 'POST /api/wa/disconnect',
      action: 'POST /api/wa/action',
      health: 'GET /api/health'
    }
  });
});

// ===== ERROR HANDLING =====
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ===== START SERVER =====
async function startServer() {
  if (MONGODB_URI) {
    await connectToDatabase();
  }

  app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🚀 Sneh WA-Gateway v2.2.0`);
    console.log(`📍 Running on port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📁 Session storage: ${MONGODB_URI ? 'MongoDB (with custom KeyStore)' : 'File (ephemeral)'}`);
    console.log(`🔗 CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`========================================`);
  });
}

startServer().catch(err => {
  console.error('[Server] Fatal error during startup:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM, shutting down gracefully...');
  Object.keys(activeSockets).forEach(userId => {
    try {
      activeSockets[userId].logout();
    } catch (e) {}
  });
  if (dbClient) {
    dbClient.close().catch(console.error);
  }
  process.exit(0);
});
