const DeepSeekClient = require('./src/deepseek-client');
const client = new DeepSeekClient('dummy');

const input1 = `This is some text.
[{"id":"tc_1","type":"function","function":{"name":"todowrite","arguments":"{\\"todos\\":[{\\"content\\":\\"Fix keyboard Shift/Alt key conflict with calculator SHIFT/ALPHA modifier\\",\\"status\\":\\"in_progress\\",\\"priority\\":\\"high\\"},{\\"content\\":\\"Fix SHIFT+DEL (INS) and SHIFT+AC (OFF) not working\\",\\"status\\":\\"pending\\",\\"priority\\":\\"high\\"}]`

const res1 = client.parseToolCalls(input1);
console.log('Result:', JSON.stringify(res1, null, 2));
