import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export type AssetKind = "video" | "image";

export interface Asset {
  id: string;
  kind: AssetKind;
  prompt?: string;
  model: string;
  localPath: string;
  mimeType: string;
  /** Remote URI returned by Google (needed to extend a Veo video). Gemini API files expire after ~2 days. */
  remoteUri?: string;
  parentId?: string;
  operationName?: string;
  createdAt: string;
}

export interface PendingOperation {
  operationName: string;
  kind: "video";
  prompt?: string;
  model: string;
  parentId?: string;
  createdAt: string;
}

interface Manifest {
  assets: Asset[];
  pending: PendingOperation[];
}

/** Keeps a small JSON manifest next to the generated files so assets can be referenced by id. */
export class AssetStore {
  private manifestPath: string;

  constructor(public readonly root: string) {
    this.manifestPath = path.join(root, "manifest.json");
  }

  static newId(kind: AssetKind): string {
    return `${kind === "video" ? "vid" : "img"}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  }

  async dir(kind: AssetKind): Promise<string> {
    const d = path.join(this.root, kind === "video" ? "videos" : "images");
    await fs.mkdir(d, { recursive: true });
    return d;
  }

  private async read(): Promise<Manifest> {
    try {
      const raw = await fs.readFile(this.manifestPath, "utf8");
      const m = JSON.parse(raw) as Partial<Manifest>;
      return { assets: m.assets ?? [], pending: m.pending ?? [] };
    } catch {
      return { assets: [], pending: [] };
    }
  }

  private async write(m: Manifest): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(this.manifestPath, JSON.stringify(m, null, 2), "utf8");
  }

  async addAsset(a: Asset): Promise<void> {
    const m = await this.read();
    m.assets.push(a);
    await this.write(m);
  }

  async getAsset(id: string): Promise<Asset | undefined> {
    return (await this.read()).assets.find((a) => a.id === id);
  }

  async listAssets(kind?: AssetKind, limit = 50): Promise<Asset[]> {
    const all = (await this.read()).assets.filter((a) => !kind || a.kind === kind);
    return all.slice(-limit).reverse();
  }

  async addPending(p: PendingOperation): Promise<void> {
    const m = await this.read();
    m.pending = m.pending.filter((x) => x.operationName !== p.operationName);
    m.pending.push(p);
    await this.write(m);
  }

  async getPending(name: string): Promise<PendingOperation | undefined> {
    return (await this.read()).pending.find((p) => p.operationName === name);
  }

  async listPending(): Promise<PendingOperation[]> {
    return (await this.read()).pending;
  }

  async removePending(name: string): Promise<void> {
    const m = await this.read();
    m.pending = m.pending.filter((p) => p.operationName !== name);
    await this.write(m);
  }
}
