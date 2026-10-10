/**
 * The official website deployment's identity.
 *
 * One source for the literals two routes share: the session indicator gates and allowlists with them,
 * and the public catalog reads default to the same gate and origins. Keeping them here means the
 * official deployment cannot drift between the two surfaces.
 */
export const OFFICIAL_PUBLIC_ORIGIN = "https://app.opentag.build";
export const OFFICIAL_WEBSITE_ORIGINS = ["https://opentag.build", "https://www.opentag.build"] as const;
