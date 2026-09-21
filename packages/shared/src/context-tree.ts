import { z } from "zod";

export const ContextTreeRepositorySchema = z
  .string()
  .trim()
  .max(140)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_][a-zA-Z0-9._-]{0,99}$/)
  .refine((value) => !value.toLowerCase().endsWith(".git"), "Use OWNER/REPO without .git");
