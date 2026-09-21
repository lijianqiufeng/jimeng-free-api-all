export function upscaleTaskInput(value: any) {
  if (!value || typeof value !== "object" || !/^[A-Za-z0-9_-]{16,100}$/.test(value.id || "")) throw Error("任务 ID 无效");
  if (typeof value.image !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)) {
    throw Error("原图只接受 PNG、JPEG 或 WebP data URL");
  }
  const bytes = Buffer.byteLength(value.image.slice(value.image.indexOf(",") + 1), "base64");
  if (!bytes || bytes > 25 * 1024 * 1024) throw Error("原图须小于 25MB");
  return { id: String(value.id), image: value.image };
}
