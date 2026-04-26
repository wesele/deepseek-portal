/**
 * Complex vibe-coding stress test
 *
 * Simulates a realistic agentic coding session in Chinese that exercises:
 *   - Multi-step planning and execution (5-10+ tool calls)
 *   - File reads → write new code with Chinese comments
 *   - Test run failure → model diagnoses and fixes → re-run passes
 *   - Multiple tool calls batched in one round
 *   - Long / special-character tool results
 *   - Streaming mode (STREAM=1)
 *
 * Usage:
 *   node test-vibe-coding.js          # non-streaming
 *   STREAM=1 node test-vibe-coding.js # streaming
 *   MODEL=expert_think node test-vibe-coding.js
 */

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const BASE_URL   = process.env.BASE_URL   || 'http://localhost:3000';
const MODEL      = process.env.MODEL      || 'expert';
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || '15');
const USE_STREAM = process.env.STREAM === '1';
const TOKEN      = process.env.DEEPSEEK_TOKEN;

if (!TOKEN) { console.error('[ERROR] DEEPSEEK_TOKEN not set.'); process.exit(1); }

// ── Task ─────────────────────────────────────────────────────────────────────
const TASK = `\
你是一个资深 Node.js 工程师。请用中文完成以下 vibe coding 任务，每一步都必须调用对应工具：

【任务】为 DeepSeek Portal 项目新增「请求统计」功能模块。

【具体步骤，必须全部完成】
1. 列出 src/ 目录下的文件，了解现有结构
2. 读取 src/index.js，分析 Express 路由与中间件
3. 读取 src/deepseek-client.js，了解客户端实现细节
4. 创建新文件 src/stats.js（实现请求统计：记录每个 model 的调用次数、总 prompt_tokens、总 completion_tokens）
5. 修改 src/index.js，在 /v1/chat/completions 成功响应时调用统计模块，并新增 GET /v1/stats 端点
6. 运行测试（run_tests），查看结果
7. 若测试失败，根据报错信息修复 src/stats.js，然后再次运行测试
8. 所有测试通过后，用中文输出完整实现总结（包含 src/stats.js 的完整代码）

注意：代码注释必须使用中文。不要跳过任何步骤。`;

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM = `\
你是一个专业的 AI 编程助手，擅长 Node.js 和 Express 开发。

你的工作方式：
1. 将任务拆分为明确的步骤
2. 每个步骤调用对应工具，不跳步，不猜测
3. 根据工具返回结果决定下一步
4. 遇到测试失败必须分析原因并修复，不能直接放弃
5. 完成所有步骤后才给最终回答

所有工具调用和代码注释请使用中文。`;

// ── Tools ─────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出指定目录下的文件和子目录',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径（相对于项目根目录）' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件的完整内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对于项目根目录）' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或覆盖写入文件内容',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: '目标文件路径' },
          content: { type: 'string', description: '要写入的完整内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_tests',
      description: '运行项目测试套件，返回测试结果',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: '可选：只运行匹配此字符串的测试文件' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: '在项目代码中搜索关键词或正则表达式',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索关键词或正则' },
          path:    { type: 'string', description: '搜索范围目录（默认 src/）' }
        },
        required: ['pattern']
      }
    }
  }
];

// ── Stateful tool executor ────────────────────────────────────────────────────
let testRunCount  = 0;
const writtenFiles = {};
const toolCallLog  = [];

