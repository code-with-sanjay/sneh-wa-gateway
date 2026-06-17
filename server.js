// ============================================================
//  Sneh WA-Gateway – Production Server
//  Multi-user WhatsApp integration using Baileys
//  Designed for Render.com / Fly.io / VPS
// ============================================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { 
  makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  makeInMemoryStore 
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 5000;
const SESSION_DIR = process.env.SESSION_DIR || './sessions';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080,https://your-domain.com').split(',');

// ===== SETUP =====
const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable if you need inline scripts
  crossOriginEmbedderPolicy: false
}));

// Compression
app.use(compression());

// CORS – allow your frontend(s)
app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON parsing with size limit
app.use(express.json({ limit: '10mb' }));

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ===== SESSION MANAGEMENT =====
const activeSockets = {};      // userId -> socket instance
const pendingQRs = {};         // userId -> QR dataURL
const sessionStatus = {};      // userId -> { connected, lastSeen }

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Memory store for chats (optional, but useful for summarization)
const store = makeInMemoryStore({});

// ===== CONNECTION FUNCTION =====
async function connectToWhatsApp(userId, res = null) {
  const userSessionDir = path.join(SESSION_DIR, userId);
  
  // Create user session directory if it doesn't exist
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
    // Browser and version info to avoid detection
    browser: ['Sneh AI Gateway', 'Chrome', '120.0.0.0'],
    version: [2, 3000, 1015901307],
  });

  // Bind store to socket events
  store.bind(sock.ev);

  activeSockets[userId] = sock;
  sessionStatus[userId] = { connected: false, lastSeen: Date.now() };

  // Save credentials when updated
  sock.ev.on('creds.update', saveCreds);

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Generate QR code if available
    if (qr) {
      try {
        const qrDataURL = await QRCode.toDataURL(qr);
        pendingQRs[userId] = qrDataURL;
        if (res && !res.headersSent) {
          res.json({ qr: qrDataURL });
        }
        console.log(`[WA] QR generated for user: ${userId}`);
      } catch (err) {
        console.error(`[WA] QR generation error for ${userId}:`, err);
        if (res && !res.headersSent) {
          res.status(500).json({ error: 'Failed to generate QR code' });
        }
      }
    }

    // Connection open – user is authenticated
    if (connection === 'open') {
      delete pendingQRs[userId];
      sessionStatus[userId].connected = true;
      sessionStatus[userId].lastSeen = Date.now();
      console.log(`[WA] ✅ User ${userId} connected successfully.`);
    }

    // Connection closed – handle reconnection
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      delete pendingQRs[userId];
      sessionStatus[userId].connected = false;

      if (shouldReconnect) {
        console.log(`[WA] 🔄 Reconnecting for user: ${userId}...`);
        // Exponential backoff for reconnection
        const delay = 5000 + Math.random() * 10000;
        setTimeout(() => {
          connectToWhatsApp(userId).catch(err => {
            console.error(`[WA] Reconnection failed for ${userId}:`, err);
          });
        }, delay);
      } else {
        // User logged out manually – clean up
        delete activeSockets[userId];
        // Optionally delete session folder
        // fs.rmSync(userSessionDir, { recursive: true, force: true });
        console.log(`[WA] User ${userId} logged out permanently.`);
      }
    }
  });

  // Handle incoming messages (for future summarization)
  sock.ev.on('messages.upsert', async (m) => {
    // Store messages for later summarization if needed
    // This is where you'd implement real-time summarization
  });

  return sock;
}

// ===== API ENDPOINTS =====

/**
 * GET /api/wa/qr
 * Get QR code for a user to connect WhatsApp
 */
