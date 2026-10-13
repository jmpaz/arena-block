const sensitiveQuery = /(?:token|secret|password|authorization|signature|credential|api[_-]?key|^sig$|^key$|^policy$)/i;

/** Redact known credential forms without collecting environment values or raw shell arguments. */
export function redactProvenance<T>(input: T): { value: T; paths: string[] } {
  const paths = new Set<string>();
  const visit = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      let redacted = value.replace(/https?:\/\/[^\s<>"'`\)]+/giu, candidate => {
        try {
          const url = new URL(candidate); let changed = false;
          if (url.username || url.password) { url.username = ""; url.password = ""; changed = true; }
          for (const key of [...url.searchParams.keys()]) {
            if (sensitiveQuery.test(key)) { url.searchParams.set(key, "[REDACTED]"); changed = true; }
          }
          const fragment = new URLSearchParams(url.hash.slice(1)); let fragmentChanged = false;
          for (const key of [...fragment.keys()]) {
            if (sensitiveQuery.test(key)) { fragment.set(key, "[REDACTED]"); fragmentChanged = true; }
          }
          if (fragmentChanged) { url.hash = fragment.toString(); changed = true; }
          return changed ? url.toString() : candidate;
        } catch { return candidate; }
      });
      redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
        .replace(/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]")
        .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1=[REDACTED]")
        .replace(/(?:~|\/(?:Users|home)\/[^\s/]+)\/(?:\.ssh\/(?:id_[^\s]+)|\.aws\/credentials|\.config\/[^\s]+\/(?:credentials|tokens?)(?:\.json)?)(?=$|\s)/g, "[REDACTED_CREDENTIAL_PATH]");
      if (redacted !== value) paths.add(path);
      return redacted;
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}[${index}]`));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        const field = path ? `${path}.${key}` : key;
        Object.defineProperty(result, key, { value: visit(nested, field), enumerable: true });
      }
      return result;
    }
    return value;
  };
  return { value: visit(input, "") as T, paths: [...paths] };
}
