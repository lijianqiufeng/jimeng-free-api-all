import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import childProcess from "node:child_process";
import axios from "axios";
import aws4 from "aws4";
import CRC32 from "crc-32";
import mime from "mime";
import { request } from "./core.ts";

type Reference = { kind: "video" | "audio"; url: string };
class UploadError extends Error {
  code: string;
  constructor(kind: Reference["kind"], public phase: string, reason: string, code = "REFERENCE_UPLOAD_FAILED") {
    super(`参考${kind === "video" ? "视频" : "音频"}${reason}，未提交生成`);
    this.code = code;
  }
}
const safeCode = (error: any) => {
  const code = String(error?.code || (Number.isInteger(error?.response?.status) ? `HTTP_${error.response.status}` : "REFERENCE_UPLOAD_FAILED"));
  return /^[A-Za-z0-9_.-]{1,60}$/.test(code) ? code : "REFERENCE_UPLOAD_FAILED";
};

export async function seedanceUploadUser(token: string, kind: Reference["kind"], beforeSubmit: () => void) {
  try {
    beforeSubmit();
    const result = await request("POST", "/passport/account/info/v2", token, { params: { account_sdk_source: "web" } });
    const payload = result?.data ?? result;
    const id = payload?.user_id_str ?? payload?.user_id ?? payload?.user_info?.user_id;
    if (!(typeof id === "string" || Number.isSafeInteger(id)) || !/^[0-9]{1,24}$/.test(String(id))) throw new UploadError(kind, "user", "账号身份未确认", "REFERENCE_USER_INVALID");
    return String(id);
  } catch (error) { throw error instanceof UploadError ? error : new UploadError(kind, "user", "读取账号身份失败", safeCode(error)); }
}

