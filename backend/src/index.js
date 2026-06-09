/**
 * AI Image Chat Backend
 * 
 * Connects:
 * 1. Frontend chat (browser) -> Express server
 * 2. Express -> LM Studio (OpenAI-compatible API)
 * 3. MCP Stability Matrix Server (stdio) for image generation
 * 
 * Flow:
 * 1. User sends message from frontend
 * 2. Backend forwards to LM Studio with tool definitions
 * 3. LM Studio may respond with text or a tool call request
 * 4. If tool call, backend asks MCP server to generate image
 * 5. Result sent back to LM Studio for final response
 * 6. Final response streamed to frontend
 */

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ============================================================
// Configuration
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// LM Studio runs at http://localhost:1234 by default
const LM_STUDIO_BASE = process.env.LM_STUDIO_BASE || 'http://localhost:1234';
const LM_MODEL = process.env.LM_MODEL || ''; // Empty = let LM Studio decide

// MCP server path
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || path.resolve(__dirname, '../../mcp-server-stability');

// Server config
const PORT = process.env.PORT || 3001;

// Conversation history (keep last N messages)
const MAX_HISTORY = 50;

// ============================================================
// State
// ============================================================

let mcpProcess = null;
let mcpReady = false;
let pendingRequests = new Map(); // requestId -> { resolve, reject }

// ============================================================
// MCP Server Management
// ============================================================

/**
 * Start the MCP Stability Matrix server as a child process
 */
function startMCPServer() {
  return new Promise((resolve, reject) => {
    try {
      // Check if we should use the built version or run via ts-node / tsx
      const distPath = path.join(MCP_SERVER_PATH, 'dist', 'index.js');
      const srcPath = path.join(MCP_SERVER_PATH, 'src', 'index.ts');

      let cmd;
      let args;

      if (fs.existsSync(distPath)) {
        cmd = 'node';
        args = [distPath];
      } else {
        // Use npx tsx to run TypeScript directly
        cmd = 'npx';
        args = ['tsx', srcPath];
      }

      console.log(`[MCP] Starting server: ${cmd} ${args.join(' ')}`);

      mcpProcess = spawn(cmd, args, {
        cwd: MCP_SERVER_PATH,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          STABILITY_API_BASE: process.env.STABILITY_API_BASE || 'http://localhost:7860',
          STABILITY_API_MODE: process.env.STABILITY_API_MODE || 'auto1111',
          OUTPUT_DIR: process.env.OUTPUT_DIR || path.resolve(__dirname, '../../outputs'),
        },
      });

      let buffer = '';

      mcpProcess.stdout.on('data', (data) => {
        const chunk = data.toString();
        buffer += chunk;

        // Try to parse complete JSON-RPC messages (separated by newlines)
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              handleMCPMessage(message);
            } catch (e) {
              // Not JSON - might be a log line on stderr
              console.log(`[MCP:stdout] ${line}`);
            }
          }
        }
      });

      mcpProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[MCP:stderr] ${msg}`);
          if (msg.includes('running on stdio') || msg.includes('Server running')) {
            mcpReady = true;
            resolve();
          }
        }
      });

      mcpProcess.on('close', (code) => {
        console.log(`[MCP] Process exited with code ${code}`);
        mcpReady = false;
        mcpProcess = null;
        // Reject all pending requests
        for (const [id, { reject }] of pendingRequests) {
          reject(new Error('MCP server process exited unexpectedly'));
        }
        pendingRequests.clear();
      });

      mcpProcess.on('error', (err) => {
        console.error(`[MCP] Process error:`, err);
        reject(err);
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        if (!mcpReady) {
          // Even if we don't get the ready message, try to continue
          console.log('[MCP] No ready message received, but continuing...');
          mcpReady = true;
          resolve();
        }
      }, 15000);

    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Send a JSON-RPC message to the MCP server
 */
function sendMCPMessage(message) {
  if (!mcpProcess || !mcpProcess.stdin) {
    throw new Error('MCP server is not running');
  }
  const json = JSON.stringify(message) + '\n';
  mcpProcess.stdin.write(json);
}

/**
 * Handle incoming JSON-RPC messages from MCP server
 */
function handleMCPMessage(message) {
  // Check if this is a response to a pending request
  if (message.id !== undefined && pendingRequests.has(message.id)) {
    const { resolve } = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);

    if (message.error) {
      resolve({ error: message.error });
    } else {
      resolve(message.result || message);
    }
    return;
  }

  // Log unhandled messages
  console.log(`[MCP:message] ${JSON.stringify(message)}`);
}

/**
 * Call the MCP server's generate_image tool
 */
async function callMCPGenerateImage(params) {
  const requestId = uuidv4();

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });

    const message = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: 'generate_image',
        arguments: params,
      },
    };

    try {
      sendMCPMessage(message);
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error);
    }

    // Timeout after 5 minutes (image generation can be slow)
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('Image generation timed out after 5 minutes'));
      }
    }, 5 * 60 * 1000);
  });
}

// ============================================================
// LM Studio API Calls
// ============================================================

/**
 * Get the list of available models from LM Studio
 */
async function getLMModels() {
  try {
    const response = await fetch(`${LM_STUDIO_BASE}/v1/models`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error('[LM] Failed to get models:', error.message);
    return [];
  }
}

/**
 * Send a chat completion request to LM Studio with tool support
 */
async function* streamLMStudioChat(messages, tools = null) {
  const url = `${LM_STUDIO_BASE}/v1/chat/completions`;

  const body = {
    model: LM_MODEL || undefined,
    messages: messages,
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  console.log(`[LM] Sending request with ${messages.length} messages, tools: ${!!tools}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LM Studio API error (${response.status}): ${errorText}`);
  }

  // Parse the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;

      if (trimmed.startsWith('data: ')) {
        try {
          const jsonData = JSON.parse(trimmed.slice(6));
          yield jsonData;
        } catch (e) {
          // Skip malformed JSON
          console.warn('[LM] Failed to parse SSE line:', trimmed.substring(0, 100));
        }
      }
    }
  }
}

// ============================================================
// Tool Definitions
// ============================================================

const IMAGE_GENERATION_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image using Stable Diffusion. Use this when the user asks you to create, generate, or draw an image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed text description of the image to generate. Should be in English for best results.',
        },
        negative_prompt: {
          type: 'string',
          description: 'Things to avoid in the image',
        },
        width: {
          type: 'number',
          description: 'Image width (default: 512, must be multiple of 64)',
          default: 512,
        },
        height: {
          type: 'number',
          description: 'Image height (default: 512, must be multiple of 64)',
          default: 512,
        },
        steps: {
          type: 'number',
          description: 'Quality steps (20-50, higher = better but slower)',
          default: 20,
        },
      },
      required: ['prompt'],
    },
  },
};

// System prompt that tells the LLM about its image generation capability
const SYSTEM_PROMPT = `You are a helpful AI assistant with the ability to generate images.

