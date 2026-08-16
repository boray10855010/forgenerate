/**
 * AI Image Chat Backend
 *
 * Frontend -> Express -> OpenRouter -> MCP -> Stability Matrix
 */

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENROUTER_BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'mistralai/mistral-nemo';
const MCP_SERVER_PATH = process.env.MCP_SERVER_PATH || path.resolve(__dirname, '../../mcp-server-stability');
const PORT = process.env.PORT || 3001;
const MAX_HISTORY = 50;

let mcpProcess = null;
let mcpReady = false;
const pendingRequests = new Map();

function startMCPServer() {
  return new Promise((resolve, reject) => {
    try {
      const distPath = path.join(MCP_SERVER_PATH, 'dist', 'index.js');
      const srcPath = path.join(MCP_SERVER_PATH, 'src', 'index.ts');
      const cmd = fs.existsSync(distPath) ? 'node' : 'npx';
      const args = fs.existsSync(distPath) ? [distPath] : ['tsx', srcPath];

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
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { handleMCPMessage(JSON.parse(line)); }
          catch { console.log(`[MCP:stdout] ${line}`); }
        }
      });

      mcpProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (!msg) return;
        console.log(`[MCP:stderr] ${msg}`);
        if (msg.includes('running on stdio') || msg.includes('Server running')) {
          mcpReady = true;
          resolve();
        }
      });

      mcpProcess.on('close', (code) => {
        console.log(`[MCP] Process exited with code ${code}`);
        mcpReady = false;
        mcpProcess = null;
        for (const { reject: rejectPending } of pendingRequests.values()) {
          rejectPending(new Error('MCP server process exited unexpectedly'));
        }
        pendingRequests.clear();
      });
      mcpProcess.on('error', reject);

      setTimeout(() => {
        if (!mcpReady) {
          console.log('[MCP] No ready message received, but continuing...');
          mcpReady = true;
          resolve();
        }
      }, 15000);
    } catch (error) { reject(error); }
  });
}

function sendMCPMessage(message) {
  if (!mcpProcess?.stdin) throw new Error('MCP server is not running');
  mcpProcess.stdin.write(JSON.stringify(message) + '\n');
}

function handleMCPMessage(message) {
  if (message.id !== undefined && pendingRequests.has(message.id)) {
    const { resolve } = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    resolve(message.error ? { error: message.error } : (message.result || message));
    return;
  }
  console.log(`[MCP:message] ${JSON.stringify(message)}`);
}

async function callMCPGenerateImage(params) {
  if (!mcpProcess) await startMCPServer();
  const requestId = uuidv4();
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    try {
      sendMCPMessage({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'generate_image', arguments: params } });
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error);
      return;
    }
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('Image generation timed out after 5 minutes'));
      }
    }, 5 * 60 * 1000);
  });
}

async function* streamOpenRouterChat(messages, tools = null) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const body = {
    model: OPENROUTER_MODEL,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: 4096,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  console.log(`[OpenRouter] model=${OPENROUTER_MODEL}, messages=${messages.length}, tools=${!!tools}`);
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:5500',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'AI Image Chat',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenRouter API error (${response.status}): ${await response.text()}`);

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
      if (!trimmed.startsWith('data: ')) continue;
      try { yield JSON.parse(trimmed.slice(6)); }
      catch { console.warn('[OpenRouter] Failed to parse SSE line:', trimmed.substring(0, 120)); }
    }
  }
}

const IMAGE_GENERATION_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image using Stable Diffusion. Use this when the user asks to create, generate, draw, or make an image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed English Stable Diffusion prompt.' },
        negative_prompt: { type: 'string', description: 'Things to avoid in the image.' },
        width: { type: 'number', default: 512 },
        height: { type: 'number', default: 512 },
        steps: { type: 'number', default: 20 },
      },
      required: ['prompt'],
    },
  },
};

