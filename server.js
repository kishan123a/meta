const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg'); // <-- NEW: Import PostgreSQL library

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- NEW: Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for services like Render
  }
});

// --- NEW: Function to initialize the database table ---
const initializeDatabase = async () => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      phone_number VARCHAR(20) NOT NULL,
      wamid VARCHAR(255) UNIQUE NOT NULL,
      direction VARCHAR(10) NOT NULL,
      content TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    );
  `;
  try {
    await pool.query(createTableQuery);
    console.log('✅ Database table is ready.');
  } catch (err) {
    console.error('❌ Error creating database table', err.stack);
  }
};

// --- Environment Variables ---
const { WHATSAPP_ACCESS_TOKEN, PHONE_NUMBER_ID, WABA_ID, API_VERSION } = process.env;
const META_API_URL = `https://graph.facebook.com/${API_VERSION}`;

// --- API Routes ---

app.get('/', (req, res) => {
  res.send('WhatsApp API Tester Backend is running!');
});

// --- UPDATED: Webhook to receive forwarded responses and SAVE TO DB ---
// Replace the existing '/api/forwarded-response' in your server.js

// This endpoint receives forwarded data and processes different message types
app.post('/api/forwarded-response', async (req, res) => {
  const data = req.body;
  console.log('Received Forwarded Data:', JSON.stringify(data, null, 2));
  
  try {
    const change = data.entry?.[0]?.changes?.[0]?.value;
    if (!change) return res.sendStatus(200);

    // Handle incoming messages of various types
    if (change.messages) {
      const msg = change.messages[0];
      let content = '[Unsupported Message Type]';
      const messageType = msg.type;

      switch (messageType) {
        case 'text':
          content = msg.text.body;
          break;
        case 'image':
          content = `📷 [Image] ${msg.image.caption || ''}`.trim();
          break;
        case 'audio':
          content = `🎵 [Audio Message]`;
          break;
        case 'video':
          content = `🎥 [Video] ${msg.video.caption || ''}`.trim();
          break;
        case 'document':
          content = `📄 [Document] ${msg.document.filename || 'File'}`;
          break;
        case 'sticker':
          content = `😀 [Sticker]`;
          break;
        case 'reaction':
          const reactedMessageId = msg.reaction.message_id;
          const emoji = msg.reaction.emoji || '👍';
          await pool.query(
            `UPDATE chat_messages SET status = $1 WHERE wamid = $2`,
            [`Reacted with ${emoji}`, reactedMessageId]
          );
          return res.sendStatus(200); // Stop here, no new message needed
      }

      await pool.query(
        'INSERT INTO chat_messages (phone_number, wamid, direction, content, status) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (wamid) DO NOTHING',
        [msg.from, msg.id, 'incoming', content, 'read']
      );
      console.log(`📥 ${messageType} message saved to DB`);
    }
    
    // Handle status updates
    else if (change.statuses) {
      const status_data = change.statuses[0];
      await pool.query(
        'UPDATE chat_messages SET status = $1 WHERE wamid = $2',
        [status_data.status, status_data.id]
      );
      console.log(`ℹ️ Message status updated to ${status_data.status}`);
    }
  } catch (error) {
    console.error('Error processing forwarded data:', error);
  }
  
  res.sendStatus(200);
});

