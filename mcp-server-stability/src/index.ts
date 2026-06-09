import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ============================================================
// Configuration
// ============================================================

// Stability Matrix runs a web UI. By default:
// - AUTOMATIC1111: http://localhost:7860/sdapi/v1/txt2img
// - ComfyUI: http://localhost:8188/prompt
// Change this to match your Stability Matrix web UI setup.
const STABILITY_API_BASE = process.env.STABILITY_API_BASE || "http://localhost:7860";
const STABILITY_API_MODE = (process.env.STABILITY_API_MODE || "auto1111").toLowerCase();
const OUTPUT_DIR = process.env.OUTPUT_DIR || "outputs";

// ============================================================
// API Types
// ============================================================

interface Txt2ImgResponse {
  images: string[];  // base64 encoded images
  parameters: Record<string, unknown>;
  info: string;      // JSON string with generation info
}

interface ImageRequest {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
  seed?: number;
  sampler_name?: string;
  batch_size?: number;
  n_iter?: number;
}

// ============================================================
// Helper functions
// ============================================================

/**
 * Validate non-empty text
 */
function isNonEmpty(val: unknown): val is string {
  return typeof val === "string" && val.trim().length > 0;
}

/**
 * Call the AUTOMATIC1111 txt2img API
 */
async function callAuto1111Api(params: ImageRequest): Promise<Txt2ImgResponse> {
  const url = `${STABILITY_API_BASE}/sdapi/v1/txt2img`;
  const payload = {
    prompt: params.prompt,
    negative_prompt: params.negative_prompt || "",
    width: params.width || 512,
    height: params.height || 512,
    steps: params.steps || 20,
    cfg_scale: params.cfg_scale || 7.0,
    seed: params.seed ?? -1,
    sampler_name: params.sampler_name || "Euler a",
    batch_size: params.batch_size || 1,
    n_iter: params.n_iter || 1,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AUTOMATIC1111 API error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<Txt2ImgResponse>;
}

/**
 * For ComfyUI - simplified workflow-based generation.
 * Users can provide a workflow JSON or we use a default txt2img workflow.
 */
async function callComfyUiApi(params: ImageRequest): Promise<string> {
  const url = `${STABILITY_API_BASE}/prompt`;

  // Simple txt2img workflow using the default ComfyUI checkpoint
  const workflow = {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: params.seed ?? Math.floor(Math.random() * 1000000),
        steps: params.steps || 20,
        cfg: params.cfg_scale || 7.0,
        sampler_name: params.sampler_name || "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "model.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: params.width || 512,
        height: params.height || 512,
        batch_size: params.batch_size || 1,
      },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: params.prompt,
        clip: ["4", 1],
      },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: params.negative_prompt || "",
        clip: ["4", 1],
      },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["3", 0],
        vae: ["4", 2],
      },
    },
    "9": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: OUTPUT_DIR,
        images: ["8", 0],
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ComfyUI API error (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as { prompt_id: string };
  // For ComfyUI, we'd need to poll for results. We return the prompt_id.
  return `Image generation queued. Prompt ID: ${result.prompt_id}. Check ComfyUI output folder for results.`;
}

/**
 * Save base64 image to disk
 */
function saveBase64Image(base64Data: string, filename: string): string {
  const fs = require("fs");
  const path = require("path");
  const outputPath = path.join(process.cwd(), OUTPUT_DIR);

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  const buffer = Buffer.from(base64Data, "base64");
  const filePath = path.join(outputPath, filename);
  fs.writeFileSync(filePath, buffer);

  return filePath;
}

/**
 * Generate a unique filename
 */
function generateFilename(seed: number, index: number): string {
  const timestamp = Date.now();
  return `generated_${timestamp}_s${seed}_${index}.png`;
}

// ============================================================
// MCP Server
// ============================================================

const server = new Server(
  {
    name: "mcp-server-stability",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Handler that lists available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "generate_image",
        description:
          "Generate images using Stable Diffusion via Stability Matrix. " +
          "Provide a text prompt and optional parameters to create AI-generated images.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The text prompt describing the image to generate",
            },
            negative_prompt: {
              type: "string",
              description: "Things to avoid in the generated image",
            },
            width: {
              type: "number",
              description: "Image width (default: 512, must be multiple of 64)",
              default: 512,
            },
            height: {
              type: "number",
              description: "Image height (default: 512, must be multiple of 64)",
              default: 512,
            },
            steps: {
              type: "number",
              description: "Number of sampling steps (default: 20)",
              default: 20,
            },
            cfg_scale: {
              type: "number",
              description: "CFG scale / prompt adherence (default: 7.0)",
              default: 7.0,
            },
            seed: {
              type: "number",
              description: "Random seed (-1 for random)",
              default: -1,
            },
            sampler_name: {
              type: "string",
              description: "Sampler method (e.g. Euler a, DPM++ 2M Karras, etc.)",
              default: "Euler a",
            },
            batch_size: {
              type: "number",
              description: "Number of images to generate at once",
              default: 1,
            },
          },
          required: ["prompt"],
        },
      },
    ],
  };
});

/**
 * Handler for tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "generate_image") {
    throw new Error(`Unknown tool: ${name}`);
  }

  if (!args || !isNonEmpty(args.prompt)) {
    throw new Error("A 'prompt' string parameter is required.");
  }

  const params: ImageRequest = {
    prompt: args.prompt,
    negative_prompt: typeof args.negative_prompt === "string" ? args.negative_prompt : undefined,
    width: typeof args.width === "number" ? args.width : 512,
    height: typeof args.height === "number" ? args.height : 512,
    steps: typeof args.steps === "number" ? args.steps : 20,
    cfg_scale: typeof args.cfg_scale === "number" ? args.cfg_scale : 7.0,
    seed: typeof args.seed === "number" ? args.seed : -1,
    sampler_name: typeof args.sampler_name === "string" ? args.sampler_name : "Euler a",
    batch_size: typeof args.batch_size === "number" ? args.batch_size : 1,
  };

  try {
    if (STABILITY_API_MODE === "comfyui") {
      const message = await callComfyUiApi(params);
      return {
        content: [
          {
            type: "text",
            text: message,
          },
        ],
      };
    }

    // Default: AUTOMATIC1111
    const result = await callAuto1111Api(params);

    // Parse the info string
    let genInfo: Record<string, unknown> = {};
    try {
      genInfo = JSON.parse(result.info);
    } catch {
      genInfo = { raw_info: result.info };
    }

    const savedFiles: string[] = [];
    const base64Images: string[] = [];

    for (let i = 0; i < result.images.length; i++) {
      const filename = generateFilename(
        (genInfo.seed as number) || params.seed || 0,
        i
      );
      const filePath = saveBase64Image(result.images[i], filename);
      savedFiles.push(filePath);
      base64Images.push(result.images[i]);
    }

    return {
      content: [
        {
          type: "text",
          text: [
            `✅ Generated ${result.images.length} image(s) successfully.`,
            `Seed: ${genInfo.seed || "N/A"}`,
            `Size: ${params.width}x${params.height}`,
            `Steps: ${params.steps}`,
            `Prompt: ${params.prompt}`,
            `Saved to: ${savedFiles.join(", ")}`,
          ].join("\n"),
        },
        ...base64Images.map((b64, idx) => ({
          type: "image" as const,
          data: b64,
          mimeType: "image/png",
        })),
      ],
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `❌ Image generation failed: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// ============================================================
// Start server
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Stability Matrix Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});