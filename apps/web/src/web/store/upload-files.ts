const directory = "uploads";

export interface UploadFiles {
  read(id: string): Promise<File>;
  exists(id: string): Promise<boolean>;
  write(id: string, png: Uint8Array<ArrayBuffer>): Promise<void>;
  remove(id: string): Promise<void>;
}

export function uploadId(url: string) {
  const raw = /^(?:upload:\/\/|\/api\/uploads\/)(.+)$/.exec(url)?.[1];
  const uuid = raw?.replace(/^(?:urn:uuid:|\{)|\}$/g, "");
  if (
    !uuid ||
    !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(uuid)
  )
    return undefined;
  const hex = uuid.toLowerCase().replaceAll("-", "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function opfsUploads(
  root = () => navigator.storage.getDirectory(),
): UploadFiles {
  async function folder(create: boolean) {
    return (await root()).getDirectoryHandle(directory, { create });
  }
  function handle(id: string) {
    return folder(false).then((dir) => dir.getFileHandle(`${id}.png`));
  }
  const missing = (error: unknown) =>
    error instanceof DOMException && error.name === "NotFoundError";

  return {
    async read(id) {
      try {
        return await (await handle(id)).getFile();
      } catch (error) {
        if (missing(error))
          throw new Error("Uploaded image not found", { cause: error });
        throw error;
      }
    },
    async exists(id) {
      try {
        await handle(id);
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
    async write(id, png) {
      const file = await (await folder(true)).getFileHandle(`${id}.png`, {
        create: true,
      });
      const writer = await file.createWritable();
      try {
        await writer.write(png);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    },
    async remove(id) {
      await (await folder(false)).removeEntry(`${id}.png`);
    },
  };
}

export function readUploadImage(url: string) {
  const id = uploadId(url);
  if (!id) throw new Error("Uploaded image not found");
  return opfsUploads().read(id);
}
