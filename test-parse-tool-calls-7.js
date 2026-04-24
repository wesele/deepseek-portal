const DeepSeekClient = require('./src/deepseek-client');
const client = new DeepSeekClient('dummy');

const input = `Some text.
[{"id":"tc_1","type":"function","function":{"name":"todowrite","arguments":"{\\"todos\\":[]}"}},{"id":"tc_2","type":"function","function":{"name":"ls","arguments":"{\\"dir\\":\\"src\\"`;

const res = client.parseToolCalls(input);
console.log(JSON.stringify(res, null, 2));
