# 🎨 AI Image Chat

使用 **OpenRouter + Stability Matrix + MCP** 的本機 AI 產圖聊天介面。LLM 由 OpenRouter 提供，本機只需要執行 Stability Matrix / AUTOMATIC1111 或 ComfyUI，不再需要 LM Studio。

## 架構

```text
Browser :5500
   ↓ HTTP/SSE
Express Backend :3001
   ├─ OpenRouter API (LLM / tool calling)
   └─ MCP Server (stdio)
          ↓
   Stability Matrix
   ├─ AUTOMATIC1111 :7860 (default)
   └─ ComfyUI :8188
```

## 前置需求

- Node.js 18+（建議 20+）
- Git
- OpenRouter API key
- Stability Matrix，以及可正常產圖的 AUTOMATIC1111 或 ComfyUI package / model

## Windows / PowerShell 快速開始

```powershell
git clone https://github.com/boray10855010/forgenerate.git
cd forgenerate
npm run install:all
npm run build:mcp
```

設定 OpenRouter：

```powershell
$env:OPENROUTER_API_KEY="你的 OpenRouter API key"
$env:OPENROUTER_MODEL="mistralai/mistral-nemo"
```

API key 不要寫進 GitHub 或 commit 到程式碼中。

### Stability Matrix

預設使用 AUTOMATIC1111：

```powershell
$env:STABILITY_API_BASE="http://localhost:7860"
$env:STABILITY_API_MODE="auto1111"
```

如果你的 A1111 就是 7860，以上兩行可以省略。

### 啟動 backend

```powershell
npm run start:backend
```

另開一個 PowerShell 啟動 frontend：

```powershell
cd C:\Users\ray20\forgenerate
npm run start:frontend
```

瀏覽器開啟 `http://localhost:5500`。

## 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `OPENROUTER_API_KEY` | 無 | **必要**，OpenRouter API key |
| `OPENROUTER_MODEL` | `mistralai/mistral-nemo` | OpenRouter model slug |
| `OPENROUTER_BASE` | `https://openrouter.ai/api/v1` | OpenRouter API base URL |
| `OPENROUTER_SITE_URL` | `http://localhost:5500` | OpenRouter HTTP-Referer |
| `OPENROUTER_APP_NAME` | `AI Image Chat` | OpenRouter X-Title |
| `STABILITY_API_BASE` | `http://localhost:7860` | Stability Matrix image API |
| `STABILITY_API_MODE` | `auto1111` | `auto1111` 或 `comfyui` |
| `PORT` | `3001` | Backend port |
| `OUTPUT_DIR` | `./outputs` | 圖片輸出目錄 |

## 啟動時應看到

```text
=== AI Image Chat Backend ===
OpenRouter: https://openrouter.ai/api/v1
Model: mistralai/mistral-nemo
API key: configured
...
Server running at http://localhost:3001
```

如果顯示 `API key: MISSING`，請先在**同一個 PowerShell 視窗**設定 `$env:OPENROUTER_API_KEY` 再啟動 backend。

## 專案結構

```text
forgenerate/
├── package.json
├── README.md
├── mcp-server-stability/
│   ├── src/index.ts
│   └── dist/
├── backend/
│   └── src/index.js
├── frontend/
│   └── public/
└── outputs/
```

## 故障排除

### `OPENROUTER_API_KEY is not set`
在啟動 backend 的同一個 PowerShell：

```powershell
$env:OPENROUTER_API_KEY="你的 key"
npm run start:backend
```

### OpenRouter 401 / 403
確認 API key 正確、帳戶可使用指定模型，而且 key 沒有多餘空白或引號。

### AUTOMATIC1111 API error
確認 Stability Matrix 的 WebUI 已啟動，而且 API port 與 `STABILITY_API_BASE` 相符。

### MCP Server 啟動失敗

```powershell
npm run build:mcp
```

然後重新啟動 backend。

## 技術

- OpenRouter OpenAI-compatible Chat Completions API
- Function / tool calling
- MCP JSON-RPC over stdio
- Stability Matrix / AUTOMATIC1111 / ComfyUI
- Express + SSE

## License

MIT
