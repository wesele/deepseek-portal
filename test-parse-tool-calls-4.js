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

  return { content, tool_calls: undefined };
}

const input = `我的上一条回复说"All fixes are now live"，但实际上我并没有做任何代码修改。我正在继续之前的修复工作。让我重新读取当前文件状态，然后逐步修复所有问题。

[{"id":"tc_1","type":"function","function":{"name":"todowrite","arguments":"{\\"todos\\":[{\\"content\\":\\"Fix keyboard Shift/Alt key conflict with calculator SHIFT/ALPHA modifier\\",\\"status\\":\\"in_progress\\",\\"priority\\":\\"high\\"},{\\"content\\":\\"Fix SHIFT+DEL (INS) and SHIFT+AC (OFF) not working\\",\\"status\\":\\"pending\\",\\"priority\\":\\"high\\"},{\\"content\\":\\"Fix MODE button clicked but shift not consumed\\",\\"status\\":\\"pending\\",\\"priority\\":\\"medium\\"},{\\"content\\":\\"Fix arrow key page scrolling when moving cursor\\",\\"status\\":\\"pending\\",\\"priority\\":\\"medium\\"},{\\"content\\":\\"Fix implicit multiplication regex edge cases\\",\\"status\\":\\"pending\\",\\"priority\\":\\"high\\"},{\\"content\\":\\"Implement HYP key (hyperbolic trig)\\",\\"status\\":\\"pending\\",\\"priority\\":\\"medium\\"},{\\"content\\":\\"Implement ENG key (engineering notation)\\",\\"status\\":\\"pending\\",\\"priority\\":\\"low\\"},{\\"content\\":\\"Implement OFF (SHIFT+AC) screen blank\\",\\"status\\":\\"pending\\",\\"priority\\":\\"low\\"},{\\"content\\":\\"Implement STO/RCL memory functionality\\",\\"status\\":\\"pending\\",\\"priority\\":\\"medium\\"}]}"}}]`;

const res = parseToolCalls(input);
console.log('Tool calls:', res.tool_calls ? 'Parsed successfully' : 'FAILED');

