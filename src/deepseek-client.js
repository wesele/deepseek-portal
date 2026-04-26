const axios = require('axios');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { createParser } = require('eventsource-parser');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const path = require('path');
const DeepSeekHash = require('./challenge');

// Allow disabling SSL verification for corporate MITM proxies
const httpsAgent = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

const WASM_PATH = path.join(__dirname, '..', 'sha3_wasm_bg.wasm');

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

const ACCESS_TOKEN_EXPIRES = 3600;
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;

class DeepSeekClient {
  constructor(token) {
    this.token = token;
    this.accessTokenMap = new Map();
    this.ipAddress = '';
    this.deepSeekHash = null;
    this.deepSeekHashInitPromise = null;
  }

  async initDeepSeekHash() {
    if (this.deepSeekHash) return this.deepSeekHash;
    if (this.deepSeekHashInitPromise) return this.deepSeekHashInitPromise;
    this.deepSeekHashInitPromise = (async () => {
      this.deepSeekHash = new DeepSeekHash();
      await this.deepSeekHash.init(WASM_PATH);
      return this.deepSeekHash;
    })();
    return this.deepSeekHashInitPromise;
  }

  generateCookie() {
    const timestamp = Date.now();
    const randomHex = () => Math.random().toString(16).slice(2, 18);
    const randomUuid = () => uuidv4().replace(/-/g, '');
    return `intercom-HWWAFSESTIME=${timestamp}; HWWAFSESID=${randomHex()}; Hm_lvt_${randomUuid()}=${Math.floor(timestamp/1000)},${Math.floor(timestamp/1000)},${Math.floor(timestamp/1000)}; Hm_lpvt_${randomUuid()}=${Math.floor(timestamp/1000)}; _frid=${randomUuid()}; _fr_ssid=${randomUuid()}; _fr_pvid=${randomUuid()}`;
  }

  async acquireToken() {
    const refreshToken = this.token;
    let result = this.accessTokenMap.get(refreshToken);
    
    if (!result || Math.floor(Date.now() / 1000) > result.refreshTime) {
      result = await this.requestToken(refreshToken);
      this.accessTokenMap.set(refreshToken, result);
    }
    
    return result.accessToken;
  }

  async requestToken(refreshToken) {
    const response = await axios.get('https://chat.deepseek.com/api/v0/users/current', {
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        ...FAKE_HEADERS
      },
      timeout: 15000,
      validateStatus: () => true,
      httpsAgent
    });

    if (!response.data || response.data.code !== 0) {
      throw new Error(`Token refresh failed: ${response.data?.msg || 'Unknown error'}`);
    }

