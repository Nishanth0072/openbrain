const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

// Initialize the Gemini AI SDK
// Make sure GEMINI_API_KEY is set in your .env file
const ai = new GoogleGenAI();

// Initialize the WhatsApp Client with Local Authentication to persist sessions
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        handleSIGINT: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// System Persona instructions for the AI
const SYSTEM_INSTRUCTION = `
You are OpenBrain AI, an ultra-smart, witty, and deeply helpful WhatsApp companion. 
- Keep responses relatively brief, snappy, and optimized for mobile viewing (use bullet points or line breaks for long explanations).
- Format text for WhatsApp markdown: *bold* for emphasis, _italics_ for nuance, ~strikethrough~, and \`\`\`code blocks\`\`\` for code snippets.
- Use emojis naturally but tastefully to keep the conversation lively.
- If you don't know something, be honest with a touch of humor instead of making things up.
`;

// Track simple in-memory session histories per user to give the bot context
const chatHistories = new Map();

/**
 * Generates an AI response using the modern @google/genai SDK
 */
async function getAIResponse(userId, userMessage) {
    try {
        // Initialize history for this user if it doesn't exist
        if (!chatHistories.has(userId)) {
            chatHistories.set(userId, []);
        }

        const history = chatHistories.get(userId);
        
        // Append user prompt
        history.push({ role: 'user', content: userMessage });
        
        // Keep history manageable (last 10 messages) to save tokens
        if (history.length > 10) history.shift();

        // Prepare the payload structured for the Gemini API
        // Mapping history to content segments
        const contents = history.map(msg => ({
            role: msg.role === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        }));

        // Call the Gemini 2.5 Flash model for fast, responsive generation
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: contents,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION,
                temperature: 0.7,
                maxOutputTokens: 800
            }
        });

        const replyText = response.text || "⚠️ Sorry, my gears jammed for a second. Could you repeat that?";
        
        // Append bot reply to history
        history.push({ role: 'model', content: replyText });
        
        return replyText;
    } catch (error) {
        console.error('Error generating content from Gemini API:', error);
        return "🧠 *OpenBrain Error:* I encountered a small headache while thinking about that. Please try again in a moment!";
    }
}

// --- WhatsApp Event Listeners ---

// Print the QR Code to terminal for scanning
client.on('qr', (qr) => {
    console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP TO LINK YOUR BOT:');
    qrcode.generate(qr, { small: true });
});

// Authenticated successfully
client.on('authenticated', () => {
    console.log('✨ WhatsApp session authenticated successfully!');
});

// Bot is fully loaded and ready
client.on('ready', () => {
    console.log('🚀 OpenBrain WhatsApp Bot is online and listening for messages!');
});

// Incoming message handler
client.on('message', async (message) => {
    // Ignore status updates, group chats (optional), or messages from other bots
    if (message.isStatus || message.from === 'status@broadcast') return;
    
    // Optional: Only reply to direct messages (uncomment to ignore groups)
    // if (message.from.includes('@g.us')) return;

    const userId = message.from;
    const incomingText = message.body ? message.body.trim() : '';

    if (!incomingText) return;

    console.log(`📥 Message from [${userId}]: ${incomingText}`);

    // Trigger a typing indicator to look organic
    const chat = await message.getChat();
    await chat.sendStateTyping();

    // Get response from AI
    const botReply = await getAIResponse(userId, incomingText);

    // Stop typing indicator and reply
    await chat.clearState();
    await message.reply(botReply);
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\nShutting down safely...');
    await client.destroy();
    process.exit(0);
});

// Launch the client
client.initialize();
