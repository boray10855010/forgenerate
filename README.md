# 🎨 AI Image Chat

將 LM Studio 與 Stability Matrix 串聯，透過 MCP（Model Context Protocol）方式運作，讓你可以用一般 LLM 對話的形式來生成圖像。

## 系統架構

```
┌─────────────────────────────────────────────────────┐
│                   瀏覽器 (Frontend)                    │
│              localhost:5500 (serve)                    │
└──────────────────┬──────────────────────────────────┘
                   │ HTTP/SSE
                   ▼
┌─────────────────────────────────────────────────────┐
│          後端伺服器 (Backend - Express)               │
│              localhost:3001                           │
│                                                       │
│   ┌────────────┐    ┌──────────────────────┐        │
│   │  LM Studio │◄───│ Chat Completion API   │        │
│   │ localhost  │    │ (OpenAI-compatible)   │        │
│   │   :1234    │    └──────────────────────┘        │
│   └────────────┘                                     │
│                                                       │
│   ┌──────────────────────┐                           │
│   │ MCP Client (stdio)   │                           │
│   └──────────┬───────────┘                           │
└──────────────┼───────────────────────────────────────┘
               │ JSON-RPC (stdio)
               ▼
┌─────────────────────────────────────────────────────┐
│        MCP Server (Stability Matrix 包裝)            │
│                                                       │
│   ┌──────────────────┐  ┌─────────────────────┐    │
│   │ AUTOMATIC1111 API │  │ ComfyUI API          │    │
│   │ localhost:7860    │  │ localhost:8188        │    │
│   └──────────────────┘  └─────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## 運作流程

1. 使用者在網頁輸入訊息（例如「畫一隻可愛的貓咪」）
2. 後端將訊息發送給 **LM Studio**（附帶工具定義）
3. LM Studio 判斷需要產圖 → 回傳工具呼叫請求（`generate_image`）
4. 後端透過 **MCP** 發送 JSON-RPC 給 Stability Matrix 包裝器
5. Stability Matrix 包裝器呼叫 AUTOMATIC1111 或 ComfyUI API 生成圖片
6. 圖片結果傳回 LM Studio 進行最終回應
7. 最終結果（含圖片）串流回前端顯示

## 前置需求

1. **Node.js** >= 18（建議 20+）
2. **LM Studio** - 已啟動並載入模型（預設 port: 1234）
   - 下載: https://lmstudio.ai/
   - 開啟 LM Studio → Load Model → Start Server
3. **Stability Matrix** - 已啟動
   - 下載: https://github.com/LykosAI/StabilityMatrix
   - 支援 AUTOMATIC1111（預設）或 ComfyUI
   - 預設 API: http://localhost:7860 (A1111) 或 http://localhost:8188 (ComfyUI)

## 快速開始

### 1. 安裝相依套件

開啟終端機，進入專案目錄後執行：

```bash
cd ai-image-chat

# 安裝 MCP server 的依賴
cd mcp-server-stability && npm install && cd ..

# 安裝後端的依賴
cd backend && npm install && cd ..
```

### 2. 編譯 MCP Server

```bash
cd mcp-server-stability && npm run build && cd ..
```

### 3. 啟動服務

**啟動後端（同時會自動啟動 MCP Server）：**

```bash
cd backend && npm start
```

你會看到類似輸出：
```
=== AI Image Chat Backend ===
LM Studio: http://localhost:1234
MCP Server: C:\...\mcp-server-stability
Port: 3001

[MCP] Starting Stability Matrix MCP server...
[MCP] Server started successfully

🚀 Server running at http://localhost:3001
```

**啟動前端（另一個終端機）：**

```bash
cd ai-image-chat
npx serve frontend/public -l 5500
```

### 4. 開啟瀏覽器

前往 **http://localhost:5500**

你應該會看到聊天介面。上方狀態指示燈會顯示 LM Studio 與 Stability Matrix 的連線狀態。

## 使用方法

### 一般對話
直接輸入文字，AI 會像一般 LLM 一樣回應你。

### 生成圖片
說「畫一張...」或「生成...的圖片」，AI 會自動呼叫 Stable Diffusion 來畫圖。

例如：
- 「畫一隻在沙灘上奔跑的柴犬」
- 「生成一張未來城市的夜景」
- 「幫我畫一隻穿西裝的貓咪，戴著墨鏡」

### 進階參數
AI 會自動決定圖片參數，但你也可以指定：
- 尺寸：「畫一張 1024x768 的風景畫」
- 風格：「用水彩風格畫一朵玫瑰花」

## 環境變數（可選）

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `LM_STUDIO_BASE` | http://localhost:1234 | LM Studio API 位址 |
| `LM_MODEL` | (自動) | 指定使用的模型名稱 |
| `STABILITY_API_BASE` | http://localhost:7860 | Stability Matrix API 位址 |
| `STABILITY_API_MODE` | auto1111 | `auto1111` 或 `comfyui` |
| `PORT` | 3001 | 後端伺服器埠號 |
| `OUTPUT_DIR` | ./outputs | 圖片輸出目錄 |

使用方式（PowerShell）：
```powershell
$env:STABILITY_API_BASE = "http://localhost:7860"
$env:STABILITY_API_MODE = "auto1111"
cd backend && npm start
```

## 專案結構

```
ai-image-chat/
├── package.json              # 根目錄腳本
├── .gitignore
├── README.md
│
├── mcp-server-stability/     # MCP Server（包裝 Stability Matrix）
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   └── index.ts         # MCP 伺服器主程式
│   └── dist/                 # 編譯輸出
│
├── backend/                  # 後端 Express 伺服器
│   ├── package.json
│   └── src/
│       └── index.js          # 後端主程式
│
├── frontend/                 # 前端網頁
│   └── public/
│       ├── index.html        # 主頁面
│       ├── styles.css        # 樣式表
│       └── app.js            # 前端邏輯
│
└── outputs/                  # 生成的圖片（自動建立）
```

## 故障排除

### 「LM Studio API error (404)」
- 確認 LM Studio 已經啟動伺服器（Settings → Start Server）
- 確認有載入模型

### 「AUTOMATIC1111 API error」
- 確認 Stability Matrix 已經啟動 Web UI
- 確認 AUTOMATIC1111 或 ComfyUI 在執行
- 檢查 Stability Matrix 的 port 是否與設定相符

### MCP Server 啟動失敗
- 確認已執行 `npm run build`（在 mcp-server-stability 目錄）
- 嘗試手動執行 `npx tsx src/index.ts` 查看錯誤訊息

### 圖片生成但沒顯示
- 大圖片可能傳輸較慢，請稍候
- 檢查瀏覽器 Console（F12）是否有錯誤

## 技術說明

- **MCP (Model Context Protocol)**: 本專案使用 MCP 標準協定來包裝 Stability Matrix 的 API，使其可以像工具一樣被 LLM 呼叫
- **JSON-RPC**: MCP Server 透過 stdio 使用 JSON-RPC 2.0 與後端通訊
- **SSE (Server-Sent Events)**: 後端使用 SSE 將回應串流至前端
- **Function Calling**: 使用 LM Studio 支援的 OpenAI-compatible function calling 讓 LLM 決定何時產圖

## License

MIT