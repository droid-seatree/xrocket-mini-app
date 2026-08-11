const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing and serve public folder
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Verify Shared Access Key
app.post('/api/auth', (req, res) => {
  const { accessKey } = req.body;
  if (!accessKey || accessKey !== process.env.ACCESS_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized Access Key' });
  }
  return res.json({ success: true, message: 'Terminal Unlocked' });
});

// Initialize Telebob Bot
const initBot = require('./bot');
initBot();

// Railway Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'Telebob Bot Engine' });
});

// Fallback Route for Web App UI
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Explicit host binding to 0.0.0.0 required by Railway
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
