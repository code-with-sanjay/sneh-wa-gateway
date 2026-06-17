// ============================================================
//  Sneh WA-Gateway – Production Server (Fixed)
//  Removed makeInMemoryStore – works with latest Baileys
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
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 5000;
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080,https://snehai.netlify.app').split(',');

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

// ===== SESSION MANAGEMENT =====
const activeSockets = {};
const pendingQRs = {};
const sessionStatus = {};

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ===== CONNECTION FUNCTION =====
async function connectToWhatsApp(userId, res = null) {
  const userSessionDir = path.join(SESSION_DIR, userId);
  if (!fs.existsSync(userSessionDir)) {
    fs.mkdirSync(userSessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(userSessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    browser: ['Sneh AI Gateway', 'Chrome', '120.0.0.0'],
    version: [2, 3000, 1015901307],
  });

  activeSockets[userId] = sock;
  sessionStatus[userId] = { connected: false, lastSeen: Date.now() };

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
      sessionStatus[userId].connected = true;
      sessionStatus[userId].lastSeen = Date.now();
      console.log(`[WA] ✅ User ${userId} connected.`);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      delete pendingQRs[userId];
      sessionStatus[userId].connected = false;

      if (shouldReconnect) {
        console.log(`[WA] 🔄 Reconnecting for user: ${userId}...`);
        const delay = 5000 + Math.random() * 10000;
        setTimeout(() => {
          connectToWhatsApp(userId).catch(err => {
            console.error(`[WA] Reconnection failed:`, err);
          });
        }, delay);
      } else {
        delete activeSockets[userId];
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
  const status = sessionStatus[sanitizedUserId] || { connected: false };

  res.json({
    connected: isConnected,
    lastSeen: status.lastSeen || null
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
    sessionStatus[sanitizedUserId] = { connected: false, lastSeen: Date.now() };
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

      case 'summarize': {
        // Placeholder – you can implement using sock.loadMessages with a known chat
        // For now, return a friendly message.
        result = {
          success: true,
          action: 'summarize',
          summary: 'Summarization feature is under development. Please check back soon!'
        };
        break;
      }

      case 'unread': {
        // Placeholder – you can implement by reading unread counts from socket
        result = {
          success: true,
          action: 'unread',
          count: 0,
          preview: 'Unread count feature coming soon.'
        };
        break;
      }

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
    pendingQRCodes: Object.keys(pendingQRs).length
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Sneh WA-Gateway',
    version: '2.0.1',
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
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`🚀 Sneh WA-Gateway v2.0.1`);
  console.log(`📍 Running on port: ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📁 Session directory: ${SESSION_DIR}`);
  console.log(`🔗 CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`========================================`);
});

process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM, shutting down gracefully...');
  Object.keys(activeSockets).forEach(userId => {
    try {
      activeSockets[userId].logout();
    } catch (e) {}
  });
  process.exit(0);
});
