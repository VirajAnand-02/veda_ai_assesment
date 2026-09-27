import { z } from "zod";
import { MAX_PAGES } from "./constants";

const boxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

const pageSchema = z.object({
  /** Storage path of the rendered page image. */
  path: z.string().min(1).max(500),
  width: z.number().int().positive().max(20000),
  height: z.number().int().positive().max(20000),
  /** Text lines from the PDF's text layer, or null for scans and photos. */
  lines: z
    .array(z.object({ text: z.string().max(2000), box: boxSchema }))
    .max(1000)
    .nullable(),
});

const documentSchema = z.object({
  pages: z.array(pageSchema).min(1).max(MAX_PAGES),
});

export const extractionRequestSchema = z
  .object({
    submissionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    question: documentSchema,
    answer: documentSchema,
  })
  .superRefine((request, ctx) => {
    // Pages must live in this submission's own folders.
    for (const kind of ["question", "answer"] as const) {
      const prefix = `${request.submissionId}/${kind}/pages/`;
      request[kind].pages.forEach((page, index) => {
        if (!page.path.startsWith(prefix) || page.path.includes("..")) {
          ctx.addIssue({
            code: "custom",
            path: [kind, "pages", index, "path"],
            message: `Page paths must start with ${prefix}`,
          });
        }
      });
    }
  });

export type ExtractionRequest = z.infer<typeof extractionRequestSchema>;
export type PageInput = ExtractionRequest["question"]["pages"][number];
