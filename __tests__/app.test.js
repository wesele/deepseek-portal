const nock = require('nock');
const DeepSeekClient = require('../src/deepseek-client');
const { createCompletionResponse, createCompletionStream } = require('../src/openai-adapter');

const TOKEN = 'test-token-123';
const BASE_URL = 'https://chat.deepseek.com';

describe('DeepSeekClient', () => {
  let client;

  beforeEach(() => {
    nock.cleanAll();
    client = new DeepSeekClient(TOKEN);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('generateCookie', () => {
    test('should generate a cookie string with required fields', () => {
      const cookie = client.generateCookie();
      expect(cookie).toContain('intercom-HWWAFSESTIME=');
      expect(cookie).toContain('HWWAFSESID=');
      expect(cookie).toContain('Hm_lvt_');
      expect(cookie).toContain('Hm_lpvt_');
      expect(cookie).toContain('_frid=');
      expect(cookie).toContain('_fr_ssid=');
      expect(cookie).toContain('_fr_pvid=');
    });

    test('should generate unique cookies each time', () => {
      const cookie1 = client.generateCookie();
      const cookie2 = client.generateCookie();
      expect(cookie1).not.toBe(cookie2);
    });
  });

  describe('requestToken', () => {
    test('should fetch and return token from users/current endpoint', async () => {
      const mockResponse = {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            id: 'user-123',
            token: 'new-access-token',
            email: 'test@test.com'
          }
        }
      };

      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, mockResponse);

      const result = await client.requestToken(TOKEN);

      expect(result.accessToken).toBe('new-access-token');
      expect(result.refreshToken).toBe('new-access-token');
      expect(result.refreshTime).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    test('should throw error when API returns non-zero code', async () => {
      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, { code: -1, msg: 'Authorization Failed' });

      await expect(client.requestToken(TOKEN)).rejects.toThrow('Token refresh failed: Authorization Failed');
    });

    test('should throw error when response is empty', async () => {
      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, null);

      await expect(client.requestToken(TOKEN)).rejects.toThrow('Token refresh failed: Unknown error');
    });
  });

  describe('acquireToken', () => {
    test('should cache token and reuse within expiry period', async () => {
      const mockResponse = {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: { token: 'cached-token' }
        }
      };

      const scope = nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, mockResponse);

      const token1 = await client.acquireToken();
      expect(token1).toBe('cached-token');

      const token2 = await client.acquireToken();
      expect(token2).toBe('cached-token');

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('createSession', () => {
    test('should create a chat session and return id', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: { token: 'access-token' }
        }
      };

      const sessionResponse = {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: { id: 'session-abc-123' }
        }
      };

      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, tokenResponse);

      nock(BASE_URL)
        .post('/api/v0/chat_session/create', { character_id: null })
        .reply(200, sessionResponse);

      const sessionId = await client.createSession();
      expect(sessionId).toBe('session-abc-123');
    });

    test('should throw error when session creation fails', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, tokenResponse);

      nock(BASE_URL)
        .post('/api/v0/chat_session/create')
        .reply(200, { code: -1, msg: 'Error' });

      await expect(client.createSession()).rejects.toThrow('Failed to create session');
    });
  });

  describe('prepareMessages', () => {
    test('should format single user message', () => {
      const messages = [{ role: 'user', content: 'Hello' }];
      const result = client.prepareMessages(messages);
      expect(result).toBe('Hello');
    });

    test('should format user and assistant conversation', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' }
      ];
      const result = client.prepareMessages(messages);
      expect(result).toBe('Hello<｜Assistant｜>Hi there!<｜end of sentence｜>');
    });

    test('should format multi-turn conversation', () => {
      const messages = [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' }
      ];
      const result = client.prepareMessages(messages);
      expect(result).toBe('Q1<｜Assistant｜>A1<｜end of sentence｜><｜User｜>Q2');
    });

    test('should handle system messages', () => {
      const messages = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' }
      ];
      const result = client.prepareMessages(messages);
      expect(result).toBe('You are helpful<｜User｜>Hello');
    });

    test('should merge consecutive messages with same role', () => {
      const messages = [
        { role: 'user', content: 'Part 1' },
        { role: 'user', content: 'Part 2' }
      ];
      const result = client.prepareMessages(messages);
      expect(result).toBe('Part 1\n\nPart 2');
    });

    test('should handle array content', () => {
      const messages = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image', url: 'http://img.com' }] }
      ];
      const result = client.prepareMessages(messages);
      expect(result).toBe('Hello');
    });

    test('should return empty string for empty messages', () => {
      const result = client.prepareMessages([]);
      expect(result).toBe('');
    });

    test('should remove markdown images', () => {
      const messages = [{ role: 'user', content: 'Text ![alt](http://img.png) more text' }];
      const result = client.prepareMessages(messages);
      expect(result).toBe('Text  more text');
    });
  });

  describe('parseModelOptions', () => {
    test('should return correct options for default', () => {
      expect(client.parseModelOptions('default')).toEqual({ modelType: 'default', thinkingEnabled: false, searchEnabled: false });
    });

    test('should return correct options for default_think', () => {
      expect(client.parseModelOptions('default_think')).toEqual({ modelType: 'default', thinkingEnabled: true, searchEnabled: false });
    });

    test('should return correct options for expert', () => {
      expect(client.parseModelOptions('expert')).toEqual({ modelType: 'expert', thinkingEnabled: false, searchEnabled: false });
    });

    test('should return correct options for expert_think', () => {
      expect(client.parseModelOptions('expert_think')).toEqual({ modelType: 'expert', thinkingEnabled: true, searchEnabled: false });
    });

    test('should return correct options for default_search', () => {
      expect(client.parseModelOptions('default_search')).toEqual({ modelType: 'default', thinkingEnabled: false, searchEnabled: true });
    });
  });

  describe('getChallengeResponse', () => {
    test('should return challenge from API', async () => {
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

      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, tokenResponse);

      nock(BASE_URL)
        .post('/api/v0/chat/create_pow_challenge')
        .reply(200, challengeResponse);

      const result = await client.getChallengeResponse('/api/v0/chat/completion');
      expect(result.algorithm).toBe('DeepSeekHashV1');
      expect(result.challenge).toBe('test-hash');
    });

    test('should throw error when challenge request fails', async () => {
      const tokenResponse = {
        code: 0,
        msg: '',
        data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
      };

      nock(BASE_URL)
        .get('/api/v0/users/current')
        .reply(200, tokenResponse);

      nock(BASE_URL)
        .post('/api/v0/chat/create_pow_challenge')
        .reply(200, { code: -1, msg: 'Error' });

      await expect(client.getChallengeResponse('/api/v0/chat/completion')).rejects.toThrow('Failed to get challenge');
    });
  });

  describe('answerChallenge', () => {
    test('should return base64 encoded solution', async () => {
      client.deepSeekHash = { calculateHash: jest.fn().mockReturnValue(12345) };
      client.deepSeekHashInitPromise = Promise.resolve(client.deepSeekHash);

      const challenge = {
        algorithm: 'DeepSeekHashV1',
        challenge: 'test-hash',
        salt: 'test-salt',
        difficulty: 1000,
        expire_at: 1234567890,
        signature: 'test-sig'
      };

      const result = await client.answerChallenge(challenge, '/api/v0/chat/completion');
      const decoded = JSON.parse(Buffer.from(result, 'base64').toString());

      expect(decoded.algorithm).toBe('DeepSeekHashV1');
      expect(decoded.answer).toBe(12345);
      expect(decoded.target_path).toBe('/api/v0/chat/completion');
    });

    test('should throw error when hash solving fails', async () => {
      client.deepSeekHash = { calculateHash: jest.fn().mockReturnValue(undefined) };
      client.deepSeekHashInitPromise = Promise.resolve(client.deepSeekHash);

      const challenge = {
        algorithm: 'DeepSeekHashV1',
        challenge: 'test-hash',
        salt: 'test-salt',
        difficulty: 1000,
        expire_at: 1234567890,
        signature: 'test-sig'
      };

      await expect(client.answerChallenge(challenge, '/api/v0/chat/completion')).rejects.toThrow('Failed to solve PoW challenge');
    });
  });
});

