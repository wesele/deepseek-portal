/**
 * Kilo Agent Loop Simulator
 *
 * Simulates how Kilo Code drives a multi-step agentic workflow against our adapter.
 * Shows exactly what finish_reason / tool_calls the model returns each round,
 * so we can pinpoint where the agent stops prematurely.
 *
 * Usage:
 *   node test-kilo-agent.js [task]
 *
 * Env:
 *   DEEPSEEK_TOKEN  – your DeepSeek refresh token (read from .env automatically)
 *   BASE_URL        – adapter URL (default: http://localhost:3000)
 *   MODEL           – model to use (default: expert)
 *   MAX_ROUNDS      – max agentic rounds (default: 10)
 *   STREAM          – set to '1' to test streaming mode
 */

'use strict';

require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MODEL    = process.env.MODEL    || 'expert';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || '10');
const USE_STREAM = process.env.STREAM === '1';
const TOKEN    = process.env.DEEPSEEK_TOKEN;

if (!TOKEN) {
  console.error('[ERROR] DEEPSEEK_TOKEN not set. Add it to .env or export it.');
  process.exit(1);
}

// ── Simplified Kilo-style system prompt ───────────────────────────────────────
const SYSTEM_PROMPT = `\
You are an expert software engineering assistant with access to tools.

Your job is to complete tasks step-by-step. You MUST:
1. Break the task into steps.
2. Call the appropriate tool for each step.
3. Wait for the tool result before proceeding to the next step.
4. Continue calling tools until ALL steps are complete.
5. Only provide a final answer AFTER all required tool calls have been made.

Do NOT summarise until you have finished all required steps.`;

// ── Tool definitions (subset of what Kilo provides) ───────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory matching an optional glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Directory path (relative to project root)' },
          pattern: { type: 'string', description: 'Optional glob pattern, e.g. **/*.js' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the full contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a file with new content.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Content to write' }
        },
        required: ['path', 'content']
      }
    }
  }
];

// ── Mock tool executor (replace with real FS calls if needed) ─────────────────
const fs = require('fs');
const path = require('path');

function executeTool(name, args) {
  try {
    if (name === 'list_files') {
      const dir = args.path || '.';
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const result = entries.map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
      return result || '(empty directory)';
    }
    if (name === 'read_file') {
      const content = fs.readFileSync(args.path, 'utf8');
      // Truncate long files to avoid token explosion in tests
      return content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
    }
    if (name === 'write_file') {
      fs.writeFileSync(args.path, args.content, 'utf8');
      return `File written: ${args.path}`;
    }
    return `[Unknown tool: ${name}]`;
  } catch (err) {
    return `[Tool error: ${err.message}]`;
  }
}

// ── Pretty-print helpers ───────────────────────────────────────────────────────
const CLR = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
              green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
              red: '\x1b[31m', magenta: '\x1b[35m' };

function box(label, color, text) {
  const line = '─'.repeat(60);
  console.log(`\n${color}${CLR.bold}┌${line}┐${CLR.reset}`);
  console.log(`${color}${CLR.bold}│ ${label}${CLR.reset}`);
  console.log(`${color}${CLR.bold}└${line}┘${CLR.reset}`);
  if (text !== undefined) console.log(text);
}

// ── Non-streaming completion ───────────────────────────────────────────────────
async function callCompletion(messages) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      stream: false
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Streaming completion (collects full response) ──────────────────────────────
async function callCompletionStream(messages) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      stream: true
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  // Collect chunks and reconstruct a synthetic completion object
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let toolCalls = {};   // index → {id, type, function: {name, arguments}}
  let finishReason = null;
  let usage = null;
  let id = '';

  process.stdout.write(`${CLR.dim}[stream] `);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') { process.stdout.write(' [DONE]'); continue; }
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }

      id = chunk.id || id;
      usage = chunk.usage || usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;

      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta || {};

      if (delta.content)           { content += delta.content; process.stdout.write('.'); }
      if (delta.reasoning_content) { reasoning += delta.reasoning_content; process.stdout.write('·'); }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id)                      toolCalls[idx].id = tc.id;
          if (tc.type)                    toolCalls[idx].type = tc.type;
          if (tc.function?.name)          toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments)     toolCalls[idx].function.arguments += tc.function.arguments;
        }
        process.stdout.write('T');
      }
    }
  }
  console.log(`${CLR.reset}`);

  const toolCallsArr = Object.keys(toolCalls).length
    ? Object.values(toolCalls)
    : undefined;

  return {
    id,
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: {
        role: 'assistant',
        content: toolCallsArr ? null : content,
        reasoning_content: reasoning || undefined,
        tool_calls: toolCallsArr
      }
    }],
    usage
  };
}

