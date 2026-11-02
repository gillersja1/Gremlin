export type Severity = 'high' | 'medium' | 'low';

export const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low'];

export type FindingKind =
  | 'html-injection'
  | 'server-error'
  | 'error-leak'
  | 'page-error'
  | 'console-error'
  | 'broken-link'
  | 'request-failed'
  | 'mixed-content'
  | 'insecure-cookie'
  | 'missing-header'
  | 'layout-overflow';

/** One thing the gremlin did, recorded so it can be replayed. */
export interface Step {
  kind: 'goto' | 'click' | 'fill' | 'check' | 'select' | 'press' | 'back';
  /** Page the step happened on. */
  url: string;
  /** CSS selector the step acted on, when it acted on an element. */
  selector?: string;
  /** How a person would describe the element, e.g. button "Save". */
  label?: string;
  value?: string;
}

export interface Finding {
  id: number;
  kind: FindingKind;
  severity: Severity;
  title: string;
  /** Specifics: the URL, the message, the header. */
  detail: string;
  url: string;
  /** The steps since the gremlin last navigated directly, ending with the one that surfaced this. */
  steps: Step[];
  screenshot?: string;
  /** How many times the same finding came up again. */
  seen: number;
}

export interface Options {
  startUrl: string;
  /** Hosts the gremlin may visit; anything else is skipped. */
  allow: string[];
  maxActions: number;
  maxMinutes: number;
  seed: number;
  /** Submit forms and press Enter in fields. Off by default: submitting can change data. */
  submitForms: boolean;
  /** Also click things labelled delete, pay, log out and so on. */
  unsafe: boolean;
  /** Use a phone-sized viewport. */
  mobile: boolean;
  headed: boolean;
  outDir: string;
  /** Exit with a failure if anything at or above this severity is found. */
  failOn: Severity | 'never';
}