describe('OpenAI Adapter', () => {
  describe('createCompletionResponse', () => {
    test('should create valid OpenAI chat completion response', () => {
      const response = createCompletionResponse('deepseek-chat', [], {
        id: 'chatcmpl-123',
        model: 'deepseek-chat',
        content: 'Hello!',
        created: 1234567890
      });

      expect(response.id).toBe('chatcmpl-123');
      expect(response.object).toBe('chat.completion');
      expect(response.model).toBe('deepseek-chat');
      expect(response.choices[0].message.content).toBe('Hello!');
      expect(response.choices[0].message.role).toBe('assistant');
      expect(response.choices[0].finish_reason).toBe('stop');
      expect(response.usage).toEqual({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      expect(response.created).toBe(1234567890);
    });

    test('should handle custom usage data', () => {
      const response = createCompletionResponse('deepseek-chat', [], {
        id: 'test-id',
        content: 'Test',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      });

      expect(response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    });

    test('should handle custom choices array', () => {
      const customChoices = [
        { index: 0, message: { role: 'assistant', content: 'Choice 1' }, finish_reason: 'stop' },
        { index: 1, message: { role: 'assistant', content: 'Choice 2' }, finish_reason: 'length' }
      ];

      const response = createCompletionResponse('deepseek-chat', [], {
        id: 'test-id',
        content: 'Test',
        choices: customChoices
      });

      expect(response.choices).toHaveLength(2);
      expect(response.choices[1].finish_reason).toBe('length');
    });

    test('should generate id when not provided', () => {
      const response = createCompletionResponse('deepseek-chat', [], { content: 'Test' });
      expect(response.id).toMatch(/^chatcmpl-/);
    });

    test('should include reasoning_content when present', () => {
      const response = createCompletionResponse('deepseek-think', [], {
        id: 'test-id',
        content: 'Answer',
        reasoning_content: 'Thinking process...'
      });

      expect(response.choices[0].message.reasoning_content).toBe('Thinking process...');
    });
  });

  describe('createCompletionStream', () => {
    test('should return the stream as-is', () => {
      const mockStream = { on: jest.fn(), pipe: jest.fn() };
      const result = createCompletionStream('deepseek-chat', [], mockStream);
      expect(result).toBe(mockStream);
    });
  });
});

describe('Integration - Chat Completion Flow (Mocked)', () => {
  let client;

  beforeEach(() => {
    nock.cleanAll();
    client = new DeepSeekClient(TOKEN);
    client.deepSeekHash = { calculateHash: jest.fn().mockReturnValue(12345) };
    client.deepSeekHashInitPromise = Promise.resolve(client.deepSeekHash);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test('should complete a simple chat request', async () => {
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
            challenge: 'test-challenge-hash',
            salt: 'test-salt',
            difficulty: 1000,
            expire_at: Math.floor(Date.now() / 1000) + 3600,
            signature: 'test-signature'
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

    const result = await client.createCompletion('default', [{ role: 'user', content: 'Hi' }]);

    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('default');
    expect(result.choices[0].message.content).toBe('Hello');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.id).toContain('session-123');
  });

  test('should handle streaming response', async () => {
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
            challenge: 'test-challenge-hash',
            salt: 'test-salt',
            difficulty: 1000,
            expire_at: Math.floor(Date.now() / 1000) + 3600,
            signature: 'test-signature'
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
      'event: message',
      'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"ing"}]}]}',
      '',
      'event: close',
      'data: [DONE]',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const stream = await client.createCompletionStream('default', [{ role: 'user', content: 'Test' }]);

    return new Promise((resolve, reject) => {
      let chunks = '';
      stream.on('data', (chunk) => {
        chunks += chunk.toString();
      });
      stream.on('end', () => {
        expect(chunks).toContain('chat.completion.chunk');
        expect(chunks).toContain('[DONE]');
        resolve();
      });
      stream.on('error', reject);
    });
  });

  test('should reject with error when DeepSeek returns rate limit hint', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-789' } }
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
            challenge: 'test-challenge-hash',
            salt: 'test-salt',
            difficulty: 1000,
            expire_at: Math.floor(Date.now() / 1000) + 3600,
            signature: 'test-signature'
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
      'event: ready',
      'data: {"request_message_id":1,"response_message_id":2}',
      '',
      'event: hint',
      'data: {"type":"error","content":"Messages too frequent. Try again later.","clear_response":true,"finish_reason":"rate_limit_reached"}',
      '',
      'event: close',
      'data: {}',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    await expect(
      client.createCompletion('default', [{ role: 'user', content: 'Hi' }])
    ).rejects.toThrow('Messages too frequent. Try again later.');
  });

  test('should handle hint events in streaming mode', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-stream-hint' } }
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
      'event: ready',
      'data: {"request_message_id":1,"response_message_id":2}',
      '',
      'event: hint',
      'data: {"type":"error","content":"Rate limited","finish_reason":"rate_limit_reached"}',
      '',
      'event: close',
      'data: {}',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const stream = await client.createCompletionStream('default', [{ role: 'user', content: 'Test' }]);

    return new Promise((resolve, reject) => {
      let chunks = '';
      stream.on('data', (chunk) => {
        chunks += chunk.toString();
      });
      stream.on('end', () => {
        expect(chunks).toContain('rate_limit_reached');
        expect(chunks).toContain('Rate limited');
        expect(chunks).toContain('[DONE]');
        resolve();
      });
      stream.on('error', reject);
    });
  });

  test('should handle thinking model in streaming mode', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-think' } }
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
      'data: {"response_message_id":"msg-think","p":"response","v":[{"p":"accumulated_token_usage","v":20}]}',
      '',
      'event: message',
      'data: {"v":{"response":{"thinking_enabled":true}}}',
      '',
      'event: message',
      'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Thinking..."}]}]}',
      '',
      'event: message',
      'data: {"p":"response/fragments","v":[{"p":"text","v":[{"content":"Answer"}]}]}',
      '',
      'event: close',
      'data: [DONE]',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const stream = await client.createCompletionStream('default_think', [{ role: 'user', content: 'Test' }]);

    return new Promise((resolve, reject) => {
      let chunks = '';
      stream.on('data', (chunk) => {
        chunks += chunk.toString();
      });
      stream.on('end', () => {
        expect(chunks).toContain('chat.completion.chunk');
        expect(chunks).toContain('[DONE]');
        resolve();
      });
      stream.on('error', reject);
    });
  });

  test('should handle non-stream response with thinking content', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-think-nonstream' } }
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
      'data: {"response_message_id":"msg-think","p":"response","v":[{"p":"accumulated_token_usage","v":25}]}',
      '',
      'event: message',
      'data: {"v":{"response":{"thinking_enabled":true}}}',
      '',
      'event: message',
      'data: {"v":"Thinking process...FINISHED"}',
      '',
      'event: message',
      'data: {"v":{"response":{"thinking_enabled":false}}}',
      '',
      'event: message',
      'data: {"v":"Final answer"}',
      '',
      'event: close',
      'data: [DONE]',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const result = await client.createCompletion('default_think', [{ role: 'user', content: 'Test' }]);

    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Final answer');
    expect(result.choices[0].message.reasoning_content).toBe('Thinking process...');
  });

  test('should handle array chunk.v in non-stream response', async () => {
    const tokenResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { token: 'access-token' } }
    };

    const sessionResponse = {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { id: 'session-array' } }
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
      'data: {"response_message_id":"msg-array","p":"response","v":[{"p":"accumulated_token_usage","v":30}]}',
      '',
      'event: message',
      'data: {"v":[{"p":"text","v":[{"content":"Array content"}]}]}',
      '',
      'event: close',
      'data: [DONE]',
      ''
    ].join('\n');

    nock(BASE_URL)
      .post('/api/v0/chat/completion')
      .reply(200, sseData, { 'Content-Type': 'text/event-stream' });

    const result = await client.createCompletion('default', [{ role: 'user', content: 'Test' }]);

    expect(result.object).toBe('chat.completion');
    expect(result.choices[0].message.content).toBe('Array content');
  });
});

describe('DeepSeekClient - initDeepSeekHash', () => {
  let client;

  beforeEach(() => {
    nock.cleanAll();
    client = new DeepSeekClient(TOKEN);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  test('should return cached hash if already initialized', async () => {
    const mockHash = { calculateHash: jest.fn() };
    client.deepSeekHash = mockHash;

    const result = await client.initDeepSeekHash();
    expect(result).toBe(mockHash);
  });

  test('should return existing promise if initialization in progress', async () => {
    const mockHash = { calculateHash: jest.fn() };
    const mockPromise = Promise.resolve(mockHash);
    client.deepSeekHashInitPromise = mockPromise;

    const result = await client.initDeepSeekHash();
    expect(result).toBe(mockHash);
  });
});
