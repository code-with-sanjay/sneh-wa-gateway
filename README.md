# Sneh WA-Gateway

WhatsApp integration gateway for Sneh AI – multi-user, always-on.

## Quick Deploy to Render

1. Fork/clone this repo to GitHub
2. Go to render.com → New Web Service
3. Connect your repo
4. Use these settings:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Environment Variables:
     - `ALLOWED_ORIGINS`: your frontend URL(s)
5. Click Deploy

## Local Development

```bash
npm install
npm start