You have access to a \`generate_image\` tool that creates images using Stable Diffusion.

WHEN TO USE THE TOOL:
- When the user asks you to create, generate, draw, or make an image
- When the user describes a scene they want to see
- When the user asks for a visual representation of something

HOW TO USE IT:
- Call the \`generate_image\` function with a detailed English prompt
- The prompt should describe what you want to see in detail
- You can optionally specify width, height, and other parameters

IMPORTANT:
- When the user asks for an image in a language other than English, translate the prompt to English before sending it
- After generating, you'll receive the result and can show it to the user
- You can enhance/improve the user's prompt to get better results`;

// ============================================================
// Express Server
// ============================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Store conversation histories: sessionId -> messages[]
const conversations = new Map();

/**
 * POST /api/chat - Send a message and get a streamed response
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, session_id } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }

    const sessionId = session_id || 'default';

    // Get or create conversation history
    if (!conversations.has(sessionId)) {
      conversations.set(sessionId, [
        { role: 'system', content: SYSTEM_PROMPT },
      ]);
    }

    const history = conversations.get(sessionId);

    // Add user message
    history.push({ role: 'user', content: message });

    // Trim history if needed
    while (history.length > MAX_HISTORY) {
      // Keep the system prompt
      const systemMsg = history[0];
      history.splice(1, 1);
      history[0] = systemMsg;
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let assistantMessage = '';

    // Main conversation loop - we may need multiple rounds for tool calls
    let currentMessages = [...history];

    for (let round = 0; round < 5; round++) { // Max 5 tool call rounds
      const stream = streamLMStudioChat(currentMessages, [IMAGE_GENERATION_TOOL]);

      let hasToolCall = false;
      let toolCallData = null;

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;

        if (!delta) continue;

        // Check for tool calls
        if (delta.tool_calls) {
          hasToolCall = true;
          for (const tc of delta.tool_calls) {
            if (tc.function?.name) {
              toolCallData = toolCallData || { name: tc.function.name, arguments: '' };
              toolCallData.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCallData = toolCallData || { name: '', arguments: '' };
              toolCallData.arguments += tc.function.arguments;
            }
          }
        }

        // Handle text content
        if (delta.content) {
          assistantMessage += delta.content;
          // Stream to client
          res.write(`data: ${JSON.stringify({ type: 'text', content: delta.content })}\n\n`);
        }
      }

      // If there was a tool call, execute it
      if (hasToolCall && toolCallData) {
        // Stream the tool call notification
        res.write(`data: ${JSON.stringify({ type: 'tool_call', tool: toolCallData.name, arguments: toolCallData.arguments })}\n\n`);

        console.log(`[Tool] Calling ${toolCallData.name} with arguments: ${toolCallData.arguments}`);

        // Add assistant message with tool call to history
        currentMessages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `call_${uuidv4().slice(0, 8)}`,
            type: 'function',
            function: {
              name: toolCallData.name,
              arguments: toolCallData.arguments,
            },
          }],
        });

        // Parse arguments
        let parsedArgs;
        try {
          parsedArgs = JSON.parse(toolCallData.arguments);
        } catch (e) {
          parsedArgs = { prompt: toolCallData.arguments };
        }

        // Execute via MCP
        try {
          const result = await callMCPGenerateImage(parsedArgs);

          let toolResult;
          if (result.error) {
            toolResult = `Error: ${result.error.message || JSON.stringify(result.error)}`;
            res.write(`data: ${JSON.stringify({ type: 'tool_result', success: false, error: toolResult })}\n\n`);
          } else {
            // Extract text and image contents
            const textParts = result.content
              ?.filter(c => c.type === 'text')
              .map(c => c.text) || [];
            const imageParts = result.content
              ?.filter(c => c.type === 'image')
              .map(c => ({
                type: 'image',
                data: c.data.substring(0, 100) + '...', // Truncate for display
              })) || [];

            toolResult = textParts.join('\n');

            if (imageParts.length > 0) {
              // Send image data to frontend
              for (const img of result.content.filter(c => c.type === 'image')) {
                res.write(`data: ${JSON.stringify({ type: 'image', data: img.data, mimeType: img.mimeType })}\n\n`);
              }
            }

            res.write(`data: ${JSON.stringify({ type: 'tool_result', success: true, result: toolResult, imageCount: imageParts.length })}\n\n`);
          }

          // Add tool result to conversation
          currentMessages.push({
            role: 'tool',
            tool_call_id: `call_${uuidv4().slice(0, 8)}`,
            content: toolResult,
          });

          // Continue the loop - LM Studio will generate a follow-up response

        } catch (error) {
          const errorMsg = `Tool execution error: ${error.message}`;
          res.write(`data: ${JSON.stringify({ type: 'tool_result', success: false, error: errorMsg })}\n\n`);

          currentMessages.push({
            role: 'tool',
            tool_call_id: `call_${uuidv4().slice(0, 8)}`,
            content: errorMsg,
          });
        }
      } else {
        // No tool call - this is the final response
        // Add to conversation history
        history.push({ role: 'assistant', content: assistantMessage });
        break;
      }
    }

    // Signal completion
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (error) {
    console.error('[Server] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
});

/**
 * POST /api/clear - Clear conversation history
 */
