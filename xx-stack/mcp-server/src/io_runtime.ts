import { rename, writeFile } from "node:fs/promises";

export async function atomicWriteTextFile(path: string, content: string): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, path);
}
