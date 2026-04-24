function createCompletionResponse(model, messages, response) {
  const message = {
    role: 'assistant',
    content: response.content || ''
  };
  if (response.reasoning_content) {
    message.reasoning_content = response.reasoning_content;
  }
  if (response.tool_calls) {
    message.tool_calls = response.tool_calls;
  }
  return {
    id: response.id || `chatcmpl-${Date.now()}`,
    model: response.model || model,
    object: 'chat.completion',
    choices: response.choices || [{
      index: 0,
      message,
      finish_reason: response.tool_calls ? 'tool_calls' : 'stop'
    }],
    usage: response.usage || {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    },
    created: response.created || Math.floor(Date.now() / 1000)
  };
}

function createCompletionStream(model, messages, stream) {
  return stream;
}

module.exports = {
  createCompletionResponse,
  createCompletionStream
};