    const token = response.data.data.biz_data.token;
    return {
      accessToken: token,
      refreshToken: token,
      refreshTime: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_EXPIRES
    };
  }

  async createSession() {
    const token = await this.acquireToken();
    const response = await axios.post(
      'https://chat.deepseek.com/api/v0/chat_session/create',
      { character_id: null },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS
        },
        timeout: 15000,
        validateStatus: () => true,
        httpsAgent
      }
    );

    if (!response.data || response.data.code !== 0 || !response.data.data?.biz_data) {
      throw new Error(`Failed to create session: ${JSON.stringify(response.data)}`);
    }

    const bizData = response.data.data.biz_data;
    const sessionId = bizData.id || bizData.session_id || bizData.chat_session_id || bizData.chat_session?.id;
    if (!sessionId) {
      throw new Error(`Session ID not found in response: ${JSON.stringify(bizData)}`);
    }
    return sessionId;
  }

  async getChallengeResponse(targetPath) {
    const token = await this.acquireToken();
    const response = await axios.post(
      'https://chat.deepseek.com/api/v0/chat/create_pow_challenge',
      { target_path: targetPath },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS
        },
        timeout: 15000,
        validateStatus: () => true,
        httpsAgent
      }
    );

    if (!response.data || response.data.code !== 0 || !response.data.data?.biz_data?.challenge) {
      throw new Error(`Failed to get challenge: ${response.data?.msg || 'Unknown error'}`);
    }

    return response.data.data.biz_data.challenge;
  }

  async answerChallenge(challenge, targetPath) {
    await this.initDeepSeekHash();
    const { algorithm, challenge: hashChallenge, salt, difficulty, expire_at, signature } = challenge;
    const answer = this.deepSeekHash.calculateHash(algorithm, hashChallenge, salt, difficulty, expire_at);
    if (answer === undefined) {
      throw new Error('Failed to solve PoW challenge');
    }
    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: hashChallenge,
      salt,
      answer,
      signature,
      target_path: targetPath
    })).toString('base64');
  }

  prepareMessages(messages, tools, toolChoice) {
    const processed = messages.map(msg => {
      if (msg.role === 'tool') {
        const toolCallId = msg.tool_call_id || '';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        // Structured format so the model clearly recognises tool results and continues the agentic loop
        return { role: 'user', text: `<tool_response>\n<tool_call_id>${toolCallId}</tool_call_id>\n<result>\n${content}\n</result>\n</tool_response>` };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        // Use the same <tool_call> format as the instruction so the model learns the pattern consistently
        const toolCallsText = msg.tool_calls.map(tc => {
          const argsStr = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          let argsObj;
          try { argsObj = JSON.parse(argsStr); } catch { argsObj = argsStr; }
          return `<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: argsObj })}\n</tool_call>`;
        }).join('\n');
        const baseText = msg.content ? String(msg.content) : '';
        const cleanedBaseText = this.parseToolCalls(baseText).content;
        return { role: msg.role, text: cleanedBaseText ? `${cleanedBaseText}\n${toolCallsText}` : toolCallsText };
      }
      let text;
      if (Array.isArray(msg.content)) {
        text = msg.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      } else {
        text = String(msg.content || '');
      }
      return { role: msg.role, text };
    });

    if (processed.length === 0) return '';

    const merged = [];
    let current = { ...processed[0] };

    for (let i = 1; i < processed.length; i++) {
      const msg = processed[i];
      if (msg.role === current.role) {
        current.text += `\n\n${msg.text}`;
      } else {
        merged.push(current);
        current = { ...msg };
      }
    }
    merged.push(current);

    // Build bilingual tool instructions once, injected right after the system block
    // so they are clearly pre-conversation directives, not mixed with user messages.
    let toolBlock = '';
    if (tools && tools.length > 0) {
      const toolDefs = JSON.stringify(tools);
      toolBlock = `\n\n# Tools / 工具调用规则\n\n` +
        `RULE 1: You MUST use the <tool_call> XML format for EVERY tool invocation. ` +
        `NEVER describe what you are going to do in plain text — execute it immediately with the format.\n` +
        `规则1：每次调用工具必须立即使用 <tool_call> XML 格式，绝不能用文字描述"我将要..."或"让我..."，要直接执行。\n\n` +
        `RULE 2: If file content ends with a truncation notice, call the tool again immediately. ` +
        `Do NOT write "I notice the file was truncated" — just call read_file again.\n` +
        `规则2：如果文件内容末尾显示截断，立即再次调用工具，不要写"我注意到截断了"之类的文字。\n\n` +
        `Available tools / 可用工具:\n<tools>\n${toolDefs}\n</tools>\n\n` +
        `Tool call format / 工具调用格式（唯一合法格式）:\n` +
        `<tool_call>\n{"name": "tool_name", "arguments": {"arg": "value"}}\n</tool_call>\n\n` +
        `Example — correct response when a file is truncated / 截断时的正确示范:\n` +
        `<tool_call>\n{"name": "read_file", "arguments": {"path": "src/example.js"}}\n</tool_call>`;
    }

    let prompt = merged
      .map((block, index) => {
        if (block.role === 'assistant') {
          return `<｜Assistant｜>${block.text}<｜end of sentence｜>`;
        }
        if (block.role === 'user' || block.role === 'system') {
          if (index === 0) {
            // First block (system / opening): inject tool instructions here so they
            // appear as system-level directives before any user turn.
            return block.text + toolBlock;
          }
          return `<｜User｜>${block.text}`;
        }
        return block.text;
      })
      .join('')
      .replace(/!\[.+\]\(.+\)/g, '');

    return prompt;
  }

  parseModelOptions(model) {
    const lowerModel = model.toLowerCase();
    
    // 1. Exact legacy/custom matches first for backward compatibility
    switch (lowerModel) {
      case 'default':
        return { modelType: 'default', thinkingEnabled: false, searchEnabled: false };
      case 'default_think':
        return { modelType: 'default', thinkingEnabled: true, searchEnabled: false };
      case 'expert':
        return { modelType: 'expert', thinkingEnabled: false, searchEnabled: false };
      case 'expert_think':
        return { modelType: 'expert', thinkingEnabled: true, searchEnabled: false };
      case 'default_search':
        return { modelType: 'default', thinkingEnabled: false, searchEnabled: true };
    }

    // 2. Keyword based matches for standard API names (deepseek-chat, deepseek-reasoner, etc.)
    if (lowerModel.includes('think') || lowerModel.includes('reasoner') || lowerModel.includes('r1')) {
      return { modelType: 'expert', thinkingEnabled: true, searchEnabled: false };
    }
    if (lowerModel.includes('search')) {
      return { modelType: 'default', thinkingEnabled: false, searchEnabled: true };
    }
    if (lowerModel.includes('expert') || lowerModel.includes('coder') || lowerModel.includes('chat')) {
      return { modelType: 'expert', thinkingEnabled: false, searchEnabled: false };
    }
    
    return { modelType: 'default', thinkingEnabled: false, searchEnabled: false };
  }

  estimateTokens(text) {
    if (!text) return 0;
    // Simple estimation: ~1 token per 3 characters for mixed English/Chinese
    return Math.ceil(text.length / 3);
  }

  parseToolCalls(content) {
    if (!content) return { content: content || '', tool_calls: undefined };

    const normalize = (tcArray, originalMatch) => {
      if (!Array.isArray(tcArray)) return null;
      let tool_calls = tcArray;
      if (tool_calls.length > 0 && typeof tool_calls[0] === 'string') {
        try {
          tool_calls = tool_calls.map(item => JSON.parse(item));
        } catch (e) { return null; }
      }
      const cleanedContent = content.replace(originalMatch, '').trim();
      const normalizedToolCalls = tool_calls.map((tc, idx) => ({
        id: tc.id || `call_${uuidv4().split('-')[0]}${idx}`,
        type: tc.type || 'function',
        function: tc.function || tc,
        index: tc.index !== undefined ? tc.index : idx
      }));
      return { content: cleanedContent, tool_calls: normalizedToolCalls };
    };

    const tryParseJSON = (str) => {
      try {
        return JSON.parse(str);
      } catch (e) {
        try {
          if (str.startsWith('[')) return JSON.parse(str + '}]');
          if (str.startsWith('{')) return JSON.parse(str + '}');
        } catch (e2) {}
        return null;
      }
    };

    // 1. <tool_calls> ... </tool_calls> (or unclosed)
    const tagRegex = /<tool_calls>\s*([\s\S]*?)(?:<\/tool_calls>|$)/;
    const tagMatch = content.match(tagRegex);
    if (tagMatch) {
      const json = tryParseJSON(tagMatch[1].trim());
      if (json && Array.isArray(json)) {
        const res = normalize(json, tagMatch[0]);
        if (res) return res;
      }
    }

    // 1c. Claude/Anthropic XML format (hallucinated by Cline's system prompt)
    // <tool_call name="read">\n<parameter name="filePath" string="true">C:\Code\Casio2</parameter>\n</tool_call>
    const xmlToolCallRegex = /<tool_call\s+name="([^"]+)">([\s\S]*?)(?:<\/tool_call>|$)/g;
    const xmlMatches = [...content.matchAll(xmlToolCallRegex)];
    if (xmlMatches.length > 0) {
      const tool_calls = [];
      let cleanedContent = content;
      
      // Also remove the <tool_calls> wrapper if it exists around them
      cleanedContent = cleanedContent.replace(/<tool_calls>\s*/g, '').replace(/<\/tool_calls>\s*/g, '');
      
      for (let i = 0; i < xmlMatches.length; i++) {
        cleanedContent = cleanedContent.replace(xmlMatches[i][0], '').trim();
        
        const name = xmlMatches[i][1];
        const paramsInner = xmlMatches[i][2];
        
        const args = {};
        const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)(?:<\/parameter>|$)/g;
        const paramMatches = [...paramsInner.matchAll(paramRegex)];
        
        for (const pMatch of paramMatches) {
          args[pMatch[1]] = pMatch[2].trim();
        }
        
        // If there were no parameter tags but there is inner text, maybe the whole inner text is JSON?
        let argumentsObj = args;
        if (paramMatches.length === 0 && paramsInner.trim().startsWith('{')) {
          const parsed = tryParseJSON(paramsInner.trim());
          if (parsed) argumentsObj = parsed;
        }
        
        tool_calls.push({
          id: `call_${uuidv4().split('-')[0]}${i}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(argumentsObj) },
          index: i
        });
      }
      if (tool_calls.length > 0) {
        // Strip any hallucinated <environment_details> that follow the tools
        cleanedContent = cleanedContent.replace(/<environment_details>[\s\S]*?<\/environment_details>/, '').trim();
        return { content: cleanedContent, tool_calls };
      }
    }
    // 1b. <tool_call> with XML sub-tags (hallucinated in Chinese mode):
    // <tool_call><tool_call_id>call_x</tool_call_id><tool_call_name>fn</tool_call_name><tool_args>{}</tool_args></tool_call>
    const chineseXmlRegex = /<tool_call>\s*<tool_call_id>([^<]*)<\/tool_call_id>\s*<tool_call_name>([^<]+)<\/tool_call_name>\s*<tool_args>([\s\S]*?)<\/tool_args>\s*(?:<\/tool_call>|$)/g;
    const chineseXmlMatches = [...content.matchAll(chineseXmlRegex)];
    if (chineseXmlMatches.length > 0) {
      const tool_calls = [];
      let cleanedContent = content;
      for (let i = 0; i < chineseXmlMatches.length; i++) {
        cleanedContent = cleanedContent.replace(chineseXmlMatches[i][0], '').trim();
        const id = chineseXmlMatches[i][1].trim() || `call_${uuidv4().split('-')[0]}${i}`;
        const name = chineseXmlMatches[i][2].trim();
        const argsStr = chineseXmlMatches[i][3].trim();
        let argsObj;
        try { argsObj = JSON.parse(argsStr); } catch { argsObj = {}; }
        tool_calls.push({
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(argsObj) },
          index: i
        });
      }
      if (tool_calls.length > 0) {
        return { content: cleanedContent, tool_calls };
      }
    }

    // 1c. <tool_call>{"name":...}</tool_call> (our instructed JSON format)
    const nativeTagRegex = /<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/g;
    const nativeMatches = [...content.matchAll(nativeTagRegex)];
    if (nativeMatches.length > 0) {
      const tool_calls = [];
      let cleanedContent = content;
      for (let i = 0; i < nativeMatches.length; i++) {
        cleanedContent = cleanedContent.replace(nativeMatches[i][0], '').trim();
        const json = tryParseJSON(nativeMatches[i][1].trim());
        if (json) {
          tool_calls.push({
            id: json.id || `call_${uuidv4().split('-')[0]}${i}`,
            type: json.type || 'function',
            function: {
              name: json.name || (json.function && json.function.name) || '',
              arguments: json.arguments !== undefined ?
                (typeof json.arguments === 'string' ? json.arguments : JSON.stringify(json.arguments)) :
                (json.function && json.function.arguments !== undefined ?
                  (typeof json.function.arguments === 'string' ? json.function.arguments : JSON.stringify(json.function.arguments)) :
                  '{}')
            },
            index: i
          });
        }
      }
      if (tool_calls.length > 0) {
        cleanedContent = cleanedContent.replace(/<environment_details>[\s\S]*?<\/environment_details>/, '').trim();
        return { content: cleanedContent, tool_calls };
      }
    }

    // 2. ```json ... ``` (object or array)
    const jsonRegex = /```(?:json)?\s*([\{\[][\s\S]*?[\}\]])\s*```/;
    const jsonMatch = content.match(jsonRegex);
    if (jsonMatch) {
      const json = tryParseJSON(jsonMatch[1]);
      if (json) {
        if (Array.isArray(json)) {
          const res = normalize(json, jsonMatch[0]);
          if (res) return res;
        }
        if (json.tool_calls && Array.isArray(json.tool_calls)) {
          const res = normalize(json.tool_calls, jsonMatch[0]);
          if (res) return res;
        }
      }
    }

    // 3. Naked array starting with [{"id" or [{"type" or [{"function" or [{"name"
    const nakedRegex = /(\[\s*\{\s*"(?:id|type|function|name)"[\s\S]*)$/;
    const nakedMatch = content.match(nakedRegex);
    if (nakedMatch) {
      const json = tryParseJSON(nakedMatch[1].trim());
      if (json && Array.isArray(json)) {
        const res = normalize(json, nakedMatch[0]);
        if (res) return res;
      }
    }

    // 4a. Function-call style: toolName({"key": "val"}) — hallucinated in some Chinese-mode responses.
    // e.g.  bash({"command": "ls"})  read({"filePath": "src/index.js"})
    // Guards: lowercase name, valid JSON object arg, not inside a ``` code block.
    {
      const fnCallPattern = /\b([a-z_]\w*)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
      const fnMatches = [...content.matchAll(fnCallPattern)];
      const validFnMatches = fnMatches.filter(m => {
        const json = tryParseJSON(m[2]);
        if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
        // Reject if the match sits inside a fenced code block
        const before = content.substring(0, m.index);
        return (before.match(/```/g) || []).length % 2 === 0;
      });
      if (validFnMatches.length > 0) {
        const tool_calls = [];
        let cleanedContent = content;
        for (let i = 0; i < validFnMatches.length; i++) {
          const m = validFnMatches[i];
          const json = tryParseJSON(m[2]);
          cleanedContent = cleanedContent.replace(m[0], '').trim();
          tool_calls.push({
            id: `call_${uuidv4().split('-')[0]}${i}`,
            type: 'function',
            function: { name: m[1], arguments: JSON.stringify(json) },
            index: i
          });
        }
        if (tool_calls.length > 0) return { content: cleanedContent, tool_calls };
      }
    }

    // 4b. Fallback: Robust regex extraction for truncated or malformed JSON
    const tcRegex = /\{\s*(?:"id"\s*:\s*"([^"]+)"\s*,\s*)?(?:"type"\s*:\s*"([^"]+)"\s*,\s*)?(?:"function"\s*:\s*\{\s*)?"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*([\s\S]*?)(?=\},\s*\{\s*(?:"id"|"type"|"function"|"name")|\}\]|<\/tool_calls>|<\/tool_call>|```|$)/g;
    const fallbackMatches = [...content.matchAll(tcRegex)];
    if (fallbackMatches.length > 0) {
      const tool_calls = fallbackMatches.map((match, idx) => {
        let id = match[1] || `call_${uuidv4().split('-')[0]}${idx}`;
        let type = match[2] || 'function';
        let name = match[3] || '';
        let argsRaw = match[4].trim();

        argsRaw = argsRaw.replace(/(?:\]\}|\}|\]|<\/tool_calls>|<\/tool_call>|```)$/, '').trim();

        let argsStr = '';
        if (argsRaw.startsWith('"')) {
          let endIdx = -1;
          let inEscape = false;
          for (let i = 1; i < argsRaw.length; i++) {
            if (inEscape) {
              inEscape = false;
            } else if (argsRaw[i] === '\\') {
              inEscape = true;
            } else if (argsRaw[i] === '"') {
              endIdx = i;
              break;
            }
          }
          if (endIdx !== -1) {
            argsRaw = argsRaw.substring(0, endIdx + 1);
          } else {
            argsRaw = argsRaw + '"';
          }
          try {
            argsStr = JSON.parse(argsRaw);
          } catch (e) {
            argsStr = argsRaw.substring(1, argsRaw.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
        } else {
          let openBraces = 0;
          let openBrackets = 0;
          let inString = false;
          let escape = false;
          let validEnd = argsRaw.length;

          for (let i = 0; i < argsRaw.length; i++) {
            const char = argsRaw[i];
            if (escape) { escape = false; continue; }
            if (char === '\\') { escape = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
              if (char === '{') openBraces++;
              if (char === '}') openBraces--;
              if (char === '[') openBrackets++;
              if (char === ']') openBrackets--;
              if (openBraces < 0) { validEnd = i; break; }
            }
          }
          argsStr = argsRaw.substring(0, validEnd).trim();
          if (inString) argsStr += '"';
          while (openBrackets > 0) { argsStr += ']'; openBrackets--; }
          while (openBraces > 0) { argsStr += '}'; openBraces--; }
        }

        return {
          id,
          type,
          function: { name, arguments: typeof argsStr === 'string' ? argsStr : JSON.stringify(argsStr) },
          index: idx
        };
      });

      const firstMatchIdx = content.indexOf(fallbackMatches[0][0]);
      let cleanedContent = content.substring(0, firstMatchIdx).trim();
      cleanedContent = cleanedContent.replace(/```(?:json)?\s*\[?$/, '').replace(/<tool_calls>\s*\[?$/, '').replace(/<tool_call>\s*$/, '').replace(/\[$/, '').trim();
      cleanedContent = cleanedContent.replace(/<environment_details>[\s\S]*?<\/environment_details>/, '').trim();
      
      return { content: cleanedContent, tool_calls };
    }

    return { content, tool_calls: undefined };
  }

  async createCompletion(model, messages, refConvId, tools, toolChoice) {
    return this._doCompletion(model, messages, refConvId, false, tools, toolChoice);
  }

  async createCompletionStream(model, messages, refConvId, tools, toolChoice) {
    return this._doCompletion(model, messages, refConvId, true, tools, toolChoice);
  }

  async _doCompletion(model, messages, refConvId, stream = false, tools, toolChoice) {
    const { modelType, thinkingEnabled, searchEnabled } = this.parseModelOptions(model);
    const prompt = this.prepareMessages(messages, tools, toolChoice);
    const estimatedPromptTokens = this.estimateTokens(prompt);

    if (process.env.DEBUG === '1') {
      console.log('\n[DBG] ── PROMPT SENT TO DEEPSEEK (' + prompt.length + ' chars) ──────────────');
      // Print in sections to stay readable
      const SECTION = 1200;
      for (let i = 0; i < prompt.length; i += SECTION) {
        console.log(prompt.slice(i, i + SECTION));
        if (i + SECTION < prompt.length) console.log('... [continues] ...');
      }
      console.log('[DBG] ── END PROMPT ──────────────────────────────────────────');
    }

    const [refSessionId, refParentMsgId] = refConvId?.split('@') || [];

    const sessionId = refSessionId || await this.createSession();
    const token = await this.acquireToken();
    const parentMessageId = refParentMsgId ? Number(refParentMsgId) : null;

    const challenge = await this.getChallengeResponse('/api/v0/chat/completion');
    const powResponse = await this.answerChallenge(challenge, '/api/v0/chat/completion');

    const response = await axios.post(
      'https://chat.deepseek.com/api/v0/chat/completion',
      {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        model_type: modelType,
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        preempt: false
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: this.generateCookie(),
          'X-Ds-Pow-Response': powResponse
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
        httpsAgent
      }
    );

    const contentType = response.headers['content-type'] || '';
    if (contentType.indexOf('text/event-stream') === -1) {
      // Read the error body
      let errorBody = '';
      await new Promise((resolve, reject) => {
        response.data.on('data', (chunk) => { errorBody += chunk.toString(); });
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });
      throw new Error(`API error (${contentType}): ${errorBody.substring(0, 300)}`);
    }

    if (stream) {
      return this._convertToOpenAIStream(response.data, sessionId, model, estimatedPromptTokens);
    } else {
      return this._collectStreamResponse(response.data, sessionId, model, estimatedPromptTokens);
    }
  }

  async _collectStreamResponse(stream, sessionId, model, promptTokens) {
    let accumulatedContent = '';
    let accumulatedThinking = '';
    let messageId = '';
    let currentPath = 'content';
    let accumulatedTokenUsage = 0;
    const created = Math.floor(Date.now() / 1000);
    let streamError = null;

    return new Promise((resolve, reject) => {
      const parser = createParser((event) => {
        if (event.type !== 'event' || !event.data) return;

        try {
          const chunk = JSON.parse(event.data);
          if (!chunk || typeof chunk !== 'object') return;

          if (event.event === 'hint') {
            if (chunk.type === 'error') {
              streamError = new Error(chunk.content || 'Unknown error from DeepSeek');
              streamError.finishReason = chunk.finish_reason || 'error';
              if (chunk.clear_response) {
                accumulatedContent = '';
                accumulatedThinking = '';
              }
              return;
            }
            return;
          }

          if (chunk.response_message_id && !messageId) {
            messageId = chunk.response_message_id;
          }

          if (chunk.v && chunk.v.response) {
            const resp = chunk.v.response;
            currentPath = resp.thinking_enabled ? 'thinking' : 'content';
            if (resp.fragments && resp.fragments.length > 0) {
              const text = resp.fragments.map(f => f.content || '').join('');
              if (currentPath === 'thinking') {
                accumulatedThinking += text;
              } else {
                accumulatedContent += text;
              }
            }
          } else if (chunk.p && chunk.p.startsWith('response/fragments')) {
            currentPath = 'content';
          }

          if (typeof chunk.v === 'string') {
            const cleaned = chunk.v.replace(/FINISHED/g, '');
            if (currentPath === 'thinking') {
              accumulatedThinking += cleaned;
            } else {
              accumulatedContent += cleaned;
            }
          } else if (Array.isArray(chunk.v)) {
            chunk.v.forEach(e => {
              if (e.p === 'accumulated_token_usage' && typeof e.v === 'number') {
                accumulatedTokenUsage = e.v;
              }
              if (Array.isArray(e.v)) {
                const text = e.v.map(v => v.content || '').join('');
                if (currentPath === 'thinking') {
                  accumulatedThinking += text;
                } else {
                  accumulatedContent += text;
                }
              }
            });
          }
        } catch (e) {}
      });

      stream.on('data', (buffer) => parser.feed(buffer.toString()));
      stream.on('error', reject);
      stream.on('close', () => {
        if (streamError) {
          reject(streamError);
          return;
        }
        const parsed = this.parseToolCalls(accumulatedContent.trim());
        const message = {
          role: 'assistant',
          content: parsed.tool_calls ? null : parsed.content,
          reasoning_content: accumulatedThinking.trim() || undefined
        };
        if (parsed.tool_calls) {
          // Strip internal `index` field — not part of OpenAI non-streaming spec
          message.tool_calls = parsed.tool_calls.map(({ index: _idx, ...tc }) => tc);
        }
        
        const completionTokens = accumulatedTokenUsage || this.estimateTokens(accumulatedContent + accumulatedThinking);
        const finishReason = parsed.tool_calls ? 'tool_calls' : 'stop';

        if (process.env.DEBUG === '1') {
          console.log('\n[DBG] ── RESPONSE (non-stream) ──────────────────────────────');
          console.log(`[DBG] finish_reason : ${finishReason}`);
          console.log(`[DBG] content       : ${(parsed.content || '').slice(0, 300).replace(/\n/g, '↵')}`);
          console.log(`[DBG] tool_calls    : ${parsed.tool_calls ? JSON.stringify(parsed.tool_calls) : 'none'}`);
          console.log(`[DBG] raw content   : ${accumulatedContent.slice(0, 500).replace(/\n/g, '↵')}`);
          console.log('[DBG] ─────────────────────────────────────────────────────────');
        }

        resolve({
          id: `${sessionId}@${messageId}`,
          model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: finishReason
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens
          },
          created
        });
      });
    });
  }

  _convertToOpenAIStream(stream, sessionId, model, promptTokens) {
    const passthrough = new PassThrough();
    let messageId = '';
    let currentPath = 'content';
    let isFirstChunk = true;
    const created = Math.floor(Date.now() / 1000);
    let accumulatedTokenUsage = 0;
    let accumulatedContent = '';
    let accumulatedThinking = '';
    let hasEnded = false;
    let unflushedContent = '';
    let inToolCallBlock = false;
    let streamedContentLength = 0;

    const sendFinalChunks = () => {
      const parsed = this.parseToolCalls(accumulatedContent);
      const completionTokens = accumulatedTokenUsage || this.estimateTokens(accumulatedContent + accumulatedThinking);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      };
      const baseId = `${sessionId}@${messageId}`;

      if (process.env.DEBUG === '1') {
        const finishReason = parsed.tool_calls ? 'tool_calls' : 'stop';
        console.log('\n[DBG] ── RESPONSE (stream final) ────────────────────────────');
        console.log(`[DBG] finish_reason : ${finishReason}`);
        console.log(`[DBG] content       : ${(parsed.content || '').slice(0, 300).replace(/\n/g, '↵')}`);
        console.log(`[DBG] tool_calls    : ${parsed.tool_calls ? JSON.stringify(parsed.tool_calls) : 'none'}`);
        console.log(`[DBG] raw content   : ${accumulatedContent.slice(0, 500).replace(/\n/g, '↵')}`);
        console.log('[DBG] ─────────────────────────────────────────────────────────');
      }

      const remainingContent = parsed.content.substring(streamedContentLength);
      if (remainingContent) {
        passthrough.write(`data: ${JSON.stringify({
          id: baseId,
          model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: remainingContent }, finish_reason: null }],
          created
        })}\n\n`);
      }

      if (parsed.tool_calls && parsed.tool_calls.length > 0) {
        // Stream tool calls in OpenAI format: header chunk → arguments chunk per call → finish chunk
        for (const tc of parsed.tool_calls) {
          const tcIndex = tc.index !== undefined ? tc.index : 0;
          passthrough.write(`data: ${JSON.stringify({
            id: baseId, model, object: 'chat.completion.chunk', created,
            choices: [{ index: 0, delta: { tool_calls: [{ index: tcIndex, id: tc.id, type: tc.type || 'function', function: { name: tc.function.name, arguments: '' } }] }, finish_reason: null }]
          })}\n\n`);
          if (tc.function.arguments) {
            passthrough.write(`data: ${JSON.stringify({
              id: baseId, model, object: 'chat.completion.chunk', created,
              choices: [{ index: 0, delta: { tool_calls: [{ index: tcIndex, function: { arguments: tc.function.arguments } }] }, finish_reason: null }]
            })}\n\n`);
          }
        }
        passthrough.write(`data: ${JSON.stringify({
          id: baseId, model, object: 'chat.completion.chunk', created,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage
        })}\n\n`);
      } else {
        passthrough.write(`data: ${JSON.stringify({
          id: baseId, model, object: 'chat.completion.chunk', created,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage
        })}\n\n`);
      }

      passthrough.end('data: [DONE]\n\n');
    };

    const parser = createParser((event) => {
      if (hasEnded) return;
      if (event.type !== 'event') return;

      if (event.event === 'hint') {
        try {
          const hintData = JSON.parse(event.data);
          if (hintData.type === 'error') {
            const errMsg = hintData.content || 'Unknown error from DeepSeek';
            passthrough.write(`data: ${JSON.stringify({
              id: `${sessionId}@${messageId}`,
              model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: hintData.finish_reason || 'error', error: errMsg }],
              created
            })}\n\n`);
            passthrough.end('data: [DONE]\n\n');
            hasEnded = true;
            return;
          }
        } catch(e) {}
        return;
      }

      if (event.event === 'close' || event.data.trim() === '[DONE]') {
        hasEnded = true;
        sendFinalChunks();
        return;
      }

      if (!event.data) return;

      let chunk;
      try {
        chunk = JSON.parse(event.data);
      } catch (e) {
        console.error('[DeepSeekStream] JSON parse error:', e.message, 'data:', event.data.substring(0, 200));
        return;
      }
      if (!chunk || typeof chunk !== 'object') return;

      if (chunk.response_message_id && !messageId) {
        messageId = chunk.response_message_id;
      }

      if (chunk.v && chunk.v.response) {
        currentPath = chunk.v.response.thinking_enabled ? 'thinking' : 'content';
      } else if (chunk.p && chunk.p.startsWith('response/fragments')) {
        currentPath = 'content';
      } else if (chunk.p === 'response/search_status' || chunk.p === 'response/search_results') {
        return;
      }

      if (chunk.p === 'response' && Array.isArray(chunk.v)) {
        chunk.v.forEach(e => {
          if (e.p === 'accumulated_token_usage' && typeof e.v === 'number') {
            accumulatedTokenUsage = e.v;
          }
        });
      }

      let content = '';
      if (typeof chunk.v === 'string') {
        content = chunk.v.replace(/FINISHED/g, '').replace(/\[citation:(\d+)\]/g, '[$1]');
      } else if (Array.isArray(chunk.v)) {
        chunk.v.forEach(e => {
          if (Array.isArray(e.v)) {
            content = e.v.map(v => v.content || '').join('');
          }
        });
      } else if (chunk.v && chunk.v.response && chunk.v.response.fragments) {
        content = chunk.v.response.fragments.map(f => f.content || '').join('');
      }

      if (!content) return;

      const delta = {};
      if (isFirstChunk) {
        delta.role = 'assistant';
        isFirstChunk = false;
      }

      if (currentPath === 'thinking') {
        delta.reasoning_content = content;
        accumulatedThinking += content;
      } else {
        accumulatedContent += content;
        unflushedContent += content;
        let flushable = '';

        if (!inToolCallBlock) {
          const TARGETS = [
            '<tool_calls>',
            '<tool_call',
            '```json\n[',
            '\n[{"',
            '[{"'
          ];

          let matchIdx = -1;
          for (const target of TARGETS) {
            const idx = unflushedContent.indexOf(target);
            if (idx !== -1) {
              if (matchIdx === -1 || idx < matchIdx) {
                matchIdx = idx;
              }
            }
          }

          if (matchIdx !== -1) {
            inToolCallBlock = true;
            flushable = unflushedContent.substring(0, matchIdx);
            unflushedContent = unflushedContent.substring(matchIdx);
          } else {
            let holdIdx = -1;
            for (const target of TARGETS) {
              for (let i = 1; i <= target.length - 1; i++) {
                const prefix = target.substring(0, i);
                if (unflushedContent.endsWith(prefix)) {
                  const possibleHoldIdx = unflushedContent.length - i;
                  if (holdIdx === -1 || possibleHoldIdx < holdIdx) {
                    holdIdx = possibleHoldIdx;
                  }
                }
              }
            }

            if (holdIdx !== -1) {
              flushable = unflushedContent.substring(0, holdIdx);
              unflushedContent = unflushedContent.substring(holdIdx);
            } else {
              flushable = unflushedContent;
              unflushedContent = '';
            }
          }
        }

        if (flushable) {
          delta.content = flushable;
          streamedContentLength += flushable.length;
        } else {
          if (!delta.reasoning_content && !delta.role && !isFirstChunk) return;
        }
      }

      passthrough.write(`data: ${JSON.stringify({
        id: `${sessionId}@${messageId}`,
        model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: null }],
        created
      })}\n\n`);
    });

    stream.on('data', (buffer) => parser.feed(buffer.toString()));
    stream.on('error', (err) => {
      console.error('[DeepSeekStream] Raw stream error:', err.message);
      streamError = err;
      if (!hasEnded) {
        hasEnded = true;
        passthrough.destroy();
      }
    });
    stream.on('close', () => {
      if (hasEnded) return;
      console.log('[DeepSeekStream] Stream closed without event:close, sending final chunks. Accumulated content length:', accumulatedContent.length);
      hasEnded = true;
      sendFinalChunks();
    });

    return passthrough;
  }
}

module.exports = DeepSeekClient;
