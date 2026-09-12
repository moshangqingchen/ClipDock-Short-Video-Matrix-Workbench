import { z } from "zod";

export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_MAX_BYTES = 256 * 1024 ** 3;
export const YOUTUBE_UPLOAD_CHUNK_BYTES = 8 * 1024 ** 2;
export const youtubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const youtubePrivacySchema = z.enum(["private", "unlisted", "public"]);
/** Audience and visibility are explicit user input, never inferred from a file. */
export const youtubeUploadMetadataSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => !/[<>]/.test(value) && [...value].every((char) => char.charCodeAt(0) >= 32)),
    description: z
      .string()
      .max(5000)
      .refine((value) => new TextEncoder().encode(value).byteLength <= 5000 && !/[<>\0]/.test(value)),
    categoryId: z.string().regex(/^[1-9][0-9]{0,2}$/),
    privacy: youtubePrivacySchema,
    madeForKids: z.boolean(),
    containsSyntheticMedia: z.boolean(),
    notifySubscribers: z.boolean(),
  })
  .strict();
export type YouTubeUploadMetadata = z.infer<typeof youtubeUploadMetadataSchema>;
export interface YouTubeUploadReceipt {
  videoId: string;
  privacy: z.infer<typeof youtubePrivacySchema>;
  state: "processing" | "ready" | "published" | "failed";
}
