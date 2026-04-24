function extractTruncatedToolCalls(str) {
  const tool_calls = [];
  const tcRegex = /\{\s*(?:"id"\s*:\s*"([^"]+)"\s*,\s*)?(?:"type"\s*:\s*"([^"]+)"\s*,\s*)?(?:"function"\s*:\s*\{\s*)?"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*([\s\S]*)/g;
  
  let match;
  while ((match = tcRegex.exec(str)) !== null) {
    let id = match[1] || 'call_fallback';
    let type = match[2] || 'function';
    let name = match[3];
    let argsRaw = match[4].trim();

    // Clean up trailing tags or array closures
    argsRaw = argsRaw.replace(/(?:\]\}|\]|<\/tool_calls>|```)$/, '').trim();
    if (argsRaw.endsWith('}')) {
      // Might be the end of the function object, or end of args object.
      // We'll leave it for now.
    }

    let argsStr = '';
    if (argsRaw.startsWith('"')) {
      // String literal
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
        // Truncated string literal! Close it.
        argsRaw = argsRaw + '"';
      }
      
      try {
        argsStr = JSON.parse(argsRaw);
      } catch (e) {
        argsStr = argsRaw.substring(1, argsRaw.length - 1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    } else {
      // Object literal, just use it as string
      // Try to balance braces
      let openBraces = 0;
      let openBrackets = 0;
      let inString = false;
      let escape = false;
      let validEnd = argsRaw.length;

      for (let i = 0; i < argsRaw.length; i++) {
        const char = argsRaw[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\\') {
          escape = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === '{') openBraces++;
          if (char === '}') openBraces--;
          if (char === '[') openBrackets++;
          if (char === ']') openBrackets--;
          if (openBraces < 0) {
            // Reached the end of the arguments object
            validEnd = i;
            break;
          }
        }
      }
      
      argsStr = argsRaw.substring(0, validEnd).trim();
      // Auto-close missing braces/brackets
      if (inString) argsStr += '"';
      while (openBrackets > 0) { argsStr += ']'; openBrackets--; }
      while (openBraces > 0) { argsStr += '}'; openBraces--; }
    }

    tool_calls.push({
      id,
      type,
      function: {
        name,
        arguments: argsStr
      }
    });
  }
  
  return tool_calls.length > 0 ? tool_calls : null;
}

const inputs = [
  `[{"id":"tc_1","type":"function","function":{"name":"todowrite","arguments":"{\\"todos\\":[{\\"content\\":\\"Fix keyboard\\",\\"status\\":\\"in_progress\\"}`
];

inputs.forEach(input => {
  console.log(JSON.stringify(extractTruncatedToolCalls(input), null, 2));
});
