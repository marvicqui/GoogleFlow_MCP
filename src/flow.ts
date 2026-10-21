import fs from "node:fs/promises";
import path from "node:path";
import {
  GoogleGenAI,
  GenerateVideosOperation,
  VideoGenerationReferenceType,
  type GenerateVideosConfig,
  type GenerateVideosSource,
  type GeneratedVideo,
  type Image,
  type Part,
} from "@google/genai";
import { assertCredentials, type FlowConfig } from "./config.js";
import { AssetStore, type Asset } from "./store.js";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VideoRequest {
  prompt?: string;
  model?: string;
  fast?: boolean;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p" | "4k";
  durationSeconds?: number;
  negativePrompt?: string;
  generateAudio?: boolean;
  seed?: number;
  numberOfVideos?: number;
  personGeneration?: string;
  /** "Frames to video": first frame (asset id or local path). */
  startImage?: string;
  /** "Frames to video": last frame (asset id or local path). Requires startImage. */
  endImage?: string;
  /** "Ingredients to video": up to 3 asset/character/style reference images. */
  referenceImages?: string[];
  /** Extend an existing Veo video (asset id). */
  extendVideoId?: string;
  wait?: boolean;
  timeoutSeconds?: number;
}

export interface VideoResult {
  status: "done" | "pending";
  operationName: string;
  assets: Asset[];
  filteredCount?: number;
  note?: string;
  /** Parameters that were ignored because the current backend does not support them. */
  ignored?: string[];
}

export interface ImageRequest {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: "1K" | "2K" | "4K";
  numberOfImages?: number;
  /** Images to edit or compose (asset ids or local paths). */
  inputImages?: string[];
}

export interface ImageResult {
  assets: Asset[];
  text?: string;
  previews: { data: string; mimeType: string }[];
}

export class FlowClient {
  private _ai?: GoogleGenAI;
  readonly store: AssetStore;

  constructor(public readonly cfg: FlowConfig) {
    this.store = new AssetStore(cfg.outputDir);
  }

  /** Lazily created so the server can start (and list tools) even before the key is configured. */
  get ai(): GoogleGenAI {
    if (!this._ai) {
      assertCredentials(this.cfg);
      this._ai = this.cfg.useVertex
        ? new GoogleGenAI({ vertexai: true, project: this.cfg.project, location: this.cfg.location })
        : new GoogleGenAI({ apiKey: this.cfg.apiKey });
    }
    return this._ai;
  }

  // ---------- helpers ----------

  /** Accepts an asset id from the manifest or a local file path and returns an inline image. */
  async loadImage(ref: string): Promise<Image> {
    let filePath = ref;
    const asset = await this.store.getAsset(ref);
    if (asset) {
      if (asset.kind !== "image") throw new Error(`Asset ${ref} is a ${asset.kind}, expected an image.`);
      filePath = asset.localPath;
    }
    const abs = path.resolve(filePath);
    const mimeType = MIME_BY_EXT[path.extname(abs).toLowerCase()];
    if (!mimeType) throw new Error(`Unsupported image type for ${abs}. Use png, jpg, webp or heic.`);
    const bytes = await fs.readFile(abs).catch(() => {
      throw new Error(`Image not found: ${abs} (pass an asset id from flow_list_assets or an existing file path).`);
    });
    return { imageBytes: bytes.toString("base64"), mimeType };
  }

  // ---------- video ----------

