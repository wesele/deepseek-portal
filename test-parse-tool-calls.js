const DeepSeekClient = require('./src/deepseek-client');

const client = new DeepSeekClient('test-token');

console.log('Testing parseToolCalls method...\n');

// Test 1: <tool_calls> with JSON array
const test1 = '<tool_calls>[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Beijing\\"}"}}]</tool_calls>';
const result1 = client.parseToolCalls(test1);
console.log('Test 1 - <tool_calls> with JSON array:');
console.log('  Input:', test1);
console.log('  Result:', JSON.stringify(result1, null, 2));
console.log('  Content:', result1.content);
console.log('  Tool calls:', JSON.stringify(result1.tool_calls, null, 2));
console.log();

// Test 2: <tool_calls> with stringified JSON array (like in test)
const test2 = '<tool_calls>["{\\"id\\":\\"call_1\\",\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"get_weather\\",\\"arguments\\":\\"{\\"location\\":\\"Beijing\\"}\\"}}"]</tool_calls>';
const result2 = client.parseToolCalls(test2);
console.log('Test 2 - <tool_calls> with stringified JSON array:');
console.log('  Input:', test2);
console.log('  Result:', JSON.stringify(result2, null, 2));
console.log('  Content:', result2.content);
console.log('  Tool calls:', JSON.stringify(result2.tool_calls, null, 2));
console.log();

// Test 3: Mixed content with tool calls
const test3 = 'I will check the weather for you.<tool_calls>[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Beijing\\"}"}}]</tool_calls>';
const result3 = client.parseToolCalls(test3);
console.log('Test 3 - Mixed content with tool calls:');
console.log('  Input:', test3);
console.log('  Result:', JSON.stringify(result3, null, 2));
console.log('  Content:', result3.content);
console.log('  Tool calls:', JSON.stringify(result3.tool_calls, null, 2));
console.log();

// Test 4: Multiple tool calls
const test4 = '<tool_calls>[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Beijing\\"}"}},{"id":"call_2","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Shanghai\\"}"}}]</tool_calls>';
const result4 = client.parseToolCalls(test4);
console.log('Test 4 - Multiple tool calls:');
console.log('  Input:', test4);
console.log('  Result:', JSON.stringify(result4, null, 2));
console.log('  Content:', result4.content);
console.log('  Tool calls:', JSON.stringify(result4.tool_calls, null, 2));
console.log();

// Test 5: No tool calls
const test5 = 'Just a regular response without tool calls.';
const result5 = client.parseToolCalls(test5);
console.log('Test 5 - No tool calls:');
console.log('  Input:', test5);
console.log('  Result:', JSON.stringify(result5, null, 2));
console.log('  Content:', result5.content);
console.log('  Tool calls:', result5.tool_calls);
console.log();
