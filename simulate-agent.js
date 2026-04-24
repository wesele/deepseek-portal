const axios = require('axios');
const { createParser } = require('eventsource-parser');

async function simulateAgentCall() {
  console.log('=== Simulating Video Coding Agent (Cline/Kilo) ===');
  
  const payload = {
    model: 'deepseek-reasoner',
    messages: [
      { role: 'system', content: 'You are a professional coder. Use tools if needed.' },
      { role: 'user', content: 'Write a hello world script and save it using the write_file tool.' }
    ],
    stream: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'write_file',
          description: 'Write content to a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            }
          }
        }
      }
    ]
  };

  try {
    const response = await axios.post('http://localhost:3000/v1/chat/completions', payload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_TOKEN || 'test-token'}`
      },
      responseType: 'stream'
    });

    console.log('Response Status:', response.status);
    console.log('Chunks received:');
    
    let hasReasoning = false;
    let hasContent = false;
    let hasToolCall = false;
    let lastChunk = null;

    const parser = createParser((event) => {
      if (event.data === '[DONE]') {
        console.log('\n[Stream Ended Properly]');
        return;
      }
      
      try {
        const json = JSON.parse(event.data);
        lastChunk = json;
        const delta = json.choices[0].delta;
        
        if (delta.role) console.log(`[Role]: ${delta.role}`);
        if (delta.reasoning_content) {
          hasReasoning = true;
          process.stdout.write('R'); // Reasoning
        }
        if (delta.content) {
          hasContent = true;
          process.stdout.write('C'); // Content
        }
        if (delta.tool_calls) {
          hasToolCall = true;
          console.log('\n[Tool Call Detected]:', JSON.stringify(delta.tool_calls));
        }
        if (json.usage) {
          console.log('\n[Usage]:', JSON.stringify(json.usage));
        }
      } catch (e) {
        console.error('\nError parsing chunk:', e.message);
      }
    });

    response.data.on('data', (chunk) => {
      parser.feed(chunk.toString());
    });

    await new Promise((resolve) => response.data.on('end', resolve));

    console.log('\n--- Simulation Summary ---');
    console.log('Reasoning streamed:', hasReasoning);
    console.log('Content streamed:', hasContent);
    console.log('Tool calls found:', hasToolCall);
    if (lastChunk && lastChunk.usage) {
        console.log('Final usage present: Yes');
    } else {
        console.warn('Final usage present: No!');
    }

  } catch (error) {
    console.error('Request Failed:', error.response ? error.response.status : error.message);
    if (error.response) {
        let body = '';
        error.response.data.on('data', c => body += c);
        error.response.data.on('end', () => console.log('Error Body:', body));
    }
  }
}

simulateAgentCall();
