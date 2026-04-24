const DeepSeekClient = require('./src/deepseek-client');
const client = new DeepSeekClient('dummy');

const input = `<tool_call name="read">\n<parameter name="filePath" string="true">C:\\Code\\Casio2\\index.html</parameter>\n</tool_call>`;

const res = client.parseToolCalls(input);
console.log(JSON.stringify(res, null, 2));
