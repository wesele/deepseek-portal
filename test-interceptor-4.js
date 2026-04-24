let accumulatedContent = '';
let hasEnded = false;
let unflushedContent = '';
let inToolCallBlock = false;
let streamedContentLength = 0;

const TARGETS = [
  '<tool_calls>',
  '```json\n[',
  '\n[{"',
  '[{"' // Only at start of stream, but we can treat it generally for safety
];

function streamChunk(chunk) {
  unflushedContent += chunk;
  accumulatedContent += chunk;
  let flushable = '';

  if (!inToolCallBlock) {
    let matchIdx = -1;
    let matchedTarget = null;
    
    for (const target of TARGETS) {
      const idx = unflushedContent.indexOf(target);
      if (idx !== -1) {
        if (matchIdx === -1 || idx < matchIdx) {
          matchIdx = idx;
          matchedTarget = target;
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
    streamedContentLength += flushable.length;
    console.log(`FLUSHED [${flushable.length}]: ${JSON.stringify(flushable)}`);
  }
}

streamChunk('Here is the tool:\n\n`');
streamChunk('``js');
streamChunk('on\n');
streamChunk('[');
streamChunk('{"id":');

console.log('inToolCallBlock:', inToolCallBlock);
console.log('unflushed:', JSON.stringify(unflushedContent));
