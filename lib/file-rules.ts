export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
export const MAX_BATCH_FILES = 200;
export const FALLBACK_BATCH_FILES = 25;

const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);
const SUPPORTED_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);

export function validateFile(file: Pick<File, "name" | "size" | "type">): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!SUPPORTED_MIME_TYPES.has(file.type) && !SUPPORTED_EXTENSIONS.has(extension)) {
    return "Choose a JPG, JPEG, or PNG file.";
  }
  if (file.size <= 0) return "This file is empty.";
  if (file.size > MAX_FILE_BYTES) return "This file is larger than the 30 MB safety limit.";
  return null;
}

export function safeOutputName(inputName: string): string {
  const filename = inputName.split(/[\\/]/).pop() || "photo";
  const base = filename.replace(/\.[^.]+$/, "") || "photo";
  const safe = base
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${safe || "photo"}-date-removed.png`;
}

export function reserveUniqueOutputName(proposedName: string, usedNames: Set<string>): string {
  const extension = proposedName.toLowerCase().endsWith(".png") ? proposedName.slice(-4) : "";
  const stem = extension ? proposedName.slice(0, -4) : proposedName;
  let candidate = proposedName;
  let copyNumber = 2;

  while (usedNames.has(candidate.toLocaleLowerCase("en-US"))) {
    candidate = `${stem}-${copyNumber}${extension}`;
    copyNumber += 1;
  }

  usedNames.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}