app.get('/api/wa/qr', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId parameter' });
  }

  // Sanitize userId to prevent directory traversal
  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (sanitizedUserId !== userId) {
    return res.status(400).json({ error: 'Invalid userId format' });
  }

  // If already connected
  if (activeSockets[sanitizedUserId] && activeSockets[sanitizedUserId].user) {
    return res.json({ connected: true });
  }

  // If QR already pending, return it
  if (pendingQRs[sanitizedUserId]) {
    return res.json({ qr: pendingQRs[sanitizedUserId] });
  }

  // Start new connection
  try {
    await connectToWhatsApp(sanitizedUserId, res);
  } catch (err) {
    console.error('[API] QR generation error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate QR code: ' + err.message });
    }
  }
});

/**
 * GET /api/wa/status
 * Check connection status for a user
 */
app.get('/api/wa/status', (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9\-_]/g, '');
  const isConnected = !!(activeSockets[sanitizedUserId] && activeSockets[sanitizedUserId].user);
  const status = sessionStatus[sanitizedUserId] || { connected: false };

  res.json({
    connected: isConnected,
    lastSeen: status.lastSeen || null
  });
});

/**
 * POST /api/wa/disconnect
 * Disconnect a user's WhatsApp session
 */
app.post('/api/wa/disconnect', (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

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

/**
 * POST /api/wa/action
 * Execute WhatsApp actions (send, summarize, unread)
 */
app.post('/api/wa/action', async (req, res) => {
  const { userId, action, recipient, message } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

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
        // Validate recipient and message
        if (!recipient || !message) {
          return res.status(400).json({ 
            error: 'Missing recipient or message for send action' 
          });
        }

        // Clean and format recipient phone number
        let formattedRecipient = recipient.replace(/[^0-9]/g, '');
        if (!formattedRecipient.startsWith('91') && formattedRecipient.length === 10) {
          formattedRecipient = '91' + formattedRecipient; // India default
        } else if (formattedRecipient.length < 10) {
          return res.status(400).json({ 
            error: 'Invalid phone number. Please provide a valid number.' 
          });
        }

        const jid = `${formattedRecipient}@s.whatsapp.net`;

        // Simulate human typing behaviour
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 2000));
        await sock.sendPresenceUpdate('paused', jid);

        // Send the message
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
        // Get recent messages from the store
        const chats = store.chats?.all() || [];
        let recentMessages = [];
        
        for (const chat of chats.slice(0, 5)) {
          try {
            const msgs = await sock.loadMessages(chat.id, 10);
            const textMessages = msgs
              .filter(m => m.message?.conversation)
              .map(m => ({
                from: m.key.remoteJid,
                text: m.message.conversation,
                timestamp: m.messageTimestamp
              }));
            recentMessages.push(...textMessages);
          } catch (err) {
            console.warn('[WA] Could not load messages for chat:', err);
          }
        }

        // Sort by timestamp and get latest 20
        recentMessages.sort((a, b) => b.timestamp - a.timestamp);
        const latest = recentMessages.slice(0, 20);

        result = {
          success: true,
          action: 'summarize',
          count: latest.length,
          messages: latest
        };
        break;
      }

      case 'unread': {
        // Simplified – return count of unread
        const chatList = store.chats?.all() || [];
        const unreadCount = chatList.reduce((sum, chat) => sum + (chat.unreadCount || 0), 0);
        
        result = {
          success: true,
          action: 'unread',
          count: unreadCount,
          preview: unreadCount > 0 ? `You have ${unreadCount} unread messages.` : 'No unread messages.'
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

/**
 * GET /api/health
 * Health check endpoint for Render
 */
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

/**
 * GET / – Root
 */
app.get('/', (req, res) => {
  res.json({
    name: 'Sneh WA-Gateway',
    version: '2.0.0',
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
// Global error handler
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
  console.log(`🚀 Sneh WA-Gateway v2.0.0`);
  console.log(`📍 Running on port: ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📁 Session directory: ${SESSION_DIR}`);
  console.log(`🔗 CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`========================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⚠️ Received SIGTERM, shutting down gracefully...');
  // Close all active sockets
  Object.keys(activeSockets).forEach(userId => {
    try {
      activeSockets[userId].logout();
    } catch (e) {}
  });
  process.exit(0);
});
