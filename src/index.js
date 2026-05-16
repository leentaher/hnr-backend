require('dotenv').config();
const express = require('express');
const path = require('path');

const registerRouter = require('./routes/register');
const ordersRouter = require('./routes/orders');

const app = express();
app.use(express.json());

// Serve /.well-known/ static files
app.use('/.well-known', express.static(path.join(__dirname, '..', 'public', '.well-known')));

// OpenAPI spec (GPT action auto-config)
app.get('/.well-known/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'openapi.json'));
});

// Routes
app.use('/register', registerRouter);
app.use('/orders', ordersRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Human Not Required API running on port ${PORT}`));
