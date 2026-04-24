const { v4: uuidv4 } = require('uuid');

function parseToolCalls(content) {
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
      return normalize(json, tagMatch[0]) || { content, tool_calls: undefined };
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

  // 3. Naked array
  const nakedRegex = /(\[\s*\{\s*"(?:id|type|function|name)"[\s\S]*)$/;
  const nakedMatch = content.match(nakedRegex);
  if (nakedMatch) {
    const json = tryParseJSON(nakedMatch[1].trim());
    if (json && Array.isArray(json)) {
      const res = normalize(json, nakedMatch[0]);
      if (res) return res;
    }
  }

  return { content, tool_calls: undefined };
}

function test(name, text) {
  console.log('--- ' + name + ' ---');
  const res = parseToolCalls(text);
  console.log('Content:', JSON.stringify(res.content));
  console.log('Tool calls:', JSON.stringify(res.tool_calls, null, 2));
}

test('Missing close', 'Here is the tool:\n<tool_calls>\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]');
test('Markdown array', 'Here is the tool:\n```json\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]\n```');
test('Naked array', 'Here is the tool:\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]');
test('Truncated naked', 'Here is the tool:\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"');
