const request = require('supertest');
const nock = require('nock');
const app = require('../src/index');
const DeepSeekClient = require('../src/deepseek-client');

const BASE_URL = 'https://chat.deepseek.com';

// Mock DeepSeekHash for all tests
beforeEach(() => {
  nock.cleanAll();
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
});

describe('OpenAI API Compatibility Tests', () => {
  beforeEach(() => {
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Multi-turn Conversation', () => {
    test('should handle 2-turn conversation', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-multi-1' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-1","p":"response","v":[{"p":"accumulated_token_usage","v":20}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"I am doing well, thank you!"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [
            { role: 'user', content: 'Hello, how are you?' },
            { role: 'assistant', content: 'Hi! I am fine.' },
            { role: 'user', content: 'That is great!' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.object).toBe('chat.completion');
      expect(response.body.choices[0].message.content).toBe('I am doing well, thank you!');
    });

    test('should handle 3-turn conversation with system message', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-multi-2' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-2","p":"response","v":[{"p":"accumulated_token_usage","v":30}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"As a helpful assistant, I recommend reading documentation."}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What should I learn?' },
            { role: 'assistant', content: 'You could learn programming.' },
            { role: 'user', content: 'Which language?' },
            { role: 'assistant', content: 'Python is great for beginners.' },
            { role: 'user', content: 'Any resources?' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('As a helpful assistant, I recommend reading documentation.');
    });

    test('should handle conversation with conversation_id', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-3","p":"response","v":[{"p":"accumulated_token_usage","v":15}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Continuing our conversation."}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'Continue our chat' }],
          conversation_id: '550e8400-e29b-41d4-a716-446655440000@123'
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('Continuing our conversation.');
    });
  });

  describe('Model Variants', () => {
    test('should handle expert model', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-coder' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-coder","p":"response","v":[{"p":"accumulated_token_usage","v":25}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"function hello() { return \'Hello World\'; }"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'expert',
          messages: [{ role: 'user', content: 'Write a hello world function' }]
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('expert');
      expect(response.body.choices[0].message.content).toContain('function hello()');
    });

    test('should handle default_search model', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-search' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-search","p":"response","v":[{"p":"accumulated_token_usage","v":35}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Based on search results, the answer is 42."}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default_search',
          messages: [{ role: 'user', content: 'What is the answer to everything?' }]
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('default_search');
      expect(response.body.choices[0].message.content).toContain('search results');
    });

    test('should handle default_think model with thinking', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-r1' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-r1","p":"response","v":[{"p":"accumulated_token_usage","v":40}]}',
        '',
        'event: message',
        'data: {"v":{"response":{"thinking_enabled":true}}}',
        '',
        'event: message',
        'data: {"v":"Let me think about this...FINISHED"}',
        '',
        'event: message',
        'data: {"v":{"response":{"thinking_enabled":false}}}',
        '',
        'event: message',
        'data: {"v":"The answer is derived from deep reasoning."}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default_think',
          messages: [{ role: 'user', content: 'Solve this complex problem' }]
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('default_think');
      expect(response.body.choices[0].message.reasoning_content).toBe('Let me think about this...');
      expect(response.body.choices[0].message.content).toBe('The answer is derived from deep reasoning.');
    });
  });

  describe('Response Format Compliance', () => {
    test('should return OpenAI-compatible response structure', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-format' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-format","p":"response","v":[{"p":"accumulated_token_usage","v":12}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Test response"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('object', 'chat.completion');
      expect(response.body).toHaveProperty('model');
      expect(response.body).toHaveProperty('choices');
      expect(response.body).toHaveProperty('usage');
      expect(response.body).toHaveProperty('created');

      expect(response.body.choices).toHaveLength(1);
      expect(response.body.choices[0]).toHaveProperty('index', 0);
      expect(response.body.choices[0]).toHaveProperty('message');
      expect(response.body.choices[0]).toHaveProperty('finish_reason', 'stop');
      expect(response.body.choices[0].message).toHaveProperty('role', 'assistant');
      expect(response.body.choices[0].message).toHaveProperty('content');

      expect(response.body.usage).toHaveProperty('prompt_tokens');
      expect(response.body.usage).toHaveProperty('completion_tokens');
      expect(response.body.usage).toHaveProperty('total_tokens');
    });

    test('should handle default model when not specified', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-default' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-default","p":"response","v":[{"p":"accumulated_token_usage","v":8}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Default model response"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          messages: [{ role: 'user', content: 'Test without model' }]
        });

      expect(response.status).toBe(200);
      expect(response.body.model).toBe('default');
    });
  });

  describe('Streaming Response Format', () => {
    test('should return proper SSE format for streaming', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-sse' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-sse","p":"response","v":[{"p":"accumulated_token_usage","v":18}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Hello"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'Say hello' }],
          stream: true
        })
        .timeout(10000);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');
    }, 15000);
  });

  describe('Content Type Handling', () => {
    test('should handle array content with text type', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-array-content' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-array","p":"response","v":[{"p":"accumulated_token_usage","v":10}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Response to array content"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Hello' },
                { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
              ]
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('Response to array content');
    });
  });

  describe('Tool Calling', () => {
    test('should pass tools to the completion endpoint', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-tools' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-tool","p":"response","v":[{"p":"accumulated_token_usage","v":18}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"I will use a tool"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'What is the weather?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get current weather',
                parameters: { type: 'object', properties: { location: { type: 'string' } } }
              }
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('I will use a tool');
    });

    test('should handle tool_calls in response', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-tool-calls' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-tc","p":"response","v":[{"p":"accumulated_token_usage","v":20}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"<tool_calls>[{\\"id\\":\\"call_1\\",\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"get_weather\\",\\"arguments\\":\\"{\\\\\\"location\\\\\\":\\\\\\"Beijing\\\\\\"}\\"}}]</tool_calls>"}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'Weather in Beijing?' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get current weather',
                parameters: { type: 'object', properties: { location: { type: 'string' } } }
              }
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('');
      expect(response.body.choices[0].message.tool_calls).toBeDefined();
      expect(response.body.choices[0].message.tool_calls).toHaveLength(1);
      expect(response.body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
      expect(response.body.choices[0].finish_reason).toBe('tool_calls');
    });

    test('should handle tool role messages', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-tool-role' } }
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

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, sessionResponse);
      nock(BASE_URL).post('/api/v0/chat/create_pow_challenge').reply(200, challengeResponse);

      const sseData = [
        'event: message',
        'data: {"response_message_id":"msg-tr","p":"response","v":[{"p":"accumulated_token_usage","v":15}]}',
        '',
        'event: message',
        'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Thanks for the weather data."}]}]}',
        '',
        'event: close',
        'data: [DONE]',
        ''
      ].join('\n');

      nock(BASE_URL).post('/api/v0/chat/completion').reply(200, sseData, { 'Content-Type': 'text/event-stream' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [
            { role: 'user', content: 'What is the weather?' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Beijing"}' } }] },
            { role: 'tool', name: 'get_weather', content: '{"temperature":25,"unit":"C"}' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.choices[0].message.content).toBe('Thanks for the weather data.');
    });
  });

  describe('Error Handling', () => {
    test('should handle token refresh failure', async () => {
      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, { code: -1, msg: 'Invalid token' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer invalid-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });

    test('should handle session creation failure', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      nock(BASE_URL).get('/api/v0/users/current').reply(200, tokenResponse);
      nock(BASE_URL).post('/api/v0/chat_session/create').reply(200, { code: -1, msg: 'Session error' });

      const response = await request(app)
        .post('/v1/chat/completions')
        .set('Authorization', 'Bearer test-token')
        .send({
          model: 'default',
          messages: [{ role: 'user', content: 'Test' }]
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });
  });
});
