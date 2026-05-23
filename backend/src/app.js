require('dotenv').config();
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');
const routes  = require('./routes/index');

const app = express();

// ── Security & logging ────────────────────────────────────────────────────────
app.use(helmet());

// Accept either CORS_ORIGIN or legacy CORS_ORIGINS. Entries without a scheme
// (e.g. "myhost.onrender.com" or "myhost:443") are normalized to https://myhost.
const corsRaw = process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || 'http://localhost:3000';
const allowedOrigins = corsRaw
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    if (/^https?:\/\//i.test(s)) return s;
    const hostOnly = s.replace(/:(80|443)$/, '');
    return `https://${hostOnly}`;
  });

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Route ${req.path} not found.` }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error.' });
});

module.exports = app;
