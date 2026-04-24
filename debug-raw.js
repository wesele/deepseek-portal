const axios = require('axios');
const { createParser } = require('eventsource-parser');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const DeepSeekClient = require('./src/deepseek-client');
const DeepSeekHash = require('./src/challenge');
const path = require('path');

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'X-Client-Version': '1.8.0',
  'X-Client-Timezone-Offset': '7200'
};

function generateCookie() {
  const timestamp = Date.now();
  const randomHex = () => Math.random().toString(16).slice(2, 18);
  const randomUuid = () => uuidv4().replace(/-/g, '');
  return `intercom-HWWAFSESTIME=${timestamp}; HWWAFSESID=${randomHex()}; Hm_lvt_${randomUuid()}=${Math.floor(timestamp/1000)},${Math.floor(timestamp/1000)},${Math.floor(timestamp/1000)}; Hm_lpvt_${randomUuid()}=${Math.floor(timestamp/1000)}; _frid=${randomUuid()}; _fr_ssid=${randomUuid()}; _fr_pvid=${randomUuid()}`;
}

async function main() {
  const model = process.argv[2] || 'default';
  const prompt = process.argv[3] || 'Hello, how are you?';
  const token = process.env.DEEPSEEK_TOKEN;

  if (!token) {
    console.error('Error: DEEPSEEK_TOKEN not set in environment');
    process.exit(1);
  }

  console.log(`=== Debug Mode ===`);
  console.log(`Model: ${model}`);
  console.log(`Prompt: ${prompt}`);
  console.log('');

  const client = new DeepSeekClient(token);

  // 复用客户端的 token/session/challenge 逻辑
  const accessToken = await client.acquireToken();
  console.log('[1] Token acquired');

  const sessionId = await client.createSession();
  console.log('[2] Session created:', sessionId);

  const challenge = await client.getChallengeResponse('/api/v0/chat/completion');
  console.log('[3] Challenge acquired');

  // 初始化 hash 并计算 answer
  const hash = new DeepSeekHash();
  await hash.init(path.join(__dirname, 'sha3_wasm_bg.wasm'));
  const answer = hash.calculateHash(
    challenge.algorithm,
    challenge.challenge,
    challenge.salt,
    challenge.difficulty,
    challenge.expire_at
  );
  const powResponse = Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: '/api/v0/chat/completion'
  })).toString('base64');
  console.log('[4] PoW solved');

  const { modelType, thinkingEnabled, searchEnabled } = client.parseModelOptions(model);

  const payload = {
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: searchEnabled,
    preempt: false
  };

  console.log('[5] Request payload:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('');

  const response = await axios.post(
    'https://chat.deepseek.com/api/v0/chat/completion',
    payload,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...FAKE_HEADERS,
        Cookie: generateCookie(),
        'X-Ds-Pow-Response': powResponse
      },
      timeout: 120000,
      validateStatus: () => true,
      responseType: 'stream'
    }
  );

  console.log('[6] Response status:', response.status);
  console.log('[6] Response content-type:', response.headers['content-type']);
  console.log('');

  if (!response.headers['content-type']?.includes('text/event-stream')) {
    let body = '';
    response.data.on('data', chunk => body += chunk.toString());
    await new Promise(resolve => response.data.on('end', resolve));
    console.log('[ERROR] Non-SSE response body:');
    console.log(body.substring(0, 1000));
    return;
  }

  console.log('[7] Raw SSE events:');
  console.log('--------------------------------------------------');

  const parser = createParser((event) => {
    console.log(`\nEVENT: "${event.event || ''}"`);
    console.log(`DATA:  ${event.data}`);
  });

  response.data.on('data', (buffer) => {
    parser.feed(buffer.toString());
  });

  await new Promise((resolve, reject) => {
    response.data.on('end', () => {
      console.log('\n--------------------------------------------------');
      console.log('[8] HTTP stream ended');
      resolve();
    });
    response.data.on('error', (err) => {
      console.log('\n--------------------------------------------------');
      console.log('[8] HTTP stream error:', err.message);
      reject(err);
    });
    response.data.on('close', () => {
      console.log('\n--------------------------------------------------');
      console.log('[8] HTTP stream closed');
      resolve();
    });
  });
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