function executeTool(name, args) {
  toolCallLog.push({ name, args: JSON.stringify(args).slice(0, 120) });

  try {
    // ── list_files ────────────────────────────────────────────────────────
    if (name === 'list_files') {
      const dir = args.path || '.';
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map(e => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`).join('\n') || '（空目录）';
    }

    // ── read_file ─────────────────────────────────────────────────────────
    if (name === 'read_file') {
      // Check if we wrote this file in the session first
      if (writtenFiles[args.path]) {
        return `[本次会话写入的内容]\n${writtenFiles[args.path]}`;
      }
      const content = fs.readFileSync(args.path, 'utf8');
      // Truncate very large files to save tokens (8000 chars covers most source files)
      return content.length > 8000
        ? content.slice(0, 8000) + '\n... [内容过长，已截断]'
        : content;
    }

    // ── write_file ────────────────────────────────────────────────────────
    if (name === 'write_file') {
      if (!args.path || !args.content) return '[错误] 缺少 path 或 content 参数';
      writtenFiles[args.path] = args.content;
      const lines = args.content.split('\n').length;
      return `✓ 文件已写入: ${args.path}（${args.content.length} 字节，${lines} 行）`;
    }

    // ── run_tests ─────────────────────────────────────────────────────────
    if (name === 'run_tests') {
      testRunCount++;
      if (testRunCount === 1) {
        // First run: simulate failure - stats.trackRequest not a function
        return [
          'FAIL  src/stats.js',
          '',
          '● Stats 模块 › 应正确记录请求统计',
          '',
          '  TypeError: stats.trackRequest is not a function',
          '  at recordStats (src/index.js:45:10)',
          '  at Layer.handle [as handle_request] (express/lib/router/layer.js:95:5)',
          '',
          '● Stats 模块 › 应返回正确的 JSON 格式',
          '',
          '  TypeError: Cannot read properties of undefined (reading \'calls\')',
          '  at Object.<anonymous> (__tests__/stats.test.js:22:28)',
          '',
          'Tests: 2 failed, 4 passed, 6 total',
          'Time:  1.834s'
        ].join('\n');
      }
      if (testRunCount === 2) {
        // Second run: still failing but different error (model may need another fix)
        if (!writtenFiles['src/stats.js'] ||
            !writtenFiles['src/stats.js'].includes('trackRequest')) {
          return [
            'FAIL  src/stats.js',
            '',
            '● Stats 模块 › 应正确记录请求统计',
            '',
            '  TypeError: stats.trackRequest is not a function',
            '  （stats.js 中未导出 trackRequest 函数）',
            '',
            'Tests: 1 failed, 5 passed, 6 total',
            'Time:  1.201s'
          ].join('\n');
        }
      }
      // All subsequent runs pass
      return [
        'PASS  src/stats.js',
        'PASS  __tests__/openai-compatibility.test.js',
        'PASS  __tests__/app.test.js',
        '',
        'Tests: 6 passed, 6 total',
        'Snapshots: 0 total',
        `Time: 2.${Math.floor(Math.random()*9)+1}s`,
        '',
        '✓ 所有测试通过'
      ].join('\n');
    }

    // ── search_code ───────────────────────────────────────────────────────
    if (name === 'search_code') {
      const searchDir = args.path || 'src';
      const pattern   = args.pattern || '';
      const results   = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(fullPath); continue; }
          if (!/\.(js|ts|json)$/.test(entry.name)) continue;
          const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
          lines.forEach((line, idx) => {
            if (line.toLowerCase().includes(pattern.toLowerCase())) {
              results.push(`${fullPath}:${idx + 1}: ${line.trim()}`);
            }
          });
        }
      };
      try { walk(searchDir); } catch {}
      return results.length
        ? results.slice(0, 30).join('\n')
        : `未找到匹配 "${pattern}" 的内容`;
    }

    return `[未知工具: ${name}]`;
  } catch (err) {
    return `[工具错误] ${err.message}`;
  }
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function callCompletion(messages) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', stream: false })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function callStream(messages) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', stream: true })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec    = new TextDecoder();
  let buf = '', content = '', reasoning = '', toolCalls = {}, finishReason = null, usage = null, id = '';

  process.stdout.write(`${C.dim}[stream] `);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6).trim();
      if (d === '[DONE]') { process.stdout.write(' [DONE]'); continue; }
      let chunk; try { chunk = JSON.parse(d); } catch { continue; }
      id    = chunk.id || id;
      usage = chunk.usage || usage;
      const ch = chunk.choices?.[0]; if (!ch) continue;
      finishReason = ch.finish_reason || finishReason;
      const delta  = ch.delta || {};
      if (delta.content)           { content   += delta.content;   process.stdout.write('.'); }
      if (delta.reasoning_content) { reasoning += delta.reasoning_content; process.stdout.write('·'); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id)               toolCalls[idx].id = tc.id;
          if (tc.function?.name)   toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
        }
        process.stdout.write('T');
      }
    }
  }
  console.log(C.reset);

  const tca = Object.keys(toolCalls).length ? Object.values(toolCalls) : undefined;
  return {
    id, choices: [{
      index: 0, finish_reason: finishReason,
      message: { role: 'assistant', content: tca ? null : content,
                 reasoning_content: reasoning || undefined, tool_calls: tca }
    }], usage
  };
}

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  red: '\x1b[31m', magenta: '\x1b[35m', blue: '\x1b[34m'
};
const box = (t, c) => {
  const line = '─'.repeat(64);
  console.log(`\n${c}${C.bold}┌${line}┐\n│ ${t}\n└${line}┘${C.reset}`);
};

// ── Validation ────────────────────────────────────────────────────────────────
function validate() {
  box('验证结果 / Validation', C.blue);
  const checks = [
    {
      name: '调用了 list_files',
      ok: toolCallLog.some(t => t.name === 'list_files')
    },
    {
      name: '调用了 read_file (index.js)',
      ok: toolCallLog.some(t => t.name === 'read_file' && t.args.includes('index.js'))
    },
    {
      name: '调用了 read_file (deepseek-client.js)',
      ok: toolCallLog.some(t => t.name === 'read_file' && t.args.includes('deepseek-client'))
    },
    {
      name: '创建了 src/stats.js（write_file）',
      ok: !!writtenFiles['src/stats.js']
    },
    {
      name: 'stats.js 包含 trackRequest 函数',
      ok: (writtenFiles['src/stats.js'] || '').includes('trackRequest')
    },
    {
      name: 'stats.js 包含中文注释',
      ok: /[一-鿿]/.test(writtenFiles['src/stats.js'] || '')
    },
    {
      name: '运行了测试（run_tests）',
      ok: toolCallLog.some(t => t.name === 'run_tests')
    },
    {
      name: '测试失败后继续修复（run_tests ≥ 2次）',
      ok: toolCallLog.filter(t => t.name === 'run_tests').length >= 2
    },
    {
      name: '修改了 src/index.js（write_file）',
      ok: !!writtenFiles['src/index.js']
    }
  ];

  let passed = 0;
  for (const c of checks) {
    const icon = c.ok ? `${C.green}✓` : `${C.red}✗`;
    console.log(`  ${icon} ${c.name}${C.reset}`);
    if (c.ok) passed++;
  }

  console.log(`\n${C.bold}通过 ${passed}/${checks.length} 项验证${C.reset}`);

  if (passed === checks.length) {
    console.log(`${C.green}${C.bold}🎉 全部通过！vibe coding 功能完整可用${C.reset}`);
  } else if (passed >= checks.length * 0.7) {
    console.log(`${C.yellow}⚠  部分通过，存在遗漏步骤${C.reset}`);
  } else {
    console.log(`${C.red}✗  多项失败，adapter 仍有问题${C.reset}`);
  }

  console.log(`\n${C.dim}── 工具调用明细 (${toolCallLog.length} 次) ──${C.reset}`);
  toolCallLog.forEach((t, i) =>
    console.log(`  ${C.dim}[${i+1}] ${t.name}  ${t.args}${C.reset}`));

  if (writtenFiles['src/stats.js']) {
    console.log(`\n${C.dim}── src/stats.js（模拟写入内容预览） ──${C.reset}`);
    console.log(writtenFiles['src/stats.js'].slice(0, 600));
    if (writtenFiles['src/stats.js'].length > 600) console.log('... [截断]');
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────
async function run() {
  box(`Vibe Coding 压力测试  model=${MODEL}  stream=${USE_STREAM}`, C.cyan);
  console.log(`${C.bold}任务:${C.reset} ${TASK.slice(0, 200)}...\n`);

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user',   content: TASK }
  ];

  let totalTools = 0;
  const call = USE_STREAM ? callStream : callCompletion;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    box(`Round ${round}  (${messages.length} msgs  工具调用总计 ${totalTools} 次)`, C.yellow);

    let result;
    try { result = await call(messages); }
    catch (err) { console.error(`${C.red}[ERROR] ${err.message}${C.reset}`); break; }

    const choice = result.choices[0];
    const msg    = choice.message;
    const finish = choice.finish_reason;

    const finColor = finish === 'tool_calls' ? C.green : C.magenta;
    console.log(`${C.bold}finish_reason:${C.reset} ${finColor}${finish}${C.reset}`);

    if (msg.reasoning_content) {
      console.log(`${C.dim}[thinking] ${msg.reasoning_content.slice(0, 150).replace(/\n/g,'↵')}...${C.reset}`);
    }
    if (msg.content) {
      const preview = msg.content.slice(0, 300).replace(/\n/g, '↵');
      console.log(`${C.bold}content:${C.reset} ${preview}${msg.content.length > 300 ? '...' : ''}`);
    }

    if (finish === 'tool_calls' && msg.tool_calls?.length) {
      console.log(`\n${C.green}工具调用 (${msg.tool_calls.length} 个):${C.reset}`);
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        let args; try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        const toolResult = executeTool(tc.function.name, args);
        totalTools++;

        const preview = toolResult.slice(0, 200).replace(/\n/g, '↵');
        console.log(`  ${C.cyan}→ ${tc.function.name}(${tc.function.arguments.slice(0,80)})${C.reset}`);
        console.log(`  ${C.dim}← ${preview}${toolResult.length > 200 ? '...' : ''}${C.reset}`);

        messages.push({
          role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: toolResult
        });
      }
      continue;
    }

    // Finished
    box('任务结束', C.magenta);
    console.log(`轮次: ${round}  工具调用: ${totalTools}  测试运行: ${testRunCount}`);
    if (result.usage) console.log('usage:', result.usage);
    console.log(`\n${C.bold}最终回答:${C.reset}\n${(msg.content || '').slice(0, 800)}\n`);
    break;
  }

  validate();
}

run().catch(err => { console.error(C.red + err.message + C.reset); process.exit(1); });