  async generateVideo(req: VideoRequest): Promise<VideoResult> {
    const model = req.model || (req.fast ? this.cfg.videoFastModel : this.cfg.videoModel);

    const config: GenerateVideosConfig = {};
    if (req.aspectRatio) config.aspectRatio = req.aspectRatio;
    if (req.resolution) config.resolution = req.resolution;
    if (req.durationSeconds) config.durationSeconds = req.durationSeconds;
    if (req.negativePrompt) config.negativePrompt = req.negativePrompt;
    // The Gemini Developer API rejects `generateAudio` and `seed` (Vertex AI only).
    // Veo 3.x on the Gemini API always generates audio, so dropping the flag is safe.
    const ignored: string[] = [];
    if (req.generateAudio !== undefined) {
      if (this.cfg.useVertex) config.generateAudio = req.generateAudio;
      else ignored.push("generateAudio (Gemini API: Veo 3.x always includes audio)");
    }
    if (req.seed !== undefined) {
      if (this.cfg.useVertex) config.seed = req.seed;
      else ignored.push("seed (only supported on Vertex AI)");
    }
    if (req.numberOfVideos) config.numberOfVideos = req.numberOfVideos;
    if (req.personGeneration) config.personGeneration = req.personGeneration;

    const source: GenerateVideosSource = {};
    if (req.prompt) source.prompt = req.prompt;

    let parentId: string | undefined;
    if (req.extendVideoId) {
      const src = await this.store.getAsset(req.extendVideoId);
      if (!src || src.kind !== "video") throw new Error(`Video asset ${req.extendVideoId} not found.`);
      if (!src.remoteUri) {
        throw new Error(`Video ${src.id} has no remote URI; only videos generated by Veo through this server can be extended.`);
      }
      source.video = { uri: src.remoteUri, mimeType: src.mimeType };
      parentId = src.id;
    } else {
      if (req.startImage) source.image = await this.loadImage(req.startImage);
      if (req.endImage) {
        if (!req.startImage) throw new Error("endImage requires startImage (first and last frame).");
        config.lastFrame = await this.loadImage(req.endImage);
      }
      if (req.referenceImages?.length) {
        if (req.startImage) throw new Error("referenceImages cannot be combined with startImage/endImage.");
        config.referenceImages = await Promise.all(
          req.referenceImages.slice(0, 3).map(async (r) => ({
            image: await this.loadImage(r),
            referenceType: VideoGenerationReferenceType.ASSET,
          })),
        );
      }
    }
    if (!source.prompt && !source.image && !source.video) {
      throw new Error("Provide at least a prompt or a startImage.");
    }

    const op = await this.ai.models.generateVideos({ model, source, config });
    if (!op.name) throw new Error("Google did not return an operation name.");
    await this.store.addPending({
      operationName: op.name,
      kind: "video",
      prompt: req.prompt,
      model,
      parentId,
      createdAt: new Date().toISOString(),
    });

    const withIgnored = (r: VideoResult): VideoResult => (ignored.length ? { ...r, ignored } : r);
    if (req.wait === false) {
      return withIgnored({ status: "pending", operationName: op.name, assets: [], note: "Use flow_check_operation to fetch the result." });
    }
    return withIgnored(await this.pollVideo(op, req.timeoutSeconds ?? 540));
  }

  async checkOperation(operationName: string, waitSeconds = 0): Promise<VideoResult> {
    const op = new GenerateVideosOperation();
    op.name = operationName;
    return this.pollVideo(op, waitSeconds);
  }

  private async pollVideo(op: GenerateVideosOperation, timeoutSeconds: number): Promise<VideoResult> {
    const name = op.name!;
    const deadline = Date.now() + timeoutSeconds * 1000;
    // Refresh at least once so a manual check always reports current state.
    if (!op.done) op = await this.ai.operations.getVideosOperation({ operation: op });
    while (!op.done && Date.now() < deadline) {
      await sleep(Math.min(10_000, Math.max(1_000, deadline - Date.now())));
      op = await this.ai.operations.getVideosOperation({ operation: op });
    }
    if (!op.done) {
      return {
        status: "pending",
        operationName: name,
        assets: [],
        note: "Still rendering. Call flow_check_operation with this operationName in a minute.",
      };
    }
    if (op.error) {
      await this.store.removePending(name);
      throw new Error(`Video generation failed: ${JSON.stringify(op.error)}`);
    }

    const pending = await this.store.getPending(name);
    const videos = op.response?.generatedVideos ?? [];
    const assets: Asset[] = [];
    for (const gv of videos) assets.push(await this.saveVideo(gv, name, pending?.prompt, pending?.model, pending?.parentId));
    await this.store.removePending(name);

    const filtered = op.response?.raiMediaFilteredCount;
    return {
      status: "done",
      operationName: name,
      assets,
      filteredCount: filtered,
      note: videos.length === 0
        ? `No video returned (filtered by safety: ${filtered ?? 0}). ${JSON.stringify(op.response?.raiMediaFilteredReasons ?? [])}`
        : undefined,
    };
  }

  private async saveVideo(
    gv: GeneratedVideo,
    operationName: string,
    prompt?: string,
    model?: string,
    parentId?: string,
  ): Promise<Asset> {
    const id = AssetStore.newId("video");
    const dir = await this.store.dir("video");
    const localPath = path.join(dir, `${id}.mp4`);
    const video = gv.video;
    if (video?.videoBytes) {
      await fs.writeFile(localPath, Buffer.from(video.videoBytes, "base64"));
    } else if (video?.uri) {
      await this.ai.files.download({ file: gv, downloadPath: localPath });
    } else {
      throw new Error("Generated video had neither bytes nor uri.");
    }
    const asset: Asset = {
      id,
      kind: "video",
      prompt,
      model: model ?? "unknown",
      localPath,
      mimeType: video?.mimeType || "video/mp4",
      remoteUri: video?.uri,
      parentId,
      operationName,
      createdAt: new Date().toISOString(),
    };
    await this.store.addAsset(asset);
    return asset;
  }

