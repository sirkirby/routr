// Shared projection for strings a lead or harness can supply (anonymous telemetry and OpenTelemetry).
export const pick = (v, allowed) => (v == null ? null : allowed.includes(v) ? v : "other");
export const shaped = (re) => (v) => (v == null || v === "" ? null : re.test(String(v)) && !/[A-Za-z0-9]{17,}/.test(String(v)) ? String(v) : "other");
export const modelName = shaped(/^[A-Za-z0-9][A-Za-z0-9.:[\]-]{0,47}$/);
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto", "default"];
export const questionSet = shaped(/^[rc]\d{1,3}$/);
export const VERDICTS = Object.freeze(["done", "partial", "blocked", "unknown"]);
export const CHECK_RESULTS = Object.freeze(["pass", "fail", "none"]);
