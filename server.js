const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allows requests from your frontend
app.use(express.json()); // Parses incoming JSON requests
// Create a PostgreSQL connection pool using the DATABASE_URL from Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for services like Render
  }
});

// Function to create the database table on startup if it doesn't exist
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
// ---- Get environment variables ----
const { WHATSAPP_ACCESS_TOKEN, PHONE_NUMBER_ID, WABA_ID, API_VERSION } = process.env;
const META_API_URL = `https://graph.facebook.com/${API_VERSION}`;

// ---- API Health Check Endpoint ----
app.get('/', (req, res) => {
    res.send('WhatsApp API Tester Backend is running!');
});

// --- Add this to serve the React Frontend in production ---

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../frontend/build')));

// The "catchall" handler: for any request that doesn't match one above,
// send back React's index.html file.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build/index.html'));
});
// ---------------------------------------------------------

// --- At the top of your server.js, with your other variables ---
let messageInbox = []; // Our temporary storage for new messages

// --- This is your EXISTING endpoint, with one line added ---
app.post('/api/forwarded-response', (req, res) => {
    const forwardedData = req.body;
    console.log("✅ Received forwarded data from central router:");
    console.log(JSON.stringify(forwardedData, null, 2));

    // Add the new message to our inbox
    messageInbox.push(forwardedData); // <-- ADD THIS LINE

    res.status(200).send({ status: "success", message: "Data received" });
});

// --- ADD THIS ENTIRE NEW ENDPOINT ---
// This is the endpoint your frontend will call to get new messages
app.get('/api/get-messages', (req, res) => {
    // Send the current messages in the inbox to the frontend
    res.status(200).json(messageInbox);
    
    // Clear the inbox after the messages have been sent
    messageInbox = [];
});

// NEW endpoint to fetch chat history from the database
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
// ---- (UPDATED) Endpoint to SEND a message (TEXT or TEMPLATE) ----
app.post('/send-message', async (req, res) => {
    // Note the new 'headerImageUrl' field
    const { to, type, messageBody, templateName, languageCode = 'en', headerImageUrl } = req.body;

    if (!to || !type) {
        return res.status(400).json({ error: 'Recipient phone number (to) and message type are required.' });
    }

    let payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: type,
    };

    if (type === 'template') {
        if (!templateName) return res.status(400).json({ error: 'templateName is required for type "template".' });
        
        payload.template = {
            name: templateName,
            language: { code: languageCode }
        };

        // If a header image URL is provided, build the components object
        if (headerImageUrl) {
            payload.template.components = [
                {
                    "type": "header",
                    "parameters": [
                        {
                            "type": "image",
                            "image": {
                                "link": headerImageUrl
                            }
                        }
                    ]
                }
            ];
        }
    } else if (type === 'text') {
        if (!messageBody) return res.status(400).json({ error: 'messageBody is required for type "text".' });
        payload.text = { preview_url: false, body: messageBody };
    } else {
        return res.status(400).json({ error: 'Invalid message type. Must be "template" or "text".' });
    }

    try {
        const response = await axios.post(`${META_API_URL}/${PHONE_NUMBER_ID}/messages`, payload, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error sending message:', error.response ? error.response.data : error.message);
        res.status(500).json(error.response ? error.response.data : { message: error.message });
    }
});

// ---- (UPDATED) Endpoint to GET all message templates ----
app.get('/chat/api_get_templates/', async (req, res) => {
    try {
        const response = await axios.get(`${META_API_URL}/${WABA_ID}/message_templates`, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
        });
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error fetching templates:', error.response ? error.response.data : error.message);
        res.status(500).json(error.response ? error.response.data : { message: error.message });
    }
});

// ---- (UPDATED) Endpoint to CREATE a new template ----
app.post('/chat/api_create_template/', async (req, res) => {
    const { name, category, bodyText, language = 'en_US' } = req.body;

    if (!name || !category || !bodyText) {
        return res.status(400).json({ error: 'Template name, category, and bodyText are required.' });
    }

    const templateData = {
        name: name,
        language: language,
        category: category,
        components: [{ type: 'BODY', text: bodyText }]
    };

    try {
        const response = await axios.post(`${META_API_URL}/${WABA_ID}/message_templates`, templateData, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error creating template:', error.response ? error.response.data : error.message);
        res.status(500).json(error.response ? error.response.data : { message: error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`✅ Server is running on http://localhost:${PORT}`);
     initializeDatabase();
});