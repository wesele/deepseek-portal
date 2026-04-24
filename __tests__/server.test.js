const request = require('supertest');
const nock = require('nock');
const app = require('../src/index');
const DeepSeekClient = require('../src/deepseek-client');

const BASE_URL = 'https://chat.deepseek.com';

// Save original env var
const ORIGINAL_DEEPSEEK_TOKEN = process.env.DEEPSEEK_TOKEN;

// Mock DeepSeekHash for all tests
beforeEach(() => {
  nock.cleanAll();
  // Clear DEEPSEEK_TOKEN so auth validation tests work consistently
  delete process.env.DEEPSEEK_TOKEN;
  // Mock the initDeepSeekHash method
  jest.spyOn(DeepSeekClient.prototype, 'initDeepSeekHash').mockImplementation(async function() {
    this.deepSeekHash = {
      calculateHash: jest.fn().mockReturnValue(12345)
    };
    this.deepSeekHashInitPromise = Promise.resolve(this.deepSeekHash);
    return this.deepSeekHash;
  });
});

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
  // Restore original token
  if (ORIGINAL_DEEPSEEK_TOKEN !== undefined) {
    process.env.DEEPSEEK_TOKEN = ORIGINAL_DEEPSEEK_TOKEN;
  }
});

describe('Server Health Check', () => {
  test('should respond with status ok', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.timestamp).toBeDefined();
  });
});

describe('Server Models Endpoint', () => {
  test('should return model list', async () => {
    const response = await request(app).get('/v1/models');
    expect(response.status).toBe(200);
    expect(response.body.object).toBe('list');
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data[0]).toHaveProperty('id');
    expect(response.body.data[0]).toHaveProperty('owned_by');
  });

  test('should include default model', async () => {
    const response = await request(app).get('/v1/models');
    const modelIds = response.body.data.map(m => m.id);
    expect(modelIds).toContain('default');
  });

  test('should include all expected models', async () => {
    const response = await request(app).get('/v1/models');
    const modelIds = response.body.data.map(m => m.id);
    expect(modelIds).toContain('default');
    expect(modelIds).toContain('default_think');
    expect(modelIds).toContain('expert');
    expect(modelIds).toContain('expert_think');
    expect(modelIds).toContain('default_search');
  });
});

describe('Server Root Endpoint', () => {
  test('should return service info', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.body.service).toBe('DeepSeek to OpenAI API');
    expect(response.body.status).toBe('running');
    expect(response.body.endpoints).toBeDefined();
  });

  test('should return correct endpoints', async () => {
    const response = await request(app).get('/');
    expect(response.body.endpoints.chat).toBe('/v1/chat/completions');
    expect(response.body.endpoints.models).toBe('/v1/models');
    expect(response.body.endpoints.health).toBe('/health');
  });

  test('should return usage information', async () => {
    const response = await request(app).get('/');
    expect(response.body.usage).toBeDefined();
    expect(response.body.usage.headers).toBeDefined();
    expect(response.body.usage.example).toBeDefined();
  });
});

describe('Server Chat Completions (Validation)', () => {
  test('should return 401 without auth', async () => {
    const response = await request(app)
      .post('/v1/chat/completions')
      .send({ messages: [{ role: 'user', content: 'test' }] });
    expect(response.status).toBe(401);
  });

  test('should return 400 without messages', async () => {
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-token')
      .send({});
    expect(response.status).toBe(400);
  });

  test('should return 400 with invalid messages format', async () => {
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-token')
      .send({ messages: 'invalid' });
    expect(response.status).toBe(400);
  });

  test('should return 401 with invalid auth header format', async () => {
    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'InvalidFormat test-token')
      .send({ messages: [{ role: 'user', content: 'test' }] });
    expect(response.status).toBe(401);
  });
});

describe('Server Chat Completions (Functional)', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test('should handle successful non-stream completion', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-123' } }
    };

    const challengeResponse = {
      code: 0,
      msg: '',
      data: {
        biz_code: 0,
        biz_msg: '',
        biz_data: {
          challenge: {
            algorithm: 'DeepSeekHashV1',
            challenge: 'test-hash',
            salt: 'test-salt',
            difficulty: 1000,
            expire_at: Math.floor(Date.now() / 1000) + 3600,
            signature: 'test-sig'
          }
        }
      }
    };

    nock(BASE_URL)
      .get('/api/v0/users/current')
      .reply(200, tokenResponse);

    nock(BASE_URL)
      .post('/api/v0/chat_session/create')
      .reply(200, sessionResponse);

    nock(BASE_URL)
      .post('/api/v0/chat/create_pow_challenge')
      .reply(200, challengeResponse);

    const sseData = [
      'event: message',
      'data: {"response_message_id":"msg-1","p":"response","v":[{"p":"accumulated_token_usage","v":15}]}',
      '',
      'event: message',
      'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Hello"}]}]}',
      '',
      'event: close',
      'data: [DONE]',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-token')
      .send({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.object).toBe('chat.completion');
    expect(response.body.choices[0].message.content).toBe('Hello');
  });

  test('should handle successful stream completion', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-456' } }
    };

    const challengeResponse = {
      code: 0,
      msg: '',
      data: {
        biz_code: 0,
        biz_msg: '',
        biz_data: {
          challenge: {
            algorithm: 'DeepSeekHashV1',
            challenge: 'test-hash',
            salt: 'test-salt',
            difficulty: 1000,
            expire_at: Math.floor(Date.now() / 1000) + 3600,
            signature: 'test-sig'
          }
        }
      }
    };

    nock(BASE_URL)
      .get('/api/v0/users/current')
      .reply(200, tokenResponse);

    nock(BASE_URL)
      .post('/api/v0/chat_session/create')
      .reply(200, sessionResponse);

    nock(BASE_URL)
      .post('/api/v0/chat/create_pow_challenge')
      .reply(200, challengeResponse);

    const sseData = [
      'event: message',
      'data: {"response_message_id":"msg-2","p":"response","v":[{"p":"accumulated_token_usage","v":10}]}',
      '',
      'event: message',
      'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Stream"}]}]}',
      '',
      'event: close',
      'data: [DONE]',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-token')
      .send({ messages: [{ role: 'user', content: 'Hi' }], stream: true })
      .timeout(10000);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
  }, 15000);

  test('should handle API error in non-stream mode', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-error' } }
    };

    const challengeResponse = {
      code: 0,
      msg: '',
      data: {
        biz_code: 0,
        biz_msg: '',
        biz_data: {
          challenge: {
            algorithm: 'DeepSeekHashV1',
            challenge: 'test-hash',
            salt: 'test-salt',
            difficulty: 1000,
            expire_at: Math.floor(Date.now() / 1000) + 3600,
            signature: 'test-sig'
          }
        }
      }
    };

    nock(BASE_URL)
      .get('/api/v0/users/current')
      .reply(200, tokenResponse);

    nock(BASE_URL)
      .post('/api/v0/chat_session/create')
      .reply(200, sessionResponse);

    nock(BASE_URL)
      .post('/api/v0/chat/create_pow_challenge')
      .reply(200, challengeResponse);

    const sseData = [
      'event: hint',
      'data: {"type":"error","content":"Rate limit exceeded","clear_response":true,"finish_reason":"rate_limit_reached"}',
      '',
      'event: close',
      'data: {}',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const response = await request(app)
      .post('/v1/chat/completions')
      .set('Authorization', 'Bearer test-token')
      .send({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(response.status).toBe(500);
    expect(response.body.error).toBeDefined();
  });
});
