const readline = require('readline');
const axios = require('axios');

const BASE_URL = process.env.API_URL || 'http://127.0.0.1:4001';
const TOKEN = process.argv[2] || '6scRBmNLwl/ANFhvqht9uWH5G3EmT6gXau4KnnnWL2f04j0DBpcXkq6Y8TLBnGxD';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You> '
});

console.log('=== DeepSeek to OpenAI API Test CLI ===');
console.log(`API: ${BASE_URL}`);
console.log('Commands:');
console.log('  /stream   - Toggle stream mode (current: OFF)');
console.log('  /new      - Start new conversation');
console.log('  /models   - List available models');
console.log('  /health   - Check server health');
console.log('  /quit     - Exit');
console.log('======================================');

let streamMode = false;
let conversationId = null;
let messageHistory = [];

async function chat(userInput) {
  messageHistory.push({ role: 'user', content: userInput });

  const payload = {
    model: 'deepseek-chat',
    messages: messageHistory,
    stream: streamMode
  };

  if (conversationId) {
    payload.conversation_id = conversationId;
  }

  if (streamMode) {
    try {
      const response = await axios({
        method: 'post',
        url: `${BASE_URL}/v1/chat/completions`,
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json'
        },
        data: payload,
        responseType: 'stream'
      });

      return new Promise((resolve) => {
        process.stdout.write('DeepSeek> ');
        let buffer = '';
        let fullReply = '';
        let newConvId = null;

        response.data.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const d = JSON.parse(line.slice(6));
                if (d.id && !newConvId) {
                  newConvId = d.id;
                }
                if (d.choices && d.choices[0].delta && d.choices[0].delta.content) {
                  const content = d.choices[0].delta.content;
                  fullReply += content;
                  process.stdout.write(content);
                }
              } catch(e) {}
            }
          }
        });

        response.data.on('end', () => {
          console.log('');
          if (newConvId) conversationId = newConvId;
          if (fullReply) messageHistory.push({ role: 'assistant', content: fullReply });
          resolve();
        });

        response.data.on('error', (e) => {
          console.error('\nError:', e.message);
          resolve();
        });
      });
    } catch(e) {
      const msg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
      console.error('Error:', msg || 'Unknown error');
      if (e.code === 'ECONNREFUSED') {
        console.error('Server is not running. Start it with: npm start');
      }
    }
  } else {
    try {
      const response = await axios.post(
        `${BASE_URL}/v1/chat/completions`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 120000
        }
      );

      if (response.data.error) {
        console.error('Error:', response.data.error.message);
      } else {
        const reply = response.data.choices[0].message.content;
        conversationId = response.data.id;
        messageHistory.push({ role: 'assistant', content: reply });
        console.log('DeepSeek> ' + reply);
        console.log(`  [id: ${response.data.id}, tokens: ${response.data.usage.total_tokens}]`);
      }
    } catch(e) {
      const msg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
      console.error('Error:', msg || 'Unknown error');
      if (e.code === 'ECONNREFUSED') {
        console.error('Server is not running. Start it with: npm start');
      }
    }
  }
}

async function checkHealth() {
  try {
    const r = await axios.get(`${BASE_URL}/health`);
    console.log('Health:', JSON.stringify(r.data));
  } catch(e) {
    console.error('Health check failed:', e.message);
  }
}

async function listModels() {
  try {
    const r = await axios.get(`${BASE_URL}/v1/models`);
    console.log('Models:');
    r.data.data.forEach(m => console.log(`  - ${m.id} (${m.owned_by})`));
  } catch(e) {
    console.error('Failed to list models:', e.message);
  }
}

async function checkServerHealth() {
  try {
    await axios.get(`${BASE_URL}/health`, { timeout: 5000 });
    return true;
  } catch(e) {
    return false;
  }
}

(async () => {
  const isRunning = await checkServerHealth();
  if (!isRunning) {
    console.log('WARNING: Server is not running on ' + BASE_URL);
    console.log('Start it with: npm start');
    console.log('');
  }
  rl.prompt();
})();

rl.on('line', async (line) => {
  const input = line.trim();

  if (input === '/quit') {
    rl.close();
    return;
  }

  if (input === '/stream') {
    streamMode = !streamMode;
    console.log(`Stream mode: ${streamMode ? 'ON' : 'OFF'}`);
    rl.prompt();
    return;
  }

  if (input === '/new') {
    conversationId = null;
    messageHistory = [];
    console.log('New conversation started.');
    rl.prompt();
    return;
  }

  if (input === '/models') {
    await listModels();
    rl.prompt();
    return;
  }

  if (input === '/health') {
    await checkHealth();
    rl.prompt();
    return;
  }

  if (input) {
    await chat(input);
  }

  rl.prompt();
}).on('close', () => {
  console.log('Bye!');
  process.exit(0);
});