// ── Agent loop ─────────────────────────────────────────────────────────────────
async function runAgentLoop(task) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: task }
  ];

  box(`Kilo Agent Simulator  (model: ${MODEL}, stream: ${USE_STREAM})`, CLR.cyan);
  console.log(`${CLR.bold}Task:${CLR.reset} ${task}\n`);

  let totalToolCalls = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    box(`Round ${round}  (${messages.length} messages in context)`, CLR.yellow);

    let result;
    try {
      result = USE_STREAM ? await callCompletionStream(messages) : await callCompletion(messages);
    } catch (err) {
      console.error(`${CLR.red}[ERROR] API call failed: ${err.message}${CLR.reset}`);
      break;
    }

    const choice = result.choices[0];
    const msg    = choice.message;
    const finish = choice.finish_reason;

    console.log(`${CLR.bold}finish_reason:${CLR.reset} ${
      finish === 'tool_calls' ? CLR.green + finish : CLR.magenta + finish
    }${CLR.reset}`);

    if (msg.reasoning_content) {
      console.log(`${CLR.dim}reasoning (${msg.reasoning_content.length} chars):${CLR.reset} ${msg.reasoning_content.slice(0, 200)}...`);
    }

    if (msg.content) {
      console.log(`${CLR.bold}content:${CLR.reset} ${msg.content.slice(0, 400)}${msg.content.length > 400 ? '...' : ''}`);
    }

    // ── Case 1: model wants to call tools ────────────────────────────────────
    if (finish === 'tool_calls' && msg.tool_calls?.length) {
      console.log(`\n${CLR.green}Tool calls (${msg.tool_calls.length}):${CLR.reset}`);

      // Push assistant turn
      messages.push({
        role:       'assistant',
        content:    msg.content ?? null,
        tool_calls: msg.tool_calls
      });

      // Execute each tool and push results
      for (const tc of msg.tool_calls) {
        let args;
        try   { args = JSON.parse(tc.function.arguments); }
        catch { args = {}; }

        console.log(`  ${CLR.cyan}→ ${tc.function.name}(${JSON.stringify(args)})${CLR.reset}`);
        const toolResult = executeTool(tc.function.name, args);
        const preview = toolResult.slice(0, 200).replace(/\n/g, '↵');
        console.log(`  ${CLR.dim}← ${preview}${toolResult.length > 200 ? '...' : ''}${CLR.reset}`);

        messages.push({
          role:         'tool',
          tool_call_id: tc.id,
          name:         tc.function.name,
          content:      toolResult
        });

        totalToolCalls++;
      }

      continue; // next round
    }

    // ── Case 2: model stopped (no more tool calls) ────────────────────────────
    box('Agent finished', CLR.magenta);
    console.log(`${CLR.bold}Total tool calls made:${CLR.reset} ${totalToolCalls}`);
    console.log(`${CLR.bold}Total rounds:${CLR.reset} ${round}`);
    if (result.usage) {
      console.log(`${CLR.bold}Usage:${CLR.reset}`, result.usage);
    }

    if (totalToolCalls === 0) {
      console.log(`\n${CLR.red}⚠  Model never called any tools — responded directly with text.${CLR.reset}`);
    } else if (finish === 'stop') {
      console.log(`\n${CLR.green}✓  Agent completed naturally (finish_reason: stop).${CLR.reset}`);
    } else {
      console.log(`\n${CLR.yellow}⚠  Agent stopped with finish_reason: ${finish}${CLR.reset}`);
    }

    console.log(`\n${CLR.bold}Final answer:${CLR.reset}\n${msg.content ?? '(empty)'}\n`);
    return;
  }

  console.log(`\n${CLR.red}⚠  Reached MAX_ROUNDS (${MAX_ROUNDS}) without finishing.${CLR.reset}`);
  console.log(`   Total tool calls made: ${totalToolCalls}`);
}

// ── Entry point ────────────────────────────────────────────────────────────────
const task = process.argv.slice(2).join(' ') ||
  'Step 1: list the files in the current directory. ' +
  'Step 2: read the file src/index.js. ' +
  'Step 3: read the file src/deepseek-client.js. ' +
  'Step 4: summarise what each file does in one sentence each.';

runAgentLoop(task).catch(err => {
  console.error(`${CLR.red}Fatal: ${err.message}${CLR.reset}`);
  process.exit(1);
});