const SYSTEM_PROMPT = `You are a helpful AI assistant with the ability to generate images.
Use the generate_image tool when the user asks you to create, generate, draw, make, or visually depict an image.
Translate non-English image requests into a detailed English Stable Diffusion prompt before calling the tool.
You may improve the prompt while preserving the user's intent.`;

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const conversations = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { message, session_id } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Message is required' });
    const sessionId = session_id || 'default';
    if (!conversations.has(sessionId)) conversations.set(sessionId, [{ role: 'system', content: SYSTEM_PROMPT }]);
    const history = conversations.get(sessionId);
    history.push({ role: 'user', content: message });
    while (history.length > MAX_HISTORY) history.splice(1, 1);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let currentMessages = [...history];
    let finalAssistantMessage = '';

    for (let round = 0; round < 5; round++) {
      let roundText = '';
      const toolCalls = new Map();
      for await (const chunk of streamOpenRouterChat(currentMessages, [IMAGE_GENERATION_TOOL])) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          roundText += delta.content;
          res.write(`data: ${JSON.stringify({ type: 'text', content: delta.content })}\n\n`);
        }
        for (const tc of delta.tool_calls || []) {
          const index = tc.index ?? 0;
          const existing = toolCalls.get(index) || { id: '', name: '', arguments: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCalls.set(index, existing);
        }
      }

      if (toolCalls.size === 0) {
        finalAssistantMessage += roundText;
        history.push({ role: 'assistant', content: finalAssistantMessage });
        break;
      }

      const calls = [...toolCalls.values()];
      currentMessages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: calls.map((tc) => ({
          id: tc.id || `call_${uuidv4().slice(0, 8)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      for (let i = 0; i < calls.length; i++) {
        const tc = calls[i];
        const toolCallId = currentMessages[currentMessages.length - 1].tool_calls[i].id;
        res.write(`data: ${JSON.stringify({ type: 'tool_call', tool: tc.name, arguments: tc.arguments })}\n\n`);
        let parsedArgs;
        try { parsedArgs = JSON.parse(tc.arguments); }
        catch { parsedArgs = { prompt: tc.arguments }; }

        let toolResult;
        try {
          const result = await callMCPGenerateImage(parsedArgs);
          if (result.error) {
            toolResult = `Error: ${result.error.message || JSON.stringify(result.error)}`;
            res.write(`data: ${JSON.stringify({ type: 'tool_result', success: false, error: toolResult })}\n\n`);
          } else {
            const textParts = result.content?.filter((c) => c.type === 'text').map((c) => c.text) || [];
            toolResult = textParts.join('\n') || 'Image generated successfully.';
            for (const img of result.content?.filter((c) => c.type === 'image') || []) {
              res.write(`data: ${JSON.stringify({ type: 'image', data: img.data, mimeType: img.mimeType })}\n\n`);
            }
            res.write(`data: ${JSON.stringify({ type: 'tool_result', success: true, result: toolResult })}\n\n`);
          }
        } catch (error) {
          toolResult = `Tool execution error: ${error.message}`;
          res.write(`data: ${JSON.stringify({ type: 'tool_result', success: false, error: toolResult })}\n\n`);
        }
        currentMessages.push({ role: 'tool', tool_call_id: toolCallId, content: toolResult });
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[Server] Error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    }
  }
});

app.post('/api/clear', (req, res) => {
  const sessionId = req.body.session_id || 'default';
  conversations.set(sessionId, [{ role: 'system', content: SYSTEM_PROMPT }]);
  res.json({ success: true });
});

app.get('/api/models', (req, res) => {
  res.json({ models: [{ id: OPENROUTER_MODEL, object: 'model', provider: 'OpenRouter' }] });
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', provider: 'OpenRouter', model: OPENROUTER_MODEL, apiKeyConfigured: !!OPENROUTER_API_KEY, mcpReady, conversationsCount: conversations.size, pendingRequests: pendingRequests.size });
});

async function main() {
  console.log('=== AI Image Chat Backend ===');
  console.log(`OpenRouter: ${OPENROUTER_BASE}`);
  console.log(`Model: ${OPENROUTER_MODEL}`);
  console.log(`API key: ${OPENROUTER_API_KEY ? 'configured' : 'MISSING'}`);
  console.log(`MCP Server: ${MCP_SERVER_PATH}`);
  console.log(`Port: ${PORT}`);

  try {
    await startMCPServer();
    console.log('[MCP] Server started successfully');
  } catch (error) {
    console.error('[MCP] Failed to start server:', error.message);
  }

  app.listen(PORT, () => {
    console.log(`\nServer running at http://localhost:${PORT}`);
    if (!OPENROUTER_API_KEY) console.log('WARNING: Set OPENROUTER_API_KEY before chatting.');
    console.log('Make sure Stability Matrix with AUTOMATIC1111 or ComfyUI is running.\n');
  });
}

main().catch(console.error);