app.post('/api/clear', (req, res) => {
  const { session_id } = req.body;
  const sessionId = session_id || 'default';

  if (conversations.has(sessionId)) {
    conversations.set(sessionId, [
      { role: 'system', content: SYSTEM_PROMPT },
    ]);
  }

  res.json({ success: true });
});

/**
 * GET /api/models - List available models
 */
app.get('/api/models', async (req, res) => {
  try {
    const models = await getLMModels();
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/status - Health check
 */
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    mcpReady,
    conversationsCount: conversations.size,
    pendingRequests: pendingRequests.size,
  });
});

// ============================================================
// Start Server
// ============================================================

async function main() {
  console.log('=== AI Image Chat Backend ===');
  console.log(`LM Studio: ${LM_STUDIO_BASE}`);
  console.log(`MCP Server: ${MCP_SERVER_PATH}`);
  console.log(`Port: ${PORT}`);

  // Start MCP server
  console.log('[MCP] Starting Stability Matrix MCP server...');
  try {
    await startMCPServer();
    console.log('[MCP] Server started successfully');
  } catch (error) {
    console.error('[MCP] Failed to start server:', error.message);
    console.log('[MCP] Will retry on first image generation request');
  }

  // Start Express
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log('📝 API endpoints:');
    console.log(`   POST http://localhost:${PORT}/api/chat  - Chat with AI`);
    console.log(`   POST http://localhost:${PORT}/api/clear - Clear history`);
    console.log(`   GET  http://localhost:${PORT}/api/status - Health check`);
    console.log(`   GET  http://localhost:${PORT}/api/models - List LM models`);
    console.log('\n⚠️  Make sure LM Studio is running and a model is loaded!');
    console.log('⚠️  Make sure Stability Matrix with AUTOMATIC1111 or ComfyUI is running!\n');
  });
}

main().catch(console.error);