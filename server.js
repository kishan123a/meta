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
app.post('/api/forwarded-response', async (req, res) => {
    const forwardedData = req.body;
    console.log("✅ Received forwarded data from central router:");
    console.log(JSON.stringify(forwardedData, null, 2));

    try {
        if (forwardedData.object === 'whatsapp_business_account' && forwardedData.entry[0]?.changes[0]?.value?.messages) {
            const message = forwardedData.entry[0].changes[0].value.messages[0];
            const phoneNumber = message.from;
            const wamid = message.id;
            const content = message.text.body;
            const timestamp = new Date(parseInt(message.timestamp, 10) * 1000);

            const insertQuery = `
                INSERT INTO chat_messages (phone_number, wamid, direction, content, timestamp)
                VALUES ($1, $2, 'incoming', $3, $4)
                ON CONFLICT (wamid) DO NOTHING;
            `;
            await pool.query(insertQuery, [phoneNumber, wamid, content, timestamp]);
            console.log(`Saved incoming message from ${phoneNumber} to DB.`);
        }
    } catch (dbError) {
        console.error('Error saving incoming message to DB:', dbError);
    }

    res.status(200).send({ status: "success", message: "Data received" });
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

// --- UPDATED: Send a message and SAVE TO DB ---
app.post('/send-message', async (req, res) => {
    const { to, type, messageBody, templateName, languageCode = 'en', headerImageUrl } = req.body;

    if (!to || !type) {
        return res.status(400).json({ error: 'Recipient phone number (to) and message type are required.' });
    }

    let payload = { messaging_product: 'whatsapp', to, type };
    let contentForDb = '';

    if (type === 'template') {
        if (!templateName) return res.status(400).json({ error: 'templateName is required' });
        payload.template = { name: templateName, language: { code: languageCode } };
        if (headerImageUrl) {
            payload.template.components = [{"type": "header", "parameters": [{"type": "image", "image": {"link": headerImageUrl}}]}];
        }
        contentForDb = `Template: ${templateName}`;
    } else if (type === 'text') {
        if (!messageBody) return res.status(400).json({ error: 'messageBody is required' });
        payload.text = { body: messageBody };
        contentForDb = messageBody;
    } else {
        return res.status(400).json({ error: 'Invalid message type' });
    }

    try {
        const response = await axios.post(`${META_API_URL}/${PHONE_NUMBER_ID}/messages`, payload, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
        });

        // Save the outgoing message to the database
        const wamid = response.data.messages[0].id;
        const insertQuery = `
            INSERT INTO chat_messages (phone_number, wamid, direction, content, timestamp)
            VALUES ($1, $2, 'outgoing', $3, NOW())
            ON CONFLICT (wamid) DO NOTHING;
        `;
        await pool.query(insertQuery, [to, wamid, contentForDb]);
        console.log(`Saved outgoing message to ${to} in DB.`);
        
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error sending message:', error.response ? error.response.data : error.message);
        res.status(500).json(error.response ? error.response.data : { message: error.message });
    }
});


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