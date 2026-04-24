# DeepSeek to OpenAI API

一个将DeepSeek API转换为OpenAI兼容格式的适配器，支持完整的OpenAI API功能，包括tool calling。

## 功能特性

- ✅ 完整的OpenAI Chat Completions API兼容
- ✅ 支持流式和非流式响应
- ✅ 支持多轮对话
- ✅ 支持多种模型（default、expert、default_think、expert_think、default_search）
- ✅ 支持tool calling（函数调用）
- ✅ 支持tool_choice参数
- ✅ 支持tool role消息
- ✅ 支持reasoning_content（思考内容）
- ✅ 支持conversation_id（会话ID）
- ✅ 完整的错误处理

## 安装

```bash
npm install
```

## 配置

### 环境变量

创建 `.env` 文件：

```env
DEEPSEEK_TOKEN=your_deepseek_token_here
PORT=3000
HOST=0.0.0.0
```

### 配置选项

- `DEEPSEEK_TOKEN`: DeepSeek API token（必需）
- `PORT`: 服务器端口（默认：3000）
- `HOST`: 服务器主机（默认：0.0.0.0）

## 使用

### 启动服务器

```bash
npm start
```

### API端点

#### Chat Completions

```bash
POST /v1/chat/completions
```

**请求示例：**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_DEEPSEEK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

#### Models

```bash
GET /v1/models
```

**响应示例：**

```json
{
  "object": "list",
  "data": [
    {"id": "default", "object": "model", "owned_by": "deepseek"},
    {"id": "default_think", "object": "model", "owned_by": "deepseek"},
    {"id": "expert", "object": "model", "owned_by": "deepseek"},
    {"id": "expert_think", "object": "model", "owned_by": "deepseek"},
    {"id": "default_search", "object": "model", "owned_by": "deepseek"}
  ]
}
```

#### Health Check

```bash
GET /health
```

## Tool Calling

### 基本用法

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_DEEPSEEK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "What is the weather in Beijing?"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get current weather for a location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "description": "The city name"
              }
            },
            "required": ["location"]
          }
        }
      }
    ]
  }'
```

### 响应示例

```json
{
  "id": "session-id@message-id",
  "model": "default",
  "object": "chat.completion",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"Beijing\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 1,
    "completion_tokens": 25,
    "total_tokens": 26
  },
  "created": 1234567890
}
```

### Tool Role 消息

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_DEEPSEEK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "What is the weather in Beijing?"},
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "call_1",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"Beijing\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "name": "get_weather",
        "content": "{\"temperature\":25,\"unit\":\"C\",\"condition\":\"sunny\"}"
      }
    ]
  }'
```

### Tool Choice 参数

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_DEEPSEEK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_weather",
          "description": "Get weather",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {"type": "string"}
            }
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
```

**tool_choice 选项：**
- `"auto"`: 模型自动决定是否使用工具
- `"none"`: 不使用工具
- `{"type": "function", "function": {"name": "function_name"}}`: 强制使用特定工具

## 模型

| 模型 | 描述 |
|------|------|
| `default` | 默认模型 |
| `default_think` | 默认模型，启用思考功能 |
| `expert` | 专家模型 |
| `expert_think` | 专家模型，启用思考功能 |
| `default_search` | 默认模型，启用搜索功能 |

## 流式响应

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_DEEPSEEK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

## 测试

```bash
# 运行所有测试
npm test

# 运行特定测试
npm test -- __tests__/tool-calling.test.js
```

## 开发

### 项目结构

```
deepseek-to-openai-api/
├── src/
│   ├── index.js              # API服务器
│   ├── deepseek-client.js    # DeepSeek客户端
│   ├── openai-adapter.js     # OpenAI适配器
│   └── challenge.js          # PoW挑战处理
├── __tests__/
│   ├── tool-calling.test.js  # Tool calling测试
│   ├── openai-compatibility.test.js  # OpenAI兼容性测试
│   ├── server.test.js        # 服务器测试
│   ├── app.test.js           # 应用测试
│   └── challenge.test.js     # PoW挑战测试
├── .env                     # 环境变量
├── package.json
└── README.md
```

### 贡献

欢迎提交问题和拉取请求！

## 许可证

MIT

## 支持

如有问题，请提交issue或联系项目维护者。
