// ============================================================
//  Sneh WA-Gateway – Production Server (MongoDB Sessions)
//  Fixed: no duplicate variable declarations
// ============================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { 
  makeWASocket, 
  useMongoAuthState,
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
    await sessionsCollection.createIndex({ userId: 1 }, { unique: true });
    console.log('[DB] Connected to MongoDB.');
    return sessionsCollection;
  } catch (err) {
    console.error('[DB] Failed to connect to MongoDB:', err);
    return null;
  }
}

// ===== SESSION MANAGEMENT =====
const activeSockets = {};
const pendingQRs = {};
const reconnectAttempts = {};

// ===== CONNECTION FUNCTION =====
async function connectToWhatsApp(userId, res = null) {
  // Ensure database is connected (if URI provided)
  let collection = sessionsCollection;
  if (MONGODB_URI && !collection) {
    collection = await connectToDatabase();
  }

  let authState;
  if (collection) {
    // Use MongoDB – sessions persist across restarts
    const { state, saveCreds } = await useMongoAuthState(collection, userId);
    authState = { state, saveCreds };
  } else {
    // Fallback to file-based (ephemeral) – sessions lost on restart
    const userSessionDir = path.join(SESSION_DIR, userId);
    if (!fs.existsSync(userSessionDir)) {
      fs.mkdirSync(userSessionDir, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);
    authState = { state, saveCreds };
  }

  const { state, saveCreds } = authState;  // ← single declaration

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

  sock.ev.on('creds.update', async () => {
    if (collection) {
      // MongoDB saves automatically via useMongoAuthState
    } else {
      await saveCreds();
    }
  });

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

// ===== API ENDPOINTS =====

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
    version: '2.1.1',
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
    console.log(`🚀 Sneh WA-Gateway v2.1.1`);
    console.log(`📍 Running on port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📁 Session storage: ${MONGODB_URI ? 'MongoDB' : 'File (ephemeral)'}`);
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
