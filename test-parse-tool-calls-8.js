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
      id: tc.id || \`call_\${uuidv4().split('-')[0]}\${idx}\`,
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
  const tagRegex = /<tool_calls>\\s*([\\s\\S]*?)(?:<\\/tool_calls>|$)/;
  const tagMatch = content.match(tagRegex);
  if (tagMatch) {
    const json = tryParseJSON(tagMatch[1].trim());
    if (json && Array.isArray(json)) {
      const res = normalize(json, tagMatch[0]);
      if (res) return res;
    }
  }

  // 1b. <tool_call> ... </tool_call> (DeepSeek native format, can be multiple)
  const nativeTagRegex = /<tool_call>\\s*([\\s\\S]*?)(?:<\\/tool_call>|$)/g;
  const nativeMatches = [...content.matchAll(nativeTagRegex)];
  if (nativeMatches.length > 0) {
    const tool_calls = [];
    let cleanedContent = content;
    for (let i = 0; i < nativeMatches.length; i++) {
      cleanedContent = cleanedContent.replace(nativeMatches[i][0], '').trim();
      const json = tryParseJSON(nativeMatches[i][1].trim());
      if (json) {
        tool_calls.push({
          id: json.id || \`call_\${uuidv4().split('-')[0]}\${i}\`,
          type: json.type || 'function',
          function: json.function || { name: json.name, arguments: typeof json.arguments === 'string' ? json.arguments : JSON.stringify(json.arguments) },
          index: i
        });
      }
    }
    if (tool_calls.length > 0) {
      return { content: cleanedContent, tool_calls };
    }
  }

  // 2. \`\`\`json ... \`\`\` (object or array)
  const jsonRegex = /\`\`\`(?:json)?\\s*([\\{\\[][\\s\\S]*?[\\}\\]])\\s*\`\`\`/;
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
  const nakedRegex = /(\\[\\s*\\{\\s*"(?:id|type|function|name)"[\\s\\S]*)$/;
  const nakedMatch = content.match(nakedRegex);
  if (nakedMatch) {
    const json = tryParseJSON(nakedMatch[1].trim());
    if (json && Array.isArray(json)) {
      const res = normalize(json, nakedMatch[0]);
      if (res) return res;
    }
  }

  // 4. Fallback: Robust regex extraction for truncated or malformed JSON
  const tcRegex = /\\{\\s*(?:"id"\\s*:\\s*"([^"]+)"\\s*,\\s*)?(?:"type"\\s*:\\s*"([^"]+)"\\s*,\\s*)?(?:"function"\\s*:\\s*\\{\\s*)?"name"\\s*:\\s*"([^"]+)"\\s*,\\s*"arguments"\\s*:\\s*([\\s\\S]*?)(?=\\},\\s*\\{\\s*(?:"id"|"type"|"function"|"name")|\\}\\]|<\/tool_calls>|<\/tool_call>|\`\`\`|$)/g;
  const fallbackMatches = [...content.matchAll(tcRegex)];
  if (fallbackMatches.length > 0) {
    const tool_calls = fallbackMatches.map((match, idx) => {
      let id = match[1] || \`call_\${uuidv4().split('-')[0]}\${idx}\`;
      let type = match[2] || 'function';
      let name = match[3];
      let argsRaw = match[4].trim();

      argsRaw = argsRaw.replace(/(?:\\]\\}|\\}|\]|<\/tool_calls>|<\/tool_call>|\`\`\`)$/, '').trim();

      let argsStr = '';
      if (argsRaw.startsWith('"')) {
        let endIdx = -1;
        let inEscape = false;
        for (let i = 1; i < argsRaw.length; i++) {
          if (inEscape) {
            inEscape = false;
          } else if (argsRaw[i] === '\\\\') {
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
          argsStr = argsRaw.substring(1, argsRaw.length - 1).replace(/\\"/g, '"').replace(/\\\\\\\\/g, '\\\\');
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
          if (char === '\\\\') { escape = true; continue; }
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
    cleanedContent = cleanedContent.replace(/\`\`\`(?:json)?\\s*\\[?$/, '').replace(/<tool_calls>\\s*\\[?$/, '').replace(/<tool_call>\\s*$/, '').replace(/\\[$/, '').trim();
    
    return { content: cleanedContent, tool_calls };
  }

  return { content, tool_calls: undefined };
}

const input1 = \`Sure, I will run the tool.
<tool_call>
{"name": "ls", "arguments": {"dir": "src"}}
</tool_call>
<tool_call>
{"name": "pwd", "arguments": {}}
</tool_call>\`;

const input2 = \`Broken test
<tool_call>
{"name": "ls", "arguments": {"dir": "src"}\`;

console.log('--- Native format ---');
console.log(JSON.stringify(parseToolCalls(input1), null, 2));

console.log('\\n--- Broken native ---');
console.log(JSON.stringify(parseToolCalls(input2), null, 2));

