import path from "node:path";

export interface FlowConfig {
  useVertex: boolean;
  apiKey?: string;
  project?: string;
  location?: string;
  outputDir: string;
  videoModel: string;
  videoFastModel: string;
  imageModel: string;
}

export function loadConfig(): FlowConfig {
  const env = process.env;
  const useVertex = /^(1|true|yes)$/i.test(env.GOOGLE_GENAI_USE_VERTEXAI ?? "");
  return {
    useVertex,
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
    project: env.GOOGLE_CLOUD_PROJECT,
    location: env.GOOGLE_CLOUD_LOCATION || "us-central1",
    outputDir: path.resolve(env.FLOW_OUTPUT_DIR || path.join(process.cwd(), "flow-output")),
    videoModel: env.FLOW_VIDEO_MODEL || "veo-3.1-generate-preview",
    videoFastModel: env.FLOW_VIDEO_FAST_MODEL || "veo-3.1-fast-generate-preview",
    imageModel: env.FLOW_IMAGE_MODEL || "gemini-3-pro-image-preview",
  };
}

export function assertCredentials(cfg: FlowConfig): void {
  if (cfg.useVertex) {
    if (!cfg.project) {
      throw new Error("GOOGLE_GENAI_USE_VERTEXAI=true requires GOOGLE_CLOUD_PROJECT (and gcloud ADC login).");
    }
    return;
  }
  if (!cfg.apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Create one at https://aistudio.google.com/apikey and pass it to the MCP server env.",
    );
  }
}
