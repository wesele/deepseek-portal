const DeepSeekClient = require('./src/deepseek-client');
const client = new DeepSeekClient('dummy');

function test(name, text) {
  console.log('--- ' + name + ' ---');
  const res = client.parseToolCalls(text);
  console.log('Content:', JSON.stringify(res.content));
  console.log('Tool calls:', JSON.stringify(res.tool_calls, null, 2));
}

test('Standard', 'Here is the tool:\n<tool_calls>\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]\n</tool_calls>');
test('Missing close', 'Here is the tool:\n<tool_calls>\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]');
test('Markdown array', 'Here is the tool:\n```json\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]\n```');
test('Markdown object', 'Here is the tool:\n```json\n{"tool_calls": [{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]}\n```');
test('Naked array', 'Here is the tool:\n[{"id":"tc_1", "type":"function", "function":{"name":"ls", "arguments":"{}"}}]');