  // ---------- image ----------

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const model = req.model || this.cfg.imageModel;
    const n = Math.min(Math.max(req.numberOfImages ?? 1, 1), 4);
    const dir = await this.store.dir("image");
    const result: ImageResult = { assets: [], previews: [] };
    const parentId = req.inputImages?.length === 1 ? (await this.store.getAsset(req.inputImages[0]))?.id : undefined;

    const save = async (b64: string, mimeType: string) => {
      const id = AssetStore.newId("image");
      const localPath = path.join(dir, `${id}${EXT_BY_MIME[mimeType] ?? ".png"}`);
      await fs.writeFile(localPath, Buffer.from(b64, "base64"));
      const asset: Asset = {
        id,
        kind: "image",
        prompt: req.prompt,
        model,
        localPath,
        mimeType,
        parentId,
        createdAt: new Date().toISOString(),
      };
      await this.store.addAsset(asset);
      result.assets.push(asset);
      result.previews.push({ data: b64, mimeType });
    };

    // Imagen models use the dedicated generateImages endpoint (text-to-image only).
    if (model.startsWith("imagen")) {
      if (req.inputImages?.length) throw new Error("Imagen models do not support input images; use a Gemini image model.");
      const res = await this.ai.models.generateImages({
        model,
        prompt: req.prompt,
        config: { numberOfImages: n, aspectRatio: req.aspectRatio, imageSize: req.imageSize },
      });
      for (const gi of res.generatedImages ?? []) {
        if (gi.image?.imageBytes) await save(gi.image.imageBytes, gi.image.mimeType || "image/png");
      }
      return result;
    }

    // Gemini image models ("Nano Banana"): text-to-image, editing and multi-image composition.
    const inputParts: Part[] = [];
    for (const ref of req.inputImages ?? []) {
      const img = await this.loadImage(ref);
      inputParts.push({ inlineData: { data: img.imageBytes!, mimeType: img.mimeType! } });
    }
    const texts: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await this.ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [...inputParts, { text: req.prompt }] }],
        config: {
          responseModalities: ["IMAGE", "TEXT"],
          ...(req.aspectRatio || req.imageSize
            ? { imageConfig: { aspectRatio: req.aspectRatio, imageSize: req.imageSize } }
            : {}),
        },
      });
      for (const part of res.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) await save(part.inlineData.data, part.inlineData.mimeType || "image/png");
        else if (part.text && !part.thought) texts.push(part.text);
      }
      if (!res.candidates?.length && res.promptFeedback?.blockReason) {
        throw new Error(`Prompt blocked: ${res.promptFeedback.blockReason}`);
      }
    }
    if (texts.length) result.text = texts.join("\n");
    return result;
  }

  // ---------- models ----------

  async listModels(): Promise<{ name: string; displayName?: string; actions?: string[] }[]> {
    const out: { name: string; displayName?: string; actions?: string[] }[] = [];
    const pager = await this.ai.models.list({ config: { pageSize: 100 } });
    for await (const m of pager) {
      const name = (m.name ?? "").replace(/^models\//, "");
      if (/veo|imagen|image/i.test(name)) {
        out.push({ name, displayName: m.displayName, actions: m.supportedActions });
      }
    }
    return out;
  }
}

/** Adds an actionable hint to common Google API errors (quota, billing, missing model). */
export function explainApiError(message: string, cfg: FlowConfig): string {
  const hints: string[] = [];
  if (/\b429\b|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(message)) {
    hints.push(
      cfg.useVertex
        ? "Quota exhausted on Vertex AI: check quotas in Google Cloud console > IAM & Admin > Quotas, or request an increase."
        : "Quota exhausted. Veo has no free tier on the Gemini API: enable billing for the API key's project " +
            "(https://aistudio.google.com/apikey > Set up billing) and check limits at https://aistudio.google.com/usage. " +
            "If billing is already on, wait a minute (per-minute limit) or the daily limit resets at midnight Pacific time.",
    );
  }
  if (/FAILED_PRECONDITION|billing/i.test(message) && !hints.length) {
    hints.push("Billing is not enabled for this project. Enable it in Google AI Studio or Google Cloud console.");
  }
  if (/\b404\b|NOT_FOUND|is not found/i.test(message)) {
    hints.push("Model not found: run flow_list_models and set FLOW_VIDEO_MODEL / FLOW_VIDEO_FAST_MODEL / FLOW_IMAGE_MODEL.");
  }
  if (/API key not valid|API_KEY_INVALID|\b401\b|\b403\b|PERMISSION_DENIED/i.test(message)) {
    hints.push("The API key is invalid or lacks access. Check GEMINI_API_KEY in the MCP server config.");
  }
  return hints.length ? `${message}\n\nHint: ${hints.join(" ")}` : message;
}
