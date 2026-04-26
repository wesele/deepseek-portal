const express = require('express');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const DeepSeekClient = require('./deepseek-client');
const { createCompletion, createCompletionStream } = require('./openai-adapter');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Default page
app.get('/', (req, res) => {
  res.json({
    service: 'DeepSeek to OpenAI API',
    status: 'running',
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/models',
      health: '/health'
    },
    usage: {
      headers: {
        'Authorization': 'Bearer YOUR_DEEPSEEK_TOKEN',
        'Content-Type': 'application/json'
      },
      example: {
        model: 'default',
        messages: [{ role: 'user', content: 'Hello!' }],
        stream: false
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Models endpoint
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'default', object: 'model', owned_by: 'deepseek' },
      { id: 'default_think', object: 'model', owned_by: 'deepseek' },
      { id: 'expert', object: 'model', owned_by: 'deepseek' },
      { id: 'expert_think', object: 'model', owned_by: 'deepseek' },
      { id: 'default_search', object: 'model', owned_by: 'deepseek' }
    ]
  });
});

const DBG = process.env.DEBUG === '1';
const reqCounter = { n: 0 };

function dbg(...args) {
  if (DBG) console.log('[DBG]', ...args);
}

function dbgSection(title) {
  if (DBG) console.log(`\n${'─'.repeat(60)}\n[DBG] ${title}\n${'─'.repeat(60)}`);
}

// Chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  const reqId = ++reqCounter.n;
  try {
    const authHeader = req.headers.authorization;
    let token;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (process.env.DEEPSEEK_TOKEN) {
      token = process.env.DEEPSEEK_TOKEN;
    } else {
      return res.status(401).json({ error: 'Missing or invalid Authorization header, and no default token configured' });
    }

    const body = req.body;

    if (!body.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({ error: 'messages must be an array' });
    }

    const model = body.model || 'default';
    const stream = body.stream || false;
    const conversationId = body.conversation_id;
    const tools = body.tools;
    const toolChoice = body.tool_choice;

    if (DBG) {
      dbgSection(`REQUEST #${reqId}  model=${model}  stream=${stream}`);
      dbg(`tool_choice=${JSON.stringify(toolChoice)}  tools=${tools?.length ?? 0}`);
      body.messages.forEach((m, i) => {
        const preview = Array.isArray(m.content)
          ? '[array content]'
          : String(m.content ?? '').slice(0, 120).replace(/\n/g, '↵');
        const tc = m.tool_calls ? `  tool_calls(${m.tool_calls.length})` : '';
        const tid = m.tool_call_id ? `  tool_call_id=${m.tool_call_id}` : '';
        dbg(`  msg[${i}] role=${m.role}${tc}${tid}: ${preview}`);
      });
    }

    const client = new DeepSeekClient(token);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const stream = await client.createCompletionStream(model, body.messages, conversationId, tools, toolChoice);
      
      stream.on('data', (chunk) => {
        res.write(chunk);
      });

      stream.on('end', () => {
        res.end();
      });

      stream.on('error', (err) => {
        console.error('Stream error:', err);
        if (!res.writableEnded) {
          const errData = JSON.stringify({ error: { message: err.message, type: 'stream_error' } });
          res.write(`data: ${errData}\n\n`);
          res.end();
        }
      });
    } else {
      const result = await client.createCompletion(model, body.messages, conversationId, tools, toolChoice);
      res.json(result);
    }
  } catch (error) {
    console.error('Error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'api_error'
        }
      });
    }
  }
});

// Start server
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`DeepSeek to OpenAI API server running on http://${HOST}:${PORT}`);
    console.log(`Endpoints:`);
    console.log(`  POST /v1/chat/completions`);
    console.log(`  GET  /v1/models`);
    console.log(`  GET  /health`);
  });
}

module.exports = app;
