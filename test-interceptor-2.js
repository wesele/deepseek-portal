let accumulatedContent = '';
let hasEnded = false;
let unflushedContent = '';
let inToolCallBlock = false;
let streamedContentLength = 0;

function streamChunk(chunk) {
  unflushedContent += chunk;
  accumulatedContent += chunk;
  let flushable = '';

  if (!inToolCallBlock) {
    const tcIdx = unflushedContent.indexOf('<tool_calls>');
    const jsonTcIdx = unflushedContent.indexOf('```json\n[');
    const nakedTcIdx = unflushedContent.indexOf('\n[{"');

    let matchIdx = -1;
    if (tcIdx !== -1) matchIdx = tcIdx;
    if (jsonTcIdx !== -1 && (matchIdx === -1 || jsonTcIdx < matchIdx)) matchIdx = jsonTcIdx;
    if (nakedTcIdx !== -1 && (matchIdx === -1 || nakedTcIdx < matchIdx)) matchIdx = nakedTcIdx;

    if (matchIdx === -1 && unflushedContent.startsWith('[{"')) {
      matchIdx = 0;
    }

    if (matchIdx !== -1) {
      inToolCallBlock = true;
      flushable = unflushedContent.substring(0, matchIdx);
      unflushedContent = unflushedContent.substring(matchIdx);
    } else {
      const lastLess = unflushedContent.lastIndexOf('<');
      const lastTick = unflushedContent.lastIndexOf('`');
      const lastBracket = unflushedContent.lastIndexOf('\n[');
      const firstBracket = unflushedContent.startsWith('[') ? 0 : -1;

      let hold = false;
      if (lastLess !== -1 && '<tool_calls>'.startsWith(unflushedContent.substring(lastLess))) hold = true;
      if (lastTick !== -1 && '```json\n['.startsWith(unflushedContent.substring(lastTick))) hold = true;
      if (lastBracket !== -1 && '\n[{"'.startsWith(unflushedContent.substring(lastBracket))) hold = true;
      if (firstBracket === 0 && '[{"'.startsWith(unflushedContent)) hold = true;

      if (hold) {
        const holdIdx = Math.max(lastLess, lastTick, lastBracket, firstBracket);
        flushable = unflushedContent.substring(0, holdIdx);
        unflushedContent = unflushedContent.substring(holdIdx);
      } else {
        flushable = unflushedContent;
        unflushedContent = '';
      }
    }
  }

  if (flushable) {
    streamedContentLength += flushable.length;
    console.log(`FLUSHED [${flushable.length}]: ${JSON.stringify(flushable)}`);
  }
}

streamChunk('This is some text.\n\n');
streamChunk('[{"id":');
streamChunk('"tc_1"}]');

console.log('inToolCallBlock:', inToolCallBlock);
console.log('unflushedContent:', JSON.stringify(unflushedContent));