// Send Message Endpoint (unchanged)
app.post('/api/send-message', async (req, res) => {
  const { to, type, messageBody, templateName, headerImageUrl } = req.body;
  if (!to || !type) return res.status(400).json({ error: 'Recipient and type are required.' });

  const url = `${META_API_URL}/${PHONE_NUMBER_ID}/messages`;
  const headers = { "Authorization": `Bearer ${META_ACCESS_TOKEN}`, "Content-Type": "application/json" };
  let payload = { "messaging_product": "whatsapp", "to": to, "type": type };
  let content_to_save = "";

  if (type === 'text') {
    payload.text = { "body": messageBody };
    content_to_save = messageBody;
  } else if (type === 'template') {
    payload.template = { "name": templateName, "language": { "code": "en_US" } };
    content_to_save = `Sent template: ${templateName}`;
    if (headerImageUrl) {
      payload.template.components = [{"type": "header", "parameters": [{"type": "image", "image": {"link": headerImageUrl}}]}];
    }
  }

  try {
    const response = await axios.post(url, payload, { headers });
    const responseData = response.data;
    if (response.status === 200 && responseData.messages?.[0]?.id) {
      await pool.query(
        'INSERT INTO chat_messages (phone_number, wamid, direction, content, status) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (wamid) DO NOTHING',
        [to, responseData.messages[0].id, 'outgoing', content_to_save, 'sent']
      );
      console.log('📤 Outgoing message saved to DB');
    }
    res.status(200).json(responseData);
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
    res.status(500).json(error.response?.data || { error: 'Failed to send message' });
  }
});
// --- NEW: Endpoint to fetch chat history from the database ---
app.get('/api/history/:phoneNumber', async (req, res) => {
  const { phoneNumber } = req.params;
  try {
    const query = `
        SELECT phone_number, direction, content, timestamp 
        FROM chat_messages 
        WHERE phone_number = $1 
        ORDER BY timestamp ASC;
    `;
    const { rows } = await pool.query(query, [phoneNumber]);
    res.status(200).json(rows);
  } catch (dbError) {
    console.error('Error fetching chat history:', dbError);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// // --- UPDATED: Send a message and SAVE TO DB ---
// app.post('/send-message', async (req, res) => {
//     const { to, type, messageBody, templateName, languageCode = 'en', headerImageUrl } = req.body;

//     if (!to || !type) {
//         return res.status(400).json({ error: 'Recipient phone number (to) and message type are required.' });
//     }

//     let payload = { messaging_product: 'whatsapp', to, type };
//     let contentForDb = '';

//     if (type === 'template') {
//         if (!templateName) return res.status(400).json({ error: 'templateName is required' });
//         payload.template = { name: templateName, language: { code: languageCode } };
//         if (headerImageUrl) {
//             payload.template.components = [{"type": "header", "parameters": [{"type": "image", "image": {"link": headerImageUrl}}]}];
//         }
//         contentForDb = `Template: ${templateName}`;
//     } else if (type === 'text') {
//         if (!messageBody) return res.status(400).json({ error: 'messageBody is required' });
//         payload.text = { body: messageBody };
//         contentForDb = messageBody;
//     } else {
//         return res.status(400).json({ error: 'Invalid message type' });
//     }

//     try {
//         const response = await axios.post(`${META_API_URL}/${PHONE_NUMBER_ID}/messages`, payload, {
//             headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
//         });

//         // Save the outgoing message to the database
//         const wamid = response.data.messages[0].id;
//         const insertQuery = `
//             INSERT INTO chat_messages (phone_number, wamid, direction, content, timestamp)
//             VALUES ($1, $2, 'outgoing', $3, NOW())
//             ON CONFLICT (wamid) DO NOTHING;
//         `;
//         await pool.query(insertQuery, [to, wamid, contentForDb]);
//         console.log(`Saved outgoing message to ${to} in DB.`);
        
//         res.status(200).json(response.data);
//     } catch (error) {
//         console.error('Error sending message:', error.response ? error.response.data : error.message);
//         res.status(500).json(error.response ? error.response.data : { message: error.message });
//     }
// });


// --- Your other endpoints remain the same ---

app.get('/chat/api_get_templates/', async (req, res) => {
  // This endpoint remains the same...
  try {
    const response = await axios.get(`${META_API_URL}/${WABA_ID}/message_templates`, {
        headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
    });
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json(error.response ? error.response.data : { message: error.message });
  }
});

app.post('/chat/api_create_template/', async (req, res) => {
  // This endpoint remains the same...
  const { name, category, bodyText, language = 'en_US' } = req.body;
  if (!name || !category || !bodyText) {
    return res.status(400).json({ error: 'Template name, category, and bodyText are required.' });
  }
  const templateData = { name, language, category, components: [{ type: 'BODY', text: bodyText }] };
  try {
    const response = await axios.post(`${META_API_URL}/${WABA_ID}/message_templates`, templateData, {
        headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
    });
    res.status(200).json(response.data);
  } catch (error) {
    res.status(500).json(error.response ? error.response.data : { message: error.message });
  }
});


// --- Start Server ---
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  initializeDatabase(); // Initialize DB when server starts
});