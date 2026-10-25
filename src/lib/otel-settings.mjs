// Consent and endpoint checks on the config's hot path: no I/O, encoder, HTTP or secrets imports.
export function otelEndpoint(value) {
  try {
    if (typeof value !== "string" || /[\s?#\\]/.test(value)) throw 0;
    const u = new URL(value), host = u.hostname.replace(/^\[|\]$/g, "");
    // URL canonicalises and validates IP literals first, including short IPv4 forms; this is never a DNS lookup.
    const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d+){3}$/.test(host);
    if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) || u.username || u.password || /\/\/[^/]*@/.test(value)) throw 0;
    return u.href.replace(/\/+$/, "");
  } catch { throw new Error("invalid OpenTelemetry endpoint: use https, or http on loopback, without userinfo, query or fragment"); }
}

export function otelSwitch(config, env = process.env) {
  let why = null, endpoint = null;
  if (String(env.OTEL_SDK_DISABLED).toLowerCase() === "true") why = "OTEL_SDK_DISABLED=true";
  else if (env.ROUTR_OTEL === "0") why = "ROUTR_OTEL=0";
  else if (!config?.otel?.endpoint) why = "no endpoint configured";
  else if (!/^[0-9a-f]{32}$/.test(config.otel.consent ?? "")) why = "missing or malformed consent";
  else try { endpoint = otelEndpoint(config.otel.endpoint); } catch { why = "invalid endpoint"; }
  return { on: !why, why_off: why, endpoint, consent: why ? null : config.otel.consent };
}
