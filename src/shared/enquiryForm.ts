/**
 * Shared by the no-JS enquiry form path (KBS-89, decision/enquiry-nojs-csrf):
 * the redirect error allowlist and the validated display reference. Redirect
 * targets are built from these only, never from request input.
 */

/** Crockford base32 minus 0, 1, I, L, O, U — mirrors newReference() in the enquiries service. */
export const ENQUIRY_REFERENCE_PATTERN = /^KB-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;

export const ENQUIRY_FORM_PATH = "/enquire";
export const ENQUIRY_SENT_PATH = "/enquire/sent";

/** Plain sentences for each allowlisted `?error=` code (AC-ENQ-31: state plainly what is wrong). */
export const FORM_ERROR_MESSAGES = {
  csrf: "Your session expired before we could send your enquiry. Please check your details and send it again.",
  invalid: "Some details need another look. Please check the fields below and send it again.",
  rate_limited:
    "You have sent several enquiries in a short time. Please wait a few minutes and try again.",
  unavailable: "We could not send your enquiry just now. Please try again shortly.",
  bad_request: "We could not read your enquiry. Please check your details and send it again.",
} as const;

export type FormErrorCode = keyof typeof FORM_ERROR_MESSAGES;

export function isFormErrorCode(value: unknown): value is FormErrorCode {
  return typeof value === "string" && Object.hasOwn(FORM_ERROR_MESSAGES, value);
}

/** Allowlisted field names the form path may echo in `?fields=`, with their labels. */
export const ENQUIRY_FIELD_LABELS = {
  first_name: "First name",
  last_name: "Last name",
  contact_number: "Contact number",
  email: "Email",
  wedding_date: "Wedding date",
  message: "Message",
  gown_ids: "Gowns you selected",
  consent: "Privacy notice agreement",
} as const;

export type EnquiryFieldName = keyof typeof ENQUIRY_FIELD_LABELS;

export const ENQUIRY_FORM_FIELDS = Object.keys(ENQUIRY_FIELD_LABELS) as EnquiryFieldName[];

export function isEnquiryFieldName(value: string): value is EnquiryFieldName {
  return Object.hasOwn(ENQUIRY_FIELD_LABELS, value);
}