/** Jimeng's temporary STS credentials use the website Inner protocol, not Volcengine OpenAPI. */
export async function uploadSeedanceReference(token: string, ref: Reference, maxSeconds: number, beforeSubmit: () => void, userId: string) {
  let phase = "read", directory = "", file = "";
  const fail = (reason: string, code?: string) => new UploadError(ref.kind, phase, reason, code);
  try {
    beforeSubmit();
    const signal = AbortSignal.timeout(120_000);
    const response = await fetch(ref.url, { redirect: "error", signal });
    const maxBytes = (ref.kind === "audio" ? 15 : maxSeconds === 30 ? 200 : 50) * 1024 * 1024;
    const size = Number(response.headers.get("content-length"));
    if (!response.ok || !response.body) { await response.body?.cancel(); throw fail("读取失败", "REFERENCE_READ_FAILED"); }
    if (!Number.isFinite(size) || size <= 0 || size > maxBytes) { await response.body.cancel(); throw fail("体积超限", "REFERENCE_SIZE_INVALID"); }
    const suffix = mime.getExtension(response.headers.get("content-type")?.split(";")[0] || "");
    const extension = new URL(ref.url).pathname.match(/\.(mp4|mov|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac)$/i)?.[0]
      || `.${suffix === "mpga" ? "mp3" : suffix || (ref.kind === "audio" ? "mp3" : "mp4")}`;
    directory = await mkdtemp(join(tmpdir(), "jimeng-reference-"));
    file = join(directory, `reference${extension}`);
    let received = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) { received += chunk.length; callback(received > size || received > maxBytes ? fail("体积超限", "REFERENCE_SIZE_INVALID") : null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as any), limiter, createWriteStream(file, { mode: 0o600 }), { signal });
    if (received !== size) throw fail("读取不完整", "REFERENCE_SIZE_INVALID");
    phase = "probe"; beforeSubmit();
    const text = await new Promise<string>((resolve, reject) => childProcess.execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mp3,wav,ogg,flac,aac", "-show_entries", "stream=codec_type,width,height,avg_frame_rate:format=duration", "-of", "json", file], { timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const info = JSON.parse(text), seconds = Number(info.format?.duration);
    const stream = info.streams?.find((item: any) => item.codec_type === ref.kind);
    if (!stream || !Number.isFinite(seconds) || seconds < 2 || seconds > maxSeconds + (ref.kind === "video" ? 0.2 : 0)) throw fail("时长不符合模型限制", "REFERENCE_DURATION_INVALID");
    const width = Number(stream.width), height = Number(stream.height), rate = String(stream.avg_frame_rate || "").split("/"), fps = Number(rate[0]) / Number(rate[1]);
    if (ref.kind === "video") {
      const min = maxSeconds === 30 ? 300 : 200, max = maxSeconds === 30 ? 6000 : 2160;
      if (![width, height, fps].every(Number.isFinite) || width < min || height < min || width > max || height > max || width / height < 0.4 || width / height > 2.5 || fps < 24 || fps > 60) throw fail("尺寸或帧率不符合模型限制", "REFERENCE_VIDEO_INVALID");
    }
    phase = "token"; beforeSubmit();
    const auth = await request("post", "/mweb/v1/get_upload_token", token, { data: { scene: 1 } });
    if (!auth.access_key_id || !auth.secret_access_key || !auth.session_token || !auth.space_name) throw fail("上传凭据不完整", "REFERENCE_TOKEN_INVALID");
    const send = async (method: "GET" | "POST", url: string, headers: Record<string, string>, data?: unknown) => {
      beforeSubmit();
      const result = await axios.request({ method, url, headers, data, timeout: 30_000, maxRedirects: 0, maxContentLength: 128 * 1024, maxBodyLength: 6 * 1024 * 1024 });
      if (result.data?.ResponseMetadata?.Error) throw Object.assign(Error("VOD rejected"), { code: result.data.ResponseMetadata.Error.Code });
      return result.data;
    };
    const vod = (action: string, params: Record<string, string | number>, data?: Record<string, unknown>) => {
      const query = new URLSearchParams({ Action: action, Version: "2020-11-19", SpaceName: auth.space_name, ...params } as Record<string, string>);
      const body = data ? JSON.stringify(data) : undefined;
      const signed = aws4.sign({ host: "vod.bytedanceapi.com", path: `/?${query}`, method: body ? "POST" : "GET", service: "vod", region: "cn-north-1", body,
        headers: body ? { "Content-Type": "application/json", "X-Amz-Content-Sha256": createHash("sha256").update(body).digest("hex") } : {},
        extraHeadersToIgnore: { host: true, "content-type": true, "content-length": true },
      }, { accessKeyId: auth.access_key_id, secretAccessKey: auth.secret_access_key, sessionToken: auth.session_token });
      return send(body ? "POST" : "GET", `https://${signed.host}${signed.path}`, signed.headers as Record<string, string>, body);
    };
    phase = "apply";
    const applied = await vod("ApplyUploadInner", { FileType: "video", IsInner: 1, FileSize: size, FileExtension: extension });
    const node = applied?.Result?.InnerUploadAddress?.UploadNodes?.[0], store = node?.StoreInfos?.[0];
    if (!node?.UploadHost || !node.SessionKey || !store?.StoreUri || !store.Auth) throw fail("上传地址不完整", "REFERENCE_UPLOAD_ADDRESS_INVALID");
    const host = new URL(`https://${node.UploadHost}`);
    if (host.host !== node.UploadHost || host.username || host.password || host.port || host.pathname !== "/" || host.search || host.hash || !/^[A-Za-z0-9_./%-]+$/.test(store.StoreUri) || store.StoreUri.split("/").includes("..")) throw fail("上传地址无效", "REFERENCE_UPLOAD_ADDRESS_INVALID");
    const base = `${host.origin}/upload/v1/${store.StoreUri.split("/").map(encodeURIComponent).join("/")}`;
    const headers = { Authorization: store.Auth, "X-Storage-U": encodeURIComponent(userId), ...(node.UploadHeader || {}) };
    phase = "init";
    const initialized = await send("POST", `${base}?uploadmode=part&phase=init`, headers);
    if (initialized?.code !== 2000 || !initialized.data?.uploadid) throw fail("初始化上传失败", "REFERENCE_UPLOAD_INIT_FAILED");
    const uploadId = encodeURIComponent(String(initialized.data.uploadid)), checksums: string[] = [];
    phase = "transfer";
    const source = createReadStream(file, { highWaterMark: 5 * 1024 * 1024 });
    try {
      for await (const chunk of source) {
        const crc = (CRC32.buf(chunk as Buffer) >>> 0).toString(16).padStart(8, "0");
        const part = await send("POST", `${base}?uploadid=${uploadId}&part_number=${checksums.length + 1}&phase=transfer`, { ...headers, "Content-CRC32": crc, "Content-Type": "application/octet-stream" }, chunk);
        if (part?.code !== 2000) throw fail("分片上传失败", "REFERENCE_UPLOAD_PART_FAILED");
        checksums.push(crc);
      }
    } finally { source.destroy(); }
    phase = "finish";
    const merged = await send("POST", `${base}?uploadmode=part&phase=finish&uploadid=${uploadId}`, headers, checksums.map((crc, index) => `${index + 1}:${crc}`).join(","));
    if (merged?.code !== 2000 || !merged.data?.key) throw fail("合并上传失败", "REFERENCE_UPLOAD_MERGE_FAILED");
    phase = "commit";
    const committed = await vod("CommitUploadInner", {}, { SessionKey: node.SessionKey, Functions: [{ name: "GetMeta" }] });
    const uploaded = committed?.Result?.Results?.[0];
    if (typeof uploaded?.Vid !== "string" || !uploaded.Vid.trim() || !Number.isFinite(Number(uploaded.VideoMeta?.Duration)) || Math.abs(Number(uploaded.VideoMeta.Duration) - seconds) > 0.2 || ref.kind === "video" && (Number(uploaded.VideoMeta.Width) !== width || Number(uploaded.VideoMeta.Height) !== height)) throw fail("上传结果不完整或与原素材不符", "REFERENCE_UPLOAD_RESULT_INVALID");
    return { vid: uploaded.Vid, duration: Math.round(seconds * 1000), ...(ref.kind === "video" ? { width, height, fps } : {}) };
  } catch (error: any) {
    if (error instanceof UploadError) throw error;
    const stages: Record<string, string> = { read: "读取失败", probe: "解析失败", token: "获取上传凭据失败", apply: "申请上传失败", init: "初始化上传失败", transfer: "分片上传失败", finish: "合并上传失败", commit: "确认上传失败" };
    throw fail(stages[phase], safeCode(error));
  } finally {
    if (file) await unlink(file).catch(() => undefined);
    if (directory) await rmdir(directory).catch(() => undefined);
  }
}
