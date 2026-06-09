/**
 * AI Image Chat - Frontend JavaScript
 * 
 * Handles:
 * - Chat message display
 * - SSE streaming from backend
 * - Image display and modal
 * - Status indicators
 */

// ============================================================
// Configuration
// ============================================================

const API_BASE = window.location.origin === 'http://localhost:5500' || 
                 window.location.origin === 'http://127.0.0.1:5500'
    ? 'http://localhost:3001'
    : window.location.origin;

// Session ID for conversation persistence
const SESSION_ID = 'default';

// ============================================================
// DOM References
// ============================================================

const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const loadingIndicator = document.getElementById('loadingIndicator');
const lmStatus = document.getElementById('lmStatus');
const mcpStatus = document.getElementById('mcpStatus');
const imageModal = document.getElementById('imageModal');
const modalImage = document.getElementById('modalImage');

// ============================================================
// State
// ============================================================

let isProcessing = false;
let lastAssistantMsgEl = null;

// ============================================================
// Helper Functions
// ============================================================

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Scroll chat to bottom
 */
function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Add a message to the chat
 */
function addMessage(role, content, extraClass = '') {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}${extraClass ? ' ' + extraClass : ''}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    contentDiv.innerHTML = content;

    msgDiv.appendChild(contentDiv);
    chatMessages.appendChild(msgDiv);
    scrollToBottom();

    return msgDiv;
}

/**
 * Add an image to the last assistant message or create a new one
 */
function addImageToChat(base64Data, mimeType) {
    // Check if we have a last assistant message to append to
    const messages = chatMessages.querySelectorAll('.message.assistant');
    let targetMsg;

    if (messages.length > 0) {
        targetMsg = messages[messages.length - 1];
    } else {
        targetMsg = addMessage('assistant', '');
    }

    const contentDiv = targetMsg.querySelector('.message-content');

    const img = document.createElement('img');
    img.src = `data:${mimeType || 'image/png'};base64,${base64Data}`;
    img.alt = 'Generated image';
    img.loading = 'lazy';

    // Click to open modal
    img.addEventListener('click', () => {
        modalImage.src = img.src;
        imageModal.classList.remove('hidden');
    });

    contentDiv.appendChild(img);
    scrollToBottom();
}

/**
 * Add a tool notification message
 */
function addToolNotification(text) {
    const div = document.createElement('div');
    div.className = 'tool-notification';
    div.textContent = text;
    chatMessages.appendChild(div);
    scrollToBottom();
}

// ============================================================
// API Calls
// ============================================================

/**
 * Send message and stream response via SSE
 */
async function sendMessage(message) {
    if (isProcessing) return;
    isProcessing = true;
    sendBtn.disabled = true;
    messageInput.disabled = true;

    // Show user message
    addMessage('user', escapeHtml(message));

    // Show loading
    loadingIndicator.classList.remove('hidden');

    // Create placeholder for assistant response
    lastAssistantMsgEl = addMessage('assistant', '');
    const assistantContentEl = lastAssistantMsgEl.querySelector('.message-content');

    try {
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: message,
                session_id: SESSION_ID,
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(error.error || `HTTP ${response.status}`);
        }

        // Process SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (trimmed.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(trimmed.slice(6));
                        handleStreamData(data, assistantContentEl, 0);
                    } catch (e) {
                        console.warn('Failed to parse SSE data:', trimmed.substring(0, 50));
                    }
                }
            }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
            const trimmed = buffer.trim();
            if (trimmed.startsWith('data: ')) {
                try {
                    const data = JSON.parse(trimmed.slice(6));
                    handleStreamData(data, assistantContentEl, 0);
                } catch (e) { /* ignore */ }
            }
        }

    } catch (error) {
        console.error('Chat error:', error);
        assistantContentEl.textContent = `❌ 錯誤：${error.message}`;
        lastAssistantMsgEl.className = 'message system';
    } finally {
        loadingIndicator.classList.add('hidden');
        isProcessing = false;
        sendBtn.disabled = false;
        messageInput.disabled = false;
        messageInput.focus();
    }
}

/**
 * Handle SSE data from stream
 */
function handleStreamData(data, contentEl) {
    switch (data.type) {
        case 'text':
            // Append text to assistant message
            contentEl.textContent += data.content;
            scrollToBottom();
            break;

        case 'image':
            // Add image to chat
            addImageToChat(data.data, data.mimeType || 'image/png');
            break;

        case 'tool_call':
            addToolNotification(`🔧 AI 正在使用 ${data.tool} 工具生成圖片...`);
            break;

        case 'tool_result':
            if (data.success && data.imageCount > 0) {
                addToolNotification(`✅ 已生成 ${data.imageCount} 張圖片`);
            } else if (!data.success) {
                addToolNotification(`❌ 工具執行失敗：${data.error}`);
            }
            break;

        case 'done':
            // Stream complete
            break;

        case 'error':
            contentEl.textContent = `❌ 錯誤：${data.error}`;
            break;
    }
}

// ============================================================
// Status Checking
// ============================================================

async function checkStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/status`);
        if (response.ok) {
            const data = await response.json();
            lmStatus.className = data.status === 'ok' ? 'status-dot online' : 'status-dot offline';
            mcpStatus.className = data.mcpReady ? 'status-dot online' : 'status-dot offline';
        }
    } catch (error) {
        lmStatus.className = 'status-dot offline';
        mcpStatus.className = 'status-dot offline';
    }
}

// ============================================================
// Event Handlers
// ============================================================

// Send message on button click
sendBtn.addEventListener('click', () => {
    const message = messageInput.value.trim();
    if (message) {
        messageInput.value = '';
        messageInput.style.height = 'auto';
        sendMessage(message);
    }
});

// Send message on Enter (Shift+Enter for new line)
messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
    }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
});

// Clear conversation
clearBtn.addEventListener('click', async () => {
    try {
        await fetch(`${API_BASE}/api/clear`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: SESSION_ID }),
        });
        // Clear messages except the first system message
        while (chatMessages.children.length > 1) {
            chatMessages.removeChild(chatMessages.lastChild);
        }
        // Also clear any tool notifications
        const toolNotifs = chatMessages.querySelectorAll('.tool-notification');
        toolNotifs.forEach(el => el.remove());
    } catch (error) {
        console.error('Clear error:', error);
    }
});

// Image modal close
imageModal.addEventListener('click', () => {
    imageModal.classList.add('hidden');
});

// Close modal with Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        imageModal.classList.add('hidden');
    }
});

// ============================================================
// Initialize
// ============================================================

// Check status every 10 seconds
checkStatus();
setInterval(checkStatus, 10000);

// Focus input on load
messageInput.focus();

console.log('AI Image Chat initialized');
console.log(`API Base: ${API_BASE}`);