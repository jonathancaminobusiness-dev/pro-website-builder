import { z } from 'zod';

/**
 * The faces the owner handed over, declared beside the files themselves.
 *
 * The compiler never downloads a font, and the identity contract carries font
 * stacks rather than files, so this manifest is how a face and the terms that
 * came with it enter a release at all. One entry is one file in one format:
 * `planFonts` self-hosts it only when the licence clearly permits redistributing
 * it with the site, and the licence inventory carries the row either way.
 */
export const fontManifestSchema = z.object({
  faces: z.array(z.object({
    family: z.string().min(1),
    weight: z.string().min(1),
    style: z.enum(['normal', 'italic']),
    format: z.enum(['woff2', 'woff']),
    /** Path of the file, relative to the fonts directory the manifest lives in. */
    file: z.string().min(1),
    license: z.string().min(1),
    licenseUrl: z.string().optional(),
    source: z.string().min(1),
    author: z.string().min(1),
    date: z.string(),
    unicodeRange: z.string().optional(),
  })),
});

export type FontManifest = z.infer<typeof fontManifestSchema>;
export type FontManifestFace = FontManifest['faces'][number];
